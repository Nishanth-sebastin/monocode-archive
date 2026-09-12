//! whisper.cpp inference wrapper via whisper-rs.
//!
//! An `Engine` owns a loaded model (`WhisperContext`). Dropping it releases
//! model memory — the host drops the engine when a dictation session ends so
//! an idle app holds no model. Inference runs on the caller's thread; callers
//! are always dedicated worker threads, never the UI.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Debug, Clone)]
pub struct TranscribeOptions {
    /// ISO language code ("pl", "en"); `None`/`"auto"` = auto-detect.
    pub language: Option<String>,
    /// whisper's translate task: any supported language → English text.
    pub translate: bool,
    /// Let segments in this pass prompt later ones. Off for the overlapping
    /// partial windows (context bleeds repeated text); on for the final pass.
    pub no_context: bool,
}

#[derive(Debug, Clone)]
pub struct Segment {
    /// Segment start/end within the passed audio, milliseconds.
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug)]
pub struct Transcript {
    pub text: String,
    pub segments: Vec<Segment>,
    /// Detected language code when auto-detection ran.
    pub language: Option<String>,
    /// Wall time of the whisper pass.
    pub infer_ms: u64,
    /// Time until the first segment was decoded, when any.
    pub first_segment_ms: Option<u64>,
}

pub struct Engine {
    ctx: WhisperContext,
}

impl Engine {
    /// Load a GGML model. Returns the engine and wall-clock load time.
    pub fn load(model_path: &Path) -> Result<(Self, u64), String> {
        let started = Instant::now();
        let mut params = WhisperContextParameters::default();
        params.use_gpu(true);
        params.flash_attn(true);
        let ctx = WhisperContext::new_with_params(model_path, params).map_err(|error| {
            format!(
                "Cannot load dictation model {}: {error}",
                model_path.display()
            )
        })?;
        if !ctx.is_multilingual() {
            return Err("Dictation model is not multilingual".into());
        }
        let load_ms = started.elapsed().as_millis() as u64;
        Ok((Self { ctx }, load_ms))
    }

    /// Run one transcription pass over 16 kHz mono f32 audio. `cancel` aborts
    /// the pass at the next decoding step (checked via whisper's abort hook).
    pub fn transcribe(
        &self,
        samples: &[f32],
        opts: &TranscribeOptions,
        cancel: &Arc<AtomicBool>,
    ) -> Result<Transcript, String> {
        if samples.is_empty() {
            return Ok(Transcript {
                text: String::new(),
                segments: Vec::new(),
                language: None,
                infer_ms: 0,
                first_segment_ms: None,
            });
        }
        let mut state = self
            .ctx
            .create_state()
            .map_err(|error| format!("Cannot start transcription: {error}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        match opts
            .language
            .as_deref()
            .filter(|lang| !lang.is_empty() && *lang != "auto")
        {
            Some(language) => {
                if whisper_rs::get_lang_id(language).is_none() {
                    return Err(format!("Unknown dictation language \"{language}\""));
                }
                params.set_language(Some(language));
            }
            // `set_detect_language(true)` would only detect and return without
            // transcribing — a null language triggers detect-then-transcribe.
            None => params.set_language(None),
        }
        params.set_translate(opts.translate);
        params.set_no_context(opts.no_context);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_special(false);
        params.set_print_timestamps(false);
        params.set_suppress_nst(true);
        let cancel_flag = Arc::clone(cancel);
        // The `Into<Option<F>>` bound needs both generic parameters spelled
        // out; a bare `Some(closure)` leaves `F` ambiguous.
        params
            .set_abort_callback_safe::<Option<Box<dyn FnMut() -> bool>>, Box<dyn FnMut() -> bool>>(
                Some(Box::new(move || cancel_flag.load(Ordering::Relaxed))),
            );
        let started = Instant::now();
        let first_segment = Arc::new(Mutex::new(None::<u64>));
        let first_segment_sink = Arc::clone(&first_segment);
        params.set_segment_callback_safe::<
            Option<Box<dyn FnMut(whisper_rs::SegmentCallbackData)>>,
            Box<dyn FnMut(whisper_rs::SegmentCallbackData)>,
        >(Some(Box::new(move |_segment| {
            let mut guard = first_segment_sink.lock().unwrap();
            if guard.is_none() {
                *guard = Some(started.elapsed().as_millis() as u64);
            }
        })));
        state
            .full(params, samples)
            .map_err(|error| format!("Transcription failed: {error}"))?;
        let infer_ms = started.elapsed().as_millis() as u64;
        let mut segments = Vec::new();
        for segment in state.as_iter() {
            segments.push(Segment {
                // whisper reports segment times in centiseconds.
                start_ms: segment.start_timestamp() * 10,
                end_ms: segment.end_timestamp() * 10,
                text: segment.to_str_lossy().unwrap_or_default().into_owned(),
            });
        }
        let lang_id = state.full_lang_id_from_state();
        let language = (lang_id >= 0)
            .then(|| whisper_rs::get_lang_str(lang_id))
            .flatten()
            .map(str::to_string)
            .filter(|lang| !lang.is_empty());
        let text = join_segments(&segments);
        let first_segment_ms = *first_segment.lock().unwrap();
        Ok(Transcript {
            text,
            segments,
            language,
            infer_ms,
            first_segment_ms,
        })
    }
}

pub fn join_segments(segments: &[Segment]) -> String {
    segments
        .iter()
        .map(|segment| segment.text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Validate a language option coming over IPC before a session starts.
pub fn valid_language(language: &str) -> bool {
    language == "auto" || whisper_rs::get_lang_id(language).is_some()
}
