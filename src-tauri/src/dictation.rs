//! Local multilingual dictation — engine, capture and model management.
//!
//! All audio and transcripts stay on the machine. Models are pinned,
//! checksummed whisper.cpp GGML files downloaded on demand to app data.
//! Capture (cpal) and inference (whisper-rs) run on dedicated threads; the
//! composer seam is a later slice — `dictation_transcribe_file` is the test
//! entry point until then.

pub mod audio_file;
pub mod capture;
pub mod catalog;
mod download;
pub mod engine;
pub mod resample;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use capture::{AudioBuffer, MicPermission};
use catalog::ModelSpec;
use engine::{join_segments, Engine, TranscribeOptions};
use resample::WHISPER_RATE;

const PARTIAL_EVENT: &str = "dictation:partial";
const SESSION_EVENT: &str = "dictation:session";

/// Seconds of trailing audio each partial pass re-transcribes.
const PARTIAL_WINDOW_S: usize = 8;
/// A segment becomes committed once it ends this far inside the window —
/// whisper may still revise the most recent speech.
const COMMIT_MARGIN_MS: i64 = 400;
/// Worker poll cadence; cheap relative to an inference pass.
const TICK: std::time::Duration = std::time::Duration::from_millis(60);

const PARTIAL_WINDOW: usize = PARTIAL_WINDOW_S * WHISPER_RATE as usize;
/// ~1.5 s of new audio between partial passes.
const PARTIAL_EVERY: u64 = WHISPER_RATE as u64 * 3 / 2;
const MIN_PARTIAL_SAMPLES: u64 = WHISPER_RATE as u64 / 2;

