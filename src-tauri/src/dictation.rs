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
    /// idle | starting | recording | finishing (final pass running)
    pub phase: &'static str,
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
    /// Milliseconds of audio dropped from the start because the session
    /// exceeded the buffer cap — its committed text is preserved in `text`.
    pub dropped_audio_ms: u64,
    /// Capture stream error recorded before stop, if any. The final
    /// transcript still covers whatever audio was captured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_error: Option<String>,
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
    /// model_id → download; presence means a download thread is alive
    /// (including winding down after cancel).
    downloads: HashMap<String, Download>,
    session: Option<Session>,
    /// Set while a worker starts up so two concurrent starts cannot both
    /// spawn — `session` only exists once the join handle does.
    starting: bool,
    /// The session's id and cancel flag while stop/cancel joins the worker —
    /// keeps the final pass abortable and blocks an overlapping start.
    finishing: Option<(u64, Arc<AtomicBool>)>,
}

struct Download {
    cancel: Arc<AtomicBool>,
    join: std::thread::JoinHandle<()>,
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

    /// Abort any live session and download on window teardown or exit. The
    /// webview is gone, so events no longer matter — workers are detached
    /// (join handles dropped) and exit on their own, dropping the engine and
    /// releasing the mic. Without this a destroyed window leaves capture
    /// running indefinitely.
    pub fn shutdown(&self) {
        let mut state = self.inner.lock().unwrap();
        if let Some(session) = state.session.take() {
            session.cancel.store(true, Ordering::Relaxed);
        }
        if let Some((_, cancel)) = state.finishing.take() {
            cancel.store(true, Ordering::Relaxed);
        }
        for (_, download) in state.downloads.drain() {
            download.cancel.store(true, Ordering::Relaxed);
        }
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

/// The model file exists at its expected size (checksum was verified when it
/// was installed — re-hashing on every check would be gratuitous IO).
fn installed_path(dir: &Path, spec: &ModelSpec) -> Option<PathBuf> {
    let path = download::final_path(dir, spec);
    path.metadata()
        .ok()
        .filter(|m| m.len() == spec.size_bytes)
        .map(|_| path)
}

/// Shared validation for the dictation paths that need a model on disk.
fn resolve_model(
    app: &AppHandle,
    model_id: &str,
    language: &Option<String>,
    translate: bool,
) -> Result<PathBuf, String> {
    if let Some(lang) = language.as_deref() {
        if !engine::valid_language(lang) {
            return Err(format!("Unknown dictation language \"{lang}\""));
        }
    }
    let spec = catalog::find(model_id).ok_or("Unknown dictation model")?;
    if translate && !spec.supports_translate {
        return Err(format!(
            "Model \"{}\" cannot translate to English — pick a translate-capable model",
            spec.label
        ));
    }
    installed_path(&models_dir(app)?, spec).ok_or_else(|| {
        format!(
            "Model \"{}\" is not installed — download it first",
            spec.label
        )
    })
}

fn model_info(dir: &Path, spec: &ModelSpec, state: &HostState) -> DictationModelInfo {
    let installed = installed_path(dir, spec).is_some();
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
    loop {
        let winding_down = {
            let mut state = host.inner.lock().unwrap();
            match state.downloads.get(spec.id) {
                Some(d) if !d.cancel.load(Ordering::Relaxed) => {
                    return Ok(()); // already running
                }
                // Cancelled but the thread is still inside its read loop —
                // join it before spawning a new writer for the same .part.
                Some(_) => state.downloads.remove(spec.id),
                None => {
                    if installed_path(&dir, spec).is_some() {
                        return Ok(());
                    }
                    None
                }
            }
        };
        let Some(download) = winding_down else { break };
        let _ = download.join.join();
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut state = host.inner.lock().unwrap();
        if state.downloads.contains_key(spec.id) || installed_path(&dir, spec).is_some() {
            return Ok(()); // another caller finished or restarted meanwhile
        }
        let thread_app = app.clone();
        let thread_host = host.inner.clone();
        let thread_id = spec.id.to_string();
        let thread_cancel = Arc::clone(&cancel);
        let join = std::thread::spawn(move || {
            download::download_model(&thread_app, spec, &dir, thread_cancel);
            thread_host.lock().unwrap().downloads.remove(&thread_id);
        });
        state
            .downloads
            .insert(spec.id.into(), Download { cancel, join });
    }
    Ok(())
}

#[tauri::command]
pub fn dictation_model_cancel_download(
    host: State<'_, DictationHost>,
    model_id: String,
) -> Result<(), String> {
    let state = host.inner.lock().unwrap();
    match state.downloads.get(&model_id) {
        // Keep the map entry until the thread exits so catalog/status still
        // show the download winding down and a fresh install can't race it.
        Some(download) => {
            download.cancel.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err("No download in progress for that model".into()),
    }
}

/// Reap a session whose worker already exited (stream error, panic) so a
/// stale entry cannot block later operations. Emits the session event the
/// worker itself could not send if it panicked.
fn reap_finished_session(state: &mut HostState, app: &AppHandle) {
    let stale = match state.session.as_ref() {
        Some(s) if s.join.is_finished() => state.session.take().unwrap(),
        _ => return,
    };
    if stale.join.join().is_err() {
        emit_session(
            app,
            stale.id,
            "error",
            Some("Dictation worker panicked".into()),
        );
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
        let mut state = host.inner.lock().unwrap();
        reap_finished_session(&mut state, &app);
        if state.downloads.contains_key(spec.id) {
            return Err("Cancel the download before removing this model".into());
        }
        if state.starting || state.finishing.is_some() {
            return Err("A dictation session is starting or finishing".into());
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
pub fn dictation_status(app: AppHandle, host: State<'_, DictationHost>) -> DictationStatus {
    // TCC can stall — never call the framework while holding the host lock.
    let mic_permission = capture::mic_permission();
    let mut state = host.inner.lock().unwrap();
    reap_finished_session(&mut state, &app);
    let active = state
        .session
        .as_ref()
        .is_some_and(|s| !s.join.is_finished());
    let phase = if active {
        "recording"
    } else if state.starting {
        "starting"
    } else if state.finishing.is_some() {
        "finishing"
    } else {
        "idle"
    };
    DictationStatus {
        mic_permission,
        phase,
        recording: active,
        session_id: state.session.as_ref().map(|s| s.id),
        model_id: state.session.as_ref().map(|s| s.model_id.clone()),
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
    let model_path = resolve_model(&app, &model_id, &language, translate)?;
    match capture::mic_permission() {
        MicPermission::Denied | MicPermission::Restricted => {
            return Err(
                "Microphone access is off — enable it in System Settings → Privacy & Security → Microphone"
                    .into(),
            )
        }
        MicPermission::NotDetermined => {
            // Sentinel the frontend matches to trigger the TCC prompt via
            // dictation_request_mic_permission, then retry.
            return Err("mic-permission-not-determined".into())
        }
        _ => {}
    }
    {
        let mut state = host.inner.lock().unwrap();
        reap_finished_session(&mut state, &app);
        if state.session.is_some() || state.starting || state.finishing.is_some() {
            return Err("A dictation session is already running".into());
        }
        state.starting = true;
    }

    let id = SESSION_SEQ.fetch_add(1, Ordering::Relaxed);
    let stop = Arc::new(AtomicBool::new(false));
    let cancel = Arc::new(AtomicBool::new(false));
    let buffer = AudioBuffer::shared();
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();

    let spawn = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let app = app.clone();
        let stop = Arc::clone(&stop);
        let cancel = Arc::clone(&cancel);
        let language = language.clone();
        std::thread::spawn(move || {
            // Capture is created on this thread so the cpal stream never
            // crosses threads; start errors come back through `tx`.
            let capture = match capture::start(Arc::clone(&buffer)) {
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
            run_session(&io, id, &model_path, language, translate, capture)
        })
    }));
    let join = match spawn {
        Ok(join) => join,
        Err(_) => {
            host.inner.lock().unwrap().starting = false;
            return Err("Cannot start the dictation worker".into());
        }
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
pub fn dictation_stop(
    app: AppHandle,
    host: State<'_, DictationHost>,
    session_id: u64,
) -> Result<DictationResult, String> {
    let session = {
        let mut state = host.inner.lock().unwrap();
        // A stop for a session that isn't current must not take over whatever
        // session replaced it — the caller's session is already gone.
        match state.session.as_ref() {
            Some(session) if session_id != session.id => {
                return Err("No dictation in progress".into());
            }
            _ => {}
        }
        let Some(session) = state.session.take() else {
            return Err("No dictation in progress".into());
        };
        session.stop.store(true, Ordering::Relaxed);
        // Keep the cancel flag reachable so the final pass can still abort,
        // and block a new session from overlapping this one.
        state.finishing = Some((session.id, Arc::clone(&session.cancel)));
        session
    };
    let id = session.id;
    let outcome = session.join.join();
    host.inner.lock().unwrap().finishing = None;
    match outcome {
        Ok(result) => result,
        Err(_) => {
            emit_session(&app, id, "error", Some("Dictation worker panicked".into()));
            Err("Dictation worker panicked".into())
        }
    }
}

#[tauri::command(async)]
pub fn dictation_cancel(
    app: AppHandle,
    host: State<'_, DictationHost>,
    session_id: Option<u64>,
) -> Result<(), String> {
    let session = {
        let mut state = host.inner.lock().unwrap();
        match state.session.as_ref() {
            Some(session) if session_id.is_some_and(|id| id != session.id) => {
                return Err("No dictation in progress".into());
            }
            _ => {}
        }
        match state.session.take() {
            Some(session) => {
                session.cancel.store(true, Ordering::Relaxed);
                state.finishing = Some((session.id, Arc::clone(&session.cancel)));
                session
            }
            None => {
                // Stop already took the session — abort its final pass.
                return match state.finishing.as_ref() {
                    Some((id, cancel)) if session_id.is_none_or(|wanted| wanted == *id) => {
                        cancel.store(true, Ordering::Relaxed);
                        Ok(())
                    }
                    Some(_) => Err("No dictation in progress".into()),
                    None if state.starting => Err("Dictation is starting — try again".into()),
                    None => Err("No dictation in progress".into()),
                };
            }
        }
    };
    let id = session.id;
    let outcome = session.join.join();
    host.inner.lock().unwrap().finishing = None;
    if outcome.is_err() {
        emit_session(&app, id, "error", Some("Dictation worker panicked".into()));
    }
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
    capture: capture::Capture,
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
        temperature_inc: 0.0,
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
        // Peek without cloning — `tail` would copy ~512 KB every 60 ms tick.
        let (end_abs, base, stream_error) = buffer.lock().unwrap().stats();
        if let Some(error) = stream_error {
            emit_session(app, session_id, "error", Some(error.clone()));
            return Err(error);
        }
        let enough_new = end_abs.saturating_sub(last_partial_end) >= PARTIAL_EVERY;
        let enough_total = end_abs.saturating_sub(base) >= MIN_PARTIAL_SAMPLES;
        if stop.load(Ordering::Relaxed) {
            break;
        }
        if enough_new && enough_total {
            last_partial_end = end_abs;
            let snapshot = buffer.lock().unwrap().tail(PARTIAL_WINDOW);
            // Abort a partial pass on stop too — it would otherwise finish
            // before the loop notices and delay the final pass by seconds.
            let abort = {
                let stop = Arc::clone(stop);
                let cancel = Arc::clone(cancel);
                move || stop.load(Ordering::Relaxed) || cancel.load(Ordering::Relaxed)
            };
            match engine.transcribe(&snapshot.samples, &opts, abort) {
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
                    if stop.load(Ordering::Relaxed) {
                        break; // the partial was aborted by stop, not a failure
                    }
                    emit_session(app, session_id, "error", Some(error.clone()));
                    return Err(error);
                }
            }
        }
        std::thread::sleep(TICK);
    }

    // Stop the stream before the big snapshot so nothing is pushing — and so
    // the lock isn't held while the copy contends with the RT callback.
    drop(capture);

    // Final pass over everything still buffered — replaces all partials.
    let snapshot = buffer.lock().unwrap().snapshot();
    let dropped_audio_ms = snapshot.base * 1000 / WHISPER_RATE as u64;
    let audio_ms = snapshot.end() * 1000 / WHISPER_RATE as u64;
    let stream_error = snapshot.error.clone();
    let final_opts = TranscribeOptions {
        language,
        translate,
        no_context: false,
        temperature_inc: 0.2,
    };
    let abort = {
        // `stop` is already set — the final pass must only abort on cancel.
        let cancel = Arc::clone(cancel);
        move || cancel.load(Ordering::Relaxed)
    };
    // `engine` drops on every return path → model memory released.
    match engine.transcribe(&snapshot.samples, &final_opts, abort) {
        Ok(transcript) => {
            // When the buffer cap dropped the session's head, that speech is
            // absent from the snapshot — recover it from the text committed
            // by partial passes. The seam can overlap by a few words.
            let text =
                if dropped_audio_ms > 0 && !committed.is_empty() && !transcript.text.is_empty() {
                    format!("{} {}", committed, transcript.text)
                } else if dropped_audio_ms > 0 && !committed.is_empty() {
                    committed
                } else {
                    transcript.text
                };
            emit_session(app, session_id, "finished", None);
            Ok(DictationResult {
                text,
                language: transcript.language,
                audio_ms,
                model_load_ms: load_ms,
                infer_ms: transcript.infer_ms,
                dropped_audio_ms,
                stream_error,
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
    let model_path = resolve_model(&app, &model_id, &language, translate)?;
    let samples = audio_file::read_wav_mono(std::path::Path::new(&path))?;
    let audio_ms = samples.len() as u64 * 1000 / WHISPER_RATE as u64;
    let (engine, load_ms) = Engine::load(&model_path)?;
    let cancel = Arc::new(AtomicBool::new(false));
    let opts = TranscribeOptions {
        language,
        translate,
        no_context: false,
        temperature_inc: 0.2,
    };
    let transcript = engine.transcribe(&samples, &opts, move || cancel.load(Ordering::Relaxed))?;
    Ok(FileTranscript {
        text: transcript.text,
        language: transcript.language,
        audio_ms,
        model_load_ms: load_ms,
        infer_ms: transcript.infer_ms,
        first_segment_ms: transcript.first_segment_ms,
    })
}
