//! Dev measurement entry point for local dictation (issue #77 groundwork).
//! Not part of the app — exercises the same engine/dictation code paths from
//! a file instead of the mic.
//!
//!   cargo run --release --bin dictation-bench -- \
//!     --model /path/to/ggml-small.bin --wav sample.wav [--lang pl] [--translate] [--runs 3]

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use monocode_lib::dictation::audio_file::read_wav_mono;
use monocode_lib::dictation::engine::{Engine, TranscribeOptions};

fn main() {
    let mut model: Option<PathBuf> = None;
    let mut wav: Option<PathBuf> = None;
    let mut lang: Option<String> = None;
    let mut translate = false;
    let mut runs = 1usize;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--model" => model = args.next().map(PathBuf::from),
            "--wav" => wav = args.next().map(PathBuf::from),
            "--lang" => lang = args.next(),
            "--translate" => translate = true,
            "--runs" => {
                runs = args
                    .next()
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(1)
                    .max(1)
            }
            other => {
                eprintln!("unknown arg {other}");
                std::process::exit(2);
            }
        }
    }
    let (Some(model), Some(wav)) = (model, wav) else {
        eprintln!("usage: dictation-bench --model <ggml.bin> --wav <file.wav> [--lang pl] [--translate] [--runs N]");
        std::process::exit(2);
    };

    println!("rss_idle\t{} MB", rss_mb());
    let samples = match read_wav_mono(&wav) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    println!("audio_ms\t{}", samples.len() * 1000 / 16000);

    let (engine, load_ms) = match Engine::load(&model) {
        Ok(ok) => ok,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    println!("load_ms\t{load_ms}");
    println!("rss_loaded\t{} MB", rss_mb());

    let cancel = Arc::new(AtomicBool::new(false));
    let opts = TranscribeOptions {
        language: lang,
        translate,
        no_context: false,
        temperature_inc: 0.2,
    };
    for run in 1..=runs {
        match engine.transcribe(&samples, &opts, {
            let cancel = Arc::clone(&cancel);
            move || cancel.load(std::sync::atomic::Ordering::Relaxed)
        }) {
            Ok(tr) => println!(
                "run{run}\tinfer_ms={} first_segment_ms={:?} lang={:?} rss={} MB\ntext={:?}",
                tr.infer_ms,
                tr.first_segment_ms,
                tr.language,
                rss_mb(),
                tr.text
            ),
            Err(e) => {
                eprintln!("run{run} failed: {e}");
                std::process::exit(1);
            }
        }
    }
    drop(engine);
    // Give the allocator a beat to return pages.
    std::thread::sleep(std::time::Duration::from_millis(200));
    println!("rss_after_drop\t{} MB", rss_mb());
}

#[cfg(target_os = "macos")]
fn rss_mb() -> u64 {
    use mach2::task::task_info;
    use mach2::task_info::{
        task_basic_info_64, task_info_t, TASK_BASIC_INFO_64, TASK_BASIC_INFO_64_COUNT,
    };
    use mach2::traps::mach_task_self;
    unsafe {
        let mut info: task_basic_info_64 = std::mem::zeroed();
        let mut count = TASK_BASIC_INFO_64_COUNT;
        let kr = task_info(
            mach_task_self(),
            TASK_BASIC_INFO_64,
            &mut info as *mut _ as task_info_t,
            &mut count,
        );
        if kr == 0 {
            info.resident_size / 1024 / 1024
        } else {
            0
        }
    }
}

#[cfg(target_os = "linux")]
fn rss_mb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse::<u64>().ok())
        })
        .map(|kb| kb / 1024)
        .unwrap_or(0)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rss_mb() -> u64 {
    0
}