// ── IPC types ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationModelInfo {
    pub id: String,
    pub label: String,
    pub tier: String,
    pub size_bytes: u64,
    pub installed: bool,
    /// Bytes of a resumable `.part` download on disk.
    pub partial_bytes: u64,
    pub downloading: bool,
    /// Whether this model performs the translate-to-English task.
    pub supports_translate: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    pub mic_permission: MicPermission,
    pub recording: bool,
    pub session_id: Option<u64>,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationStarted {
    pub session_id: u64,
    pub device_name: String,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationResult {
    pub text: String,
    pub language: Option<String>,
    pub audio_ms: u64,
    pub model_load_ms: u64,
    pub infer_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTranscript {
    pub text: String,
    pub language: Option<String>,
    pub audio_ms: u64,
    pub model_load_ms: u64,
    pub infer_ms: u64,
    pub first_segment_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PartialEvent {
    session_id: u64,
    seq: u64,
    /// All committed text so far — replaces the draft's committed portion.
    committed: String,
    /// Provisional text for the trailing window; the next partial or the
    /// final result replaces it.
    partial: String,
    audio_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionEvent {
    session_id: u64,
    /// recording | finished | cancelled | error
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

// ── Host state ──────────────────────────────────────────────────────────────

#[derive(Clone, Default)]
pub struct DictationHost {
    inner: Arc<Mutex<HostState>>,
}

#[derive(Default)]
struct HostState {
    /// model_id → cancel flag; presence means a download is running.
    downloads: HashMap<String, Arc<AtomicBool>>,
    session: Option<Session>,
    /// Set while a worker starts up so two concurrent starts cannot both
    /// spawn — `session` only exists once the join handle does.
    starting: bool,
}

struct Session {
    id: u64,
    model_id: String,
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    join: std::thread::JoinHandle<Result<DictationResult, String>>,
}

impl DictationHost {
    pub fn new() -> Self {
        Self::default()
    }
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Cannot locate app data: {e}"))?
        .join("dictation")
        .join("models"))
}

static SESSION_SEQ: AtomicU64 = AtomicU64::new(1);

fn emit_session(app: &AppHandle, session_id: u64, state: &'static str, error: Option<String>) {
    let _ = app.emit(
        SESSION_EVENT,
        SessionEvent {
            session_id,
            state,
            error,
        },
    );
}

// ── Model commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub fn dictation_catalog(
    app: AppHandle,
    host: State<'_, DictationHost>,
) -> Result<Vec<DictationModelInfo>, String> {
    let dir = models_dir(&app)?;
    let state = host.inner.lock().unwrap();
    Ok(catalog::MODELS
        .iter()
        .map(|spec| model_info(&dir, spec, &state))
        .collect())
}

fn model_info(dir: &Path, spec: &ModelSpec, state: &HostState) -> DictationModelInfo {
    let installed = download::final_path(dir, spec)
        .metadata()
        .map(|m| m.len() == spec.size_bytes)
        .unwrap_or(false);
    let partial_bytes = download::part_path(dir, spec)
        .metadata()
        .map(|m| m.len())
        .unwrap_or(0);
    DictationModelInfo {
        id: spec.id.into(),
        label: spec.label.into(),
        tier: spec.tier.into(),
        size_bytes: spec.size_bytes,
        installed,
        partial_bytes,
        downloading: state.downloads.contains_key(spec.id),
        supports_translate: spec.supports_translate,
    }
}

#[tauri::command]
pub fn dictation_model_install(
    app: AppHandle,
    host: State<'_, DictationHost>,
    model_id: String,
) -> Result<(), String> {
    let spec = catalog::find(&model_id).ok_or("Unknown dictation model")?;
    let dir = models_dir(&app)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut state = host.inner.lock().unwrap();
        if state.downloads.contains_key(spec.id) {
            return Ok(()); // already running
        }
        let installed = download::final_path(&dir, spec)
            .metadata()
            .map(|m| m.len() == spec.size_bytes)
            .unwrap_or(false);
        if installed {
            return Ok(());
        }
        state.downloads.insert(spec.id.into(), Arc::clone(&cancel));
    }
    let thread_app = app.clone();
    let thread_host = host.inner.clone();
    let thread_id = spec.id.to_string();
    std::thread::spawn(move || {
        download::download_model(&thread_app, spec, &dir, cancel);
        thread_host.lock().unwrap().downloads.remove(&thread_id);
    });
    Ok(())
}

#[tauri::command]
pub fn dictation_model_cancel_download(
    host: State<'_, DictationHost>,
    model_id: String,
) -> Result<(), String> {
    let mut state = host.inner.lock().unwrap();
    match state.downloads.remove(&model_id) {
        Some(cancel) => {
            cancel.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err("No download in progress for that model".into()),
    }
}

#[tauri::command]
pub fn dictation_model_remove(
    app: AppHandle,
    host: State<'_, DictationHost>,
    model_id: String,
) -> Result<(), String> {
    let spec = catalog::find(&model_id).ok_or("Unknown dictation model")?;
    {
        let state = host.inner.lock().unwrap();
        if state.downloads.contains_key(spec.id) {
            return Err("Cancel the download before removing this model".into());
        }
        if state.session.as_ref().map(|s| s.model_id.as_str()) == Some(spec.id) {
            return Err("Model is in use by an active dictation".into());
        }
    }
    let dir = models_dir(&app)?;
    let _ = std::fs::remove_file(download::part_path(&dir, spec));
    match std::fs::remove_file(download::final_path(&dir, spec)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result.map_err(|e| format!("Cannot remove model: {e}")),
    }
}

// ── Permission / status commands ────────────────────────────────────────────

#[tauri::command]
pub fn dictation_status(host: State<'_, DictationHost>) -> DictationStatus {
    let state = host.inner.lock().unwrap();
    let active = state
        .session
        .as_ref()
        .is_some_and(|s| !s.join.is_finished());
    DictationStatus {
        mic_permission: capture::mic_permission(),
        recording: active,
        session_id: active.then(|| state.session.as_ref().unwrap().id),
        model_id: active.then(|| state.session.as_ref().unwrap().model_id.clone()),
    }
}

/// Show the system prompt when undetermined; returns the resulting state.
#[tauri::command(async)]
pub fn dictation_request_mic_permission() -> MicPermission {
    capture::request_mic_permission()
}

/// Open the OS settings page for mic access (macOS); no-op elsewhere.
#[tauri::command]
pub fn dictation_open_mic_settings() {
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn();
    }
}

// ── Dictation session commands ──────────────────────────────────────────────

#[tauri::command(async)]
pub fn dictation_start(
    app: AppHandle,
    host: State<'_, DictationHost>,
    model_id: String,
    language: Option<String>,
    translate: bool,
) -> Result<DictationStarted, String> {
    if let Some(lang) = language.as_deref() {
        if !engine::valid_language(lang) {
            return Err(format!("Unknown dictation language \"{lang}\""));
        }
    }
    let spec = catalog::find(&model_id).ok_or("Unknown dictation model")?;
    if translate && !spec.supports_translate {
        return Err(format!(
            "Model \"{}\" cannot translate to English — pick a translate-capable model",
            spec.label
        ));
    }
    let model_path = {
        let dir = models_dir(&app)?;
        let path = download::final_path(&dir, spec);
        if !path.exists() {
            return Err(format!(
                "Model \"{}\" is not installed — download it first",
                spec.label
            ));
        }
        path
    };
    match capture::mic_permission() {
        MicPermission::Denied | MicPermission::Restricted => {
            return Err(
                "Microphone access is off — enable it in System Settings → Privacy & Security → Microphone"
                    .into(),
            )
        }
        MicPermission::NotDetermined => {
            return Err("mic-permission-not-determined".into())
        }
        _ => {}
    }
    {
        let mut state = host.inner.lock().unwrap();
        // Reap a worker that already exited (stream error, panic) so a stale
        // entry cannot block the next start.
        if let Some(session) = state.session.as_ref() {
            if session.join.is_finished() {
                let stale = state.session.take().unwrap();
                let _ = stale.join.join();
            }
        }
        if state.session.is_some() || state.starting {
            return Err("A dictation session is already running".into());
        }
        state.starting = true;
    }

    let id = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));
    let buffer = AudioBuffer::shared();
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();

    let join = {
        let app = app.clone();
        let stop = Arc::clone(&stop);
        let cancel = Arc::clone(&cancel);
        let language = language.clone();
        std::thread::spawn(move || {
            // Capture is created on this thread so the cpal stream never
            // crosses threads; start errors come back through `tx`.
            let _capture = match capture::start(Arc::clone(&buffer)) {
                Ok(capture) => {
                    let _ = tx.send(Ok(capture.device_name().to_string()));
                    capture
                }
                Err(error) => {
                    let _ = tx.send(Err(error));
                    return Err("capture failed".into());
                }
            };
            let io = SessionIo {
                app: &app,
                buffer: &buffer,
                stop: &stop,
                cancel: &cancel,
            };
            run_session(&io, id, &model_path, language, translate)
        })
    };

    let outcome = rx.recv();
    let mut state = host.inner.lock().unwrap();
    state.starting = false;
    match outcome {
        Ok(Ok(device_name)) => {
            state.session = Some(Session {
                id,
                model_id: model_id.clone(),
                stop,
                cancel,
                join,
            });
            Ok(DictationStarted {
                session_id: id,
                device_name,
                model_id,
            })
        }
        Ok(Err(error)) => {
            let _ = join.join();
            Err(error)
        }
        Err(_) => {
            let _ = join.join();
            Err("Dictation worker exited before starting".into())
        }
    }
}

