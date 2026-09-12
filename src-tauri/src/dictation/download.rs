//! Model downloads: pinned URL → `.part` file → sha256 check → rename.
//! Runs on a background thread; progress goes to the frontend over
//! `dictation:model-progress`. Interrupted downloads keep the `.part` file
//! and resume with a `Range` request on the next install call.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use super::catalog::ModelSpec;

pub const PROGRESS_EVENT: &str = "dictation:model-progress";

const CHUNK: usize = 256 * 1024;
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const USER_AGENT: &str = "MonoCode";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub model_id: String,
    /// downloading | verifying | done | cancelled | failed
    pub phase: &'static str,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DownloadProgress {
    fn emit(app: &AppHandle, progress: &DownloadProgress) {
        let _ = app.emit(PROGRESS_EVENT, progress);
    }
}

pub fn part_path(dir: &Path, spec: &ModelSpec) -> PathBuf {
    dir.join(format!("{}.part", spec.file))
}

pub fn final_path(dir: &Path, spec: &ModelSpec) -> PathBuf {
    dir.join(spec.file)
}

/// Download `spec` into `dir`, resuming any `.part` file. Blocking — run on a
/// worker thread. Emits progress events throughout.
pub fn download_model(
    app: &AppHandle,
    spec: &'static ModelSpec,
    dir: &Path,
    cancel: Arc<AtomicBool>,
) {
    match download_from(&spec.url(), spec, dir, &cancel, Some(app)) {
        Ok(()) => DownloadProgress::emit(
            app,
            &DownloadProgress {
                model_id: spec.id.into(),
                phase: "done",
                downloaded_bytes: spec.size_bytes,
                total_bytes: spec.size_bytes,
                error: None,
            },
        ),
        Err(error) => {
            let cancelled = cancel.load(Ordering::Relaxed) || error.0 == CANCELLED;
            DownloadProgress::emit(
                app,
                &DownloadProgress {
                    model_id: spec.id.into(),
                    phase: if cancelled { "cancelled" } else { "failed" },
                    downloaded_bytes: 0,
                    total_bytes: spec.size_bytes,
                    error: (!cancelled).then(|| error.0.clone()),
                },
            );
        }
    }
}

const CANCELLED: &str = "cancelled";

#[derive(Debug)]
struct DownloadError(String);

impl From<String> for DownloadError {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for DownloadError {
    fn from(value: &str) -> Self {
        Self(value.into())
    }
}

fn download_from(
    url: &str,
    spec: &'static ModelSpec,
    dir: &Path,
    cancel: &AtomicBool,
    app: Option<&AppHandle>,
) -> Result<(), DownloadError> {
    std::fs::create_dir_all(dir).map_err(|e| format!("Cannot create model directory: {e}"))?;
    let part = part_path(dir, spec);
    let final_path = final_path(dir, spec);

    let mut downloaded = part.metadata().map(|m| m.len()).unwrap_or(0);
    if downloaded > spec.size_bytes {
        // Stale or oversized partial — start over.
        let _ = std::fs::remove_file(&part);
        downloaded = 0;
    }

    let mut request = ureq::AgentBuilder::new()
        .timeout(HTTP_TIMEOUT)
        .build()
        .get(url)
        .set("User-Agent", USER_AGENT);
    if downloaded > 0 {
        request = request.set("Range", &format!("bytes={downloaded}-"));
    }
    let response = match request.call() {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => {
            return Err(format!("Model download failed (HTTP {status})").into())
        }
        Err(error) => return Err(format!("Model download failed: {error}").into()),
    };

    // A 200 to a Range request means the server ignored resumption — restart.
    if downloaded > 0 && response.status() == 200 {
        downloaded = 0;
    }
    let total = response
        .header("Content-Length")
        .and_then(|v| v.parse::<u64>().ok())
        .map(|len| len + downloaded)
        .unwrap_or(spec.size_bytes);

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(downloaded == 0)
        .append(downloaded > 0)
        .open(&part)
        .map_err(|e| format!("Cannot write model file: {e}"))?;

    let mut reader = response.into_reader();
    let mut hasher = Sha256::new();
    if downloaded > 0 {
        // Hash the resumed prefix so the final digest covers the whole file.
        hash_prefix(&part, downloaded, &mut hasher)?;
    }
    let mut last_emit = Instant::now() - PROGRESS_INTERVAL;
    let mut buf = vec![0u8; CHUNK];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(DownloadError(CANCELLED.into()));
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("Model download interrupted: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .map_err(|e| format!("Cannot write model file: {e}"))?;
        hasher.update(&buf[..n]);
        downloaded += n as u64;
        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            if let Some(app) = app {
                DownloadProgress::emit(
                    app,
                    &DownloadProgress {
                        model_id: spec.id.into(),
                        phase: "downloading",
                        downloaded_bytes: downloaded,
                        total_bytes: total,
                        error: None,
                    },
                );
            }
        }
    }
    file.flush().ok();
    drop(file);

    if downloaded != spec.size_bytes {
        return Err(format!(
            "Model download truncated ({downloaded} of {} bytes)",
            spec.size_bytes
        )
        .into());
    }

    let digest = format!("{:x}", hasher.finalize());
    if digest != spec.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err("Model checksum mismatch — download deleted".into());
    }
    std::fs::rename(&part, &final_path).map_err(|e| format!("Cannot store model: {e}"))?;
    Ok(())
}