#[tauri::command(async)]
pub fn dictation_stop(host: State<'_, DictationHost>) -> Result<DictationResult, String> {
    let session = host.inner.lock().unwrap().session.take();
    let Some(session) = session else {
        return Err("No dictation in progress".into());
    };
    session.stop.store(true, Ordering::Relaxed);
    session
        .join
        .join()
        .map_err(|_| "Dictation worker panicked".to_string())?
}

#[tauri::command]
pub fn dictation_cancel(host: State<'_, DictationHost>) -> Result<(), String> {
    let session = host.inner.lock().unwrap().session.take();
    let Some(session) = session else {
        return Err("No dictation in progress".into());
    };
    session.cancel.store(true, Ordering::Relaxed);
    let _ = session.join.join();
    Ok(())
}

// ── Session worker ──────────────────────────────────────────────────────────

/// Shared session plumbing handed to the worker thread.
struct SessionIo<'a> {
    app: &'a AppHandle,
    buffer: &'a Arc<Mutex<AudioBuffer>>,
    stop: &'a Arc<AtomicBool>,
    cancel: &'a Arc<AtomicBool>,
}

fn run_session(
    io: &SessionIo<'_>,
    session_id: u64,
    model_path: &Path,
    language: Option<String>,
    translate: bool,
) -> Result<DictationResult, String> {
    let SessionIo {
        app,
        buffer,
        stop,
        cancel,
    } = *io;
    let (engine, load_ms) = match Engine::load(model_path) {
        Ok(ok) => ok,
        Err(error) => {
            emit_session(app, session_id, "error", Some(error.clone()));
            return Err(error);
        }
    };
    emit_session(app, session_id, "recording", None);

    let opts = TranscribeOptions {
        language: language.clone(),
        translate,
        no_context: true,
    };
    let mut committed = String::new();
    let mut committed_end_ms: i64 = 0;
    let mut last_partial_end: u64 = 0;
    let mut seq = 0u64;

    loop {
        if cancel.load(Ordering::Relaxed) {
            emit_session(app, session_id, "cancelled", None);
            // `engine` drops here → model memory released.
            return Err("cancelled".into());
        }
        let snapshot = buffer.lock().unwrap().tail(PARTIAL_WINDOW);
        if let Some(error) = snapshot.error.clone() {
            emit_session(app, session_id, "error", Some(error.clone()));
            return Err(error);
        }
        let end_abs = snapshot.end();
        let enough_new = end_abs.saturating_sub(last_partial_end) >= PARTIAL_EVERY;
        let enough_total = end_abs.saturating_sub(snapshot.base) >= MIN_PARTIAL_SAMPLES;
        if stop.load(Ordering::Relaxed) {
            break;
        }
        if enough_new && enough_total {
            last_partial_end = end_abs;
            match engine.transcribe(&snapshot.samples, &opts, cancel) {
                Ok(transcript) => {
                    let window_start_ms = (snapshot.base * 1000 / WHISPER_RATE as u64) as i64;
                    let now_ms = (end_abs * 1000 / WHISPER_RATE as u64) as i64;
                    let mut partial = Vec::new();
                    for seg in &transcript.segments {
                        let seg_start = window_start_ms + seg.start_ms;
                        let seg_end = window_start_ms + seg.end_ms;
                        if seg_end <= committed_end_ms {
                            // Already committed — don't echo it in the partial.
                            continue;
                        }
                        // Commit only whole segments that start after the last
                        // commit — overlapping boundaries get re-decoded by a
                        // later window instead of duplicated.
                        if seg_end <= now_ms - COMMIT_MARGIN_MS && seg_start >= committed_end_ms {
                            let text = seg.text.trim();
                            if !text.is_empty() {
                                if !committed.is_empty() {
                                    committed.push(' ');
                                }
                                committed.push_str(text);
                            }
                            committed_end_ms = seg_end;
                        } else {
                            partial.push(seg.clone());
                        }
                    }
                    seq += 1;
                    let _ = app.emit(
                        PARTIAL_EVENT,
                        PartialEvent {
                            session_id,
                            seq,
                            committed: committed.clone(),
                            partial: join_segments(&partial),
                            audio_ms: now_ms as u64,
                        },
                    );
                }
                Err(error) => {
                    if cancel.load(Ordering::Relaxed) {
                        emit_session(app, session_id, "cancelled", None);
                        return Err("cancelled".into());
                    }
                    emit_session(app, session_id, "error", Some(error.clone()));
                    return Err(error);
                }
            }
        }
        std::thread::sleep(TICK);
    }

    // Final pass over everything captured — replaces all partials.
    let snapshot = buffer.lock().unwrap().snapshot();
    let audio_ms = snapshot.end() * 1000 / WHISPER_RATE as u64;
    let final_opts = TranscribeOptions {
        language,
        translate,
        no_context: false,
    };
    // `engine` drops on every return path → model memory released.
    match engine.transcribe(&snapshot.samples, &final_opts, cancel) {
        Ok(transcript) => {
            emit_session(app, session_id, "finished", None);
            Ok(DictationResult {
                text: transcript.text,
                language: transcript.language,
                audio_ms,
                model_load_ms: load_ms,
                infer_ms: transcript.infer_ms,
            })
        }
        Err(error) => {
            if cancel.load(Ordering::Relaxed) {
                emit_session(app, session_id, "cancelled", None);
                return Err("cancelled".into());
            }
            emit_session(app, session_id, "error", Some(error.clone()));
            Err(error)
        }
    }
}