fn hash_prefix(path: &Path, bytes: u64, hasher: &mut Sha256) -> Result<(), DownloadError> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Cannot read partial download: {e}"))?;
    let mut remaining = bytes;
    let mut buf = vec![0u8; CHUNK];
    while remaining > 0 {
        let want = remaining.min(buf.len() as u64) as usize;
        let n = file
            .read(&mut buf[..want])
            .map_err(|e| format!("Cannot read partial download: {e}"))?;
        if n == 0 {
            return Err("Partial download is truncated".into());
        }
        hasher.update(&buf[..n]);
        remaining -= n as u64;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::sync::Mutex;

    /// Minimal HTTP/1.1 file server with Range support for download tests.
    struct TestServer {
        base: String,
        body: Vec<u8>,
        requests: Arc<Mutex<Vec<String>>>,
        join: Option<std::thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn serve(body: Vec<u8>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let requests_thread = Arc::clone(&requests);
            let serve_body = body.clone();
            let join = std::thread::spawn(move || {
                let body = serve_body;
                while let Ok((mut stream, _)) = listener.accept() {
                    let mut buf = [0u8; 4096];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]).to_string();
                    requests_thread.lock().unwrap().push(request.clone());
                    let range = request
                        .lines()
                        .find_map(|l| l.strip_prefix("Range: bytes=").map(str::to_string))
                        .and_then(|v| v.trim_end_matches('-').parse::<usize>().ok());
                    match range {
                        Some(start) if start < body.len() => {
                            let tail = &body[start..];
                            let head = format!(
                                "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                tail.len()
                            );
                            let _ = stream.write_all(head.as_bytes());
                            let _ = stream.write_all(tail);
                        }
                        _ => {
                            let head = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = stream.write_all(head.as_bytes());
                            let _ = stream.write_all(&body);
                        }
                    }
                }
            });
            Self {
                base: format!("http://127.0.0.1:{port}"),
                body,
                requests,
                join: Some(join),
            }
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            // The accept loop ends with the test process; joining would block
            // forever on a listener that never stops accepting.
            let _ = self.join.take();
        }
    }

    fn spec_for(server: &TestServer) -> &'static ModelSpec {
        let sha256 = format!("{:x}", Sha256::digest(&server.body));
        // Leak is fine in tests: specs are 'static by design.
        Box::leak(Box::new(ModelSpec {
            id: "test",
            file: "test-model.bin",
            label: "Test",
            tier: "fast",
            size_bytes: server.body.len() as u64,
            sha256: Box::leak(sha256.into_boxed_str()),
            supports_translate: true,
        }))
    }

    fn download_test_model(
        server_url: &str,
        spec: &'static ModelSpec,
        dir: &Path,
        cancel: &AtomicBool,
    ) -> Result<(), String> {
        download_from(server_url, spec, dir, cancel, None).map_err(|e| e.0)
    }

    #[test]
    fn fresh_download_verifies_and_renames() {
        let body = vec![7u8; 300_000];
        let server = TestServer::serve(body);
        let spec: &'static ModelSpec = spec_for(&server);
        let dir = tempfile_dir();
        let cancel = AtomicBool::new(false);
        download_test_model(
            &format!("{}/ggml-test.bin", server.base),
            spec,
            &dir,
            &cancel,
        )
        .unwrap();
        assert!(final_path(&dir, spec).exists());
        assert!(!part_path(&dir, spec).exists());
        assert_eq!(
            std::fs::metadata(final_path(&dir, spec)).unwrap().len(),
            300_000
        );
    }

    #[test]
    fn resume_completes_a_partial_file() {
        let body: Vec<u8> = (0..500_000u32).map(|i| (i % 251) as u8).collect();
        let server = TestServer::serve(body.clone());
        let spec: &'static ModelSpec = spec_for(&server);
        let dir = tempfile_dir();
        std::fs::write(part_path(&dir, spec), &body[..200_000]).unwrap();
        let cancel = AtomicBool::new(false);
        download_test_model(
            &format!("{}/ggml-test.bin", server.base),
            spec,
            &dir,
            &cancel,
        )
        .unwrap();
        assert_eq!(std::fs::read(final_path(&dir, spec)).unwrap(), body);
        assert!(server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.contains("Range: bytes=200000-")));
    }

    #[test]
    fn cancel_aborts_without_installing() {
        let server = TestServer::serve(vec![3u8; 5_000_000]);
        let spec: &'static ModelSpec = spec_for(&server);
        let dir = tempfile_dir();
        let cancel = AtomicBool::new(true);
        let err = download_test_model(
            &format!("{}/ggml-test.bin", server.base),
            spec,
            &dir,
            &cancel,
        )
        .unwrap_err();
        assert_eq!(err, CANCELLED);
        assert!(!final_path(&dir, spec).exists());
    }

    #[test]
    fn checksum_mismatch_removes_file() {
        let server = TestServer::serve(vec![1u8; 10_000]);
        let spec: &'static ModelSpec = Box::leak(Box::new(ModelSpec {
            sha256: "0000000000000000000000000000000000000000000000000000000000000000",
            ..*spec_for(&server)
        }));
        let dir = tempfile_dir();
        let cancel = AtomicBool::new(false);
        let err = download_test_model(
            &format!("{}/ggml-test.bin", server.base),
            spec,
            &dir,
            &cancel,
        )
        .unwrap_err();
        assert!(err.contains("checksum"));
        assert!(!part_path(&dir, spec).exists());
    }

    fn tempfile_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "monocode-dictation-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