// ── Diagnostics: transcribe a file without the mic ─────────────────────────

/// Test entry point: transcribe/translate a WAV file through the same engine
/// the session worker uses. Not wired to the composer.
#[tauri::command(async)]
pub fn dictation_transcribe_file(
    app: AppHandle,
    path: String,
    model_id: String,
    language: Option<String>,
    translate: bool,
) -> Result<FileTranscript, String> {
    if let Some(lang) = language.as_deref() {
        if !engine::valid_language(lang) {
            return Err(format!("Unknown dictation language \"{lang}\""));
        }
    }
    let spec = catalog::find(&model_id).ok_or("Unknown dictation model")?;
    if translate && !spec.supports_translate {
        return Err(format!(
            "Model \"{}\" cannot translate to English — pick a translate-capable model",
            spec.label
        ));
    }
    let model_path = download::final_path(&models_dir(&app)?, spec);
    if !model_path.exists() {
        return Err(format!("Model \"{}\" is not installed", spec.label));
    }
    let samples = audio_file::read_wav_mono(std::path::Path::new(&path))?;
    let audio_ms = samples.len() as u64 * 1000 / WHISPER_RATE as u64;
    let (engine, load_ms) = Engine::load(&model_path)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let opts = TranscribeOptions {
        language,
        translate,
        no_context: false,
    };
    let transcript = engine.transcribe(&samples, &opts, &cancel)?;
    Ok(FileTranscript {
        text: transcript.text,
        language: transcript.language,
        audio_ms,
        model_load_ms: load_ms,
        infer_ms: transcript.infer_ms,
        first_segment_ms: transcript.first_segment_ms,
    })
}
