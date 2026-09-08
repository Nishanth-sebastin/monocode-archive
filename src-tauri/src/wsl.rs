//! App-open WSL process boundary. Reconnect is explicit; uncertain writes are not retried.
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const SCRIPT: &str = include_str!("wsl_bridge.py");
const MAX_MESSAGE: usize = 40 * 1024 * 1024;
const MAX_QUEUED_BYTES: usize = 64 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
static QUEUED_REQUESTS: AtomicUsize = AtomicUsize::new(0);
static QUEUED_BYTES: AtomicUsize = AtomicUsize::new(0);
static HOSTS: OnceLock<Mutex<HashMap<String, Arc<Bridge>>>> = OnceLock::new();

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub distribution: String,
    pub path: String,
}

impl Location {
    pub fn new(distribution: &str, path: &str) -> Result<Self, String> {
        if distribution.is_empty()
            || distribution.len() > 128
            || distribution.starts_with('-')
            || distribution.contains(['/', '\\', ':'])
            || distribution.chars().any(char::is_control)
        {
            return Err("Choose a named WSL distribution".into());
        }
        if !path.starts_with('/')
            || path.starts_with("//")
            || path.len() > 4096
            || path.contains('\\')
            || path.chars().any(char::is_control)
            || path.split('/').any(|part| part == "..")
        {
            return Err(
                "Choose an absolute Linux path without parent traversal or backslashes".into(),
            );
        }
        let parts: Vec<_> = path
            .split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .collect();
        Ok(Self {
            distribution: distribution.into(),
            path: format!("/{}", parts.join("/")),
        })
    }

    /// Internal host-qualified identity; the project picker displays the Linux path.
    pub fn identity(&self) -> String {
        format!("//wsl.localhost/{}{}", self.distribution, self.path)
    }

    pub fn with_path(&self, path: &str) -> Result<Self, String> {
        Self::new(&self.distribution, path)
    }
}

pub fn location(path: &str) -> Result<Option<Location>, String> {
    let normalized = path.replace('\\', "/");
    let normalized = normalized
        .strip_prefix("//?/UNC/")
        .map(|rest| format!("//{rest}"))
        .unwrap_or(normalized);
    let lower = normalized.to_ascii_lowercase();
    let prefix = if lower.starts_with("//wsl.localhost/") {
        "//wsl.localhost/"
    } else if lower.starts_with("//wsl$/") {
        "//wsl$/"
    } else {
        return Ok(None);
    };
    let rest = &normalized[prefix.len()..];
    let (distribution, path) = rest.split_once('/').unwrap_or((rest, ""));
    Location::new(distribution, &format!("/{path}")).map(Some)
}

pub fn path_location(path: &Path) -> Result<Option<Location>, String> {
    location(&path.to_string_lossy())
}

fn wsl_args(distribution: &str, path: &str, program: &str, args: &[String]) -> Vec<String> {
    let mut result = vec![
        "--distribution".into(),
        distribution.into(),
        "--cd".into(),
        path.into(),
        "--exec".into(),
        program.into(),
    ];
    result.extend_from_slice(args);
    result
}

fn wsl_command() -> Result<Command, String> {
    if !cfg!(windows) {
        return Err("WSL execution requires the native Windows app".into());
    }
    // Use the Windows system executable, never a repository-local wsl.exe.
    let system = std::env::var_os("SystemRoot").ok_or("Windows system directory is unavailable")?;
    let mut command = Command::new(Path::new(&system).join("System32").join("wsl.exe"));
    command.env("WSLENV", "");
    crate::hide_window_console(&mut command);
    Ok(command)
}

fn decode_distributions(bytes: &[u8]) -> Result<Vec<String>, String> {
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.iter().take(128).any(|byte| *byte == 0)
    {
        let (pairs, remainder) = bytes.as_chunks::<2>();
        if !remainder.is_empty() {
            return Err("WSL returned incomplete UTF-16 output".into());
        }
        let values: Vec<_> = pairs
            .iter()
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16(&values).map_err(|_| "WSL returned invalid distribution names")?
    } else {
        String::from_utf8(bytes.to_vec()).map_err(|_| "WSL returned invalid distribution names")?
    };
    let mut distributions = Vec::new();
    for name in text
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        Location::new(name, "/")?;
        if distributions.len() >= 64 {
            return Err("WSL returned more than 64 distributions".into());
        }
        if !distributions.contains(&name.to_owned()) {
            distributions.push(name.to_owned());
        }
    }
    Ok(distributions)
}

#[tauri::command(async)]
pub fn wsl_distributions() -> Result<Vec<String>, String> {
    let output = crate::bounded_process::output(
        wsl_command()?.args(["--list", "--quiet"]),
        Duration::from_secs(10),
        32 * 1024,
    )?;
    if !output.status.success() {
        return Err("WSL is unavailable. Install WSL and a Linux distribution, then retry.".into());
    }
    decode_distributions(&output.stdout)
}

struct Process {
    child: Child,
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
struct BridgeIo {
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}
struct Bridge {
    io: Mutex<BridgeIo>,
    process: Arc<Mutex<Process>>,
    alive: AtomicBool,
}
impl Bridge {
    fn start(command: &mut Command) -> Result<Self, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        let (mut child, job) =
            crate::windows::spawn_scoped(command).map_err(|e| format!("Cannot start WSL: {e}"))?;
        #[cfg(not(windows))]
        let mut child = command
            .spawn()
            .map_err(|e| format!("Cannot start Linux bridge: {e}"))?;
        let stdin = child.stdin.take().ok_or("Missing WSL input")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("Missing WSL output")?);
        Ok(Self {
            io: Mutex::new(BridgeIo { stdin, stdout }),
            process: Arc::new(Mutex::new(Process {
                child,
                #[cfg(windows)]
                _job: job,
            })),
            alive: AtomicBool::new(true),
        })
    }
    fn request(&self, request: Value) -> Result<Value, String> {
        struct RequestSlot;
        impl Drop for RequestSlot {
            fn drop(&mut self) {
                QUEUED_REQUESTS.fetch_sub(1, Ordering::SeqCst);
            }
        }
        if QUEUED_REQUESTS.fetch_add(1, Ordering::SeqCst) >= 32 {
            QUEUED_REQUESTS.fetch_sub(1, Ordering::SeqCst);
            return Err("WSL request queue is full. Retry after current work finishes.".into());
        }
        let _slot = RequestSlot;
        struct Size(usize);
        impl Write for Size {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0 = self.0.saturating_add(bytes.len());
                if self.0 >= MAX_MESSAGE {
                    return Err(std::io::Error::other("WSL request exceeds 40 MiB"));
                }
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        // Reserve the serialized-byte budget before allocating an encoded copy.
        let mut measured = Size(0);
        serde_json::to_writer(&mut measured, &request).map_err(|e| e.to_string())?;
        struct Budget(usize);
        impl Drop for Budget {
            fn drop(&mut self) {
                QUEUED_BYTES.fetch_sub(self.0, Ordering::SeqCst);
            }
        }
        let size = measured.0 + 1;
        if QUEUED_BYTES
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                current
                    .checked_add(size)
                    .filter(|next| *next <= MAX_QUEUED_BYTES)
            })
            .is_err()
        {
            return Err("WSL request queue is full. Retry after current work finishes.".into());
        }
        let _budget = Budget(size);
        let mut encoded = Vec::with_capacity(size);
        serde_json::to_writer(&mut encoded, &request).map_err(|e| e.to_string())?;
        encoded.push(b'\n');
        let deadline = Instant::now() + REQUEST_TIMEOUT;
        let mut io = loop {
            if !self.alive.load(Ordering::SeqCst) {
                return Err("WSL connection was interrupted. Reconnect the selected distribution; no action was replayed.".into());
            }
            if let Ok(io) = self.io.try_lock() {
                break io;
            }
            if Instant::now() >= deadline {
                return Err("WSL is busy. This queued action did not start.".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let (done, waiting) = mpsc::channel();
        let process = self.process.clone();
        let remaining = deadline.saturating_duration_since(Instant::now());
        let watchdog = std::thread::spawn(move || {
            if waiting.recv_timeout(remaining).is_err() {
                let _ = process
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .child
                    .kill();
            }
        });
        let result = (|| {
            io.stdin.write_all(&encoded).map_err(|e| e.to_string())?;
            io.stdin.flush().map_err(|e| e.to_string())?;
            let mut response = Vec::new();
            (&mut io.stdout)
                .take((MAX_MESSAGE + 1) as u64)
                .read_until(b'\n', &mut response)
                .map_err(|e| e.to_string())?;
            if response.is_empty() || response.len() > MAX_MESSAGE || !response.ends_with(b"\n") {
                return Err("WSL bridge stopped or returned an oversized response".into());
            }
            serde_json::from_slice::<Value>(&response).map_err(|e| e.to_string())
        })();
        let _ = done.send(());
        let _ = watchdog.join();
        match result {
            Ok(response) => {
                if let Some(error) = response.get("error").and_then(Value::as_str) {
                    return Err(error.to_owned());
                }
                response
                    .get("ok")
                    .cloned()
                    .ok_or_else(|| "Invalid WSL response".into())
            }
            Err(error) => {
                self.alive.store(false, Ordering::SeqCst);
                let _ = self
                    .process
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .child
                    .kill();
                Err(format!("WSL connection interrupted: {error}. Check /usr/bin/python3 and reconnect. An in-flight action may have completed; inspect it before retrying."))
            }
        }
    }
}

pub fn request<T: DeserializeOwned>(
    location: &Location,
    op: &str,
    mut arguments: Value,
) -> Result<T, String> {
    let bridge = HOSTS.get_or_init(Mutex::default).lock().unwrap_or_else(|e| e.into_inner()).get(&location.distribution.to_lowercase()).cloned()
        .ok_or("WSL is not connected. Open the project location and reconnect; Windows execution was not used.")?;
    arguments["op"] = op.into();
    arguments["path"] = location.path.clone().into();
    serde_json::from_value(bridge.request(arguments)?)
        .map_err(|e| format!("Invalid WSL result: {e}"))
}

#[tauri::command(async)]
pub fn wsl_connect(distribution: String, path: String) -> Result<Location, String> {
    let known = wsl_distributions()?;
    let distribution = known
        .iter()
        .find(|name| name.eq_ignore_ascii_case(&distribution))
        .ok_or("The selected WSL distribution is not installed")?;
    let location = Location::new(distribution, &path)?;
    let mut command = wsl_command()?;
    command.args(wsl_args(
        distribution,
        "/",
        "/usr/bin/python3",
        &["-u".into(), "-c".into(), SCRIPT.into()],
    ));
    let mut hosts = HOSTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    hosts.retain(|_, bridge| bridge.alive.load(Ordering::SeqCst));
    let key = distribution.to_lowercase();
    if !hosts.contains_key(&key) {
        if hosts.len() >= 4 {
            return Err("Four WSL distributions are already connected. Close the app before selecting another.".into());
        }
        hosts.insert(key, Arc::new(Bridge::start(&mut command)?));
    }
    drop(hosts);
    let result: Value = request(&location, "connect", json!({}))?;
    location.with_path(
        result["path"]
            .as_str()
            .ok_or("WSL did not return the selected Linux path")?,
    )
}

#[tauri::command]
pub fn wsl_connected(distribution: String) -> bool {
    HOSTS
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&distribution.to_lowercase())
        .is_some_and(|bridge| bridge.alive.load(Ordering::SeqCst))
}

/// Translate returned filesystem identities only; file contents and Git output stay unchanged.
pub fn files_request<T: DeserializeOwned>(
    location: &Location,
    op: &str,
    args: Value,
) -> Result<T, String> {
    fn qualify(value: &mut Value, location: &Location) -> Result<(), String> {
        match value {
            Value::Array(items) => {
                for item in items {
                    qualify(item, location)?;
                }
            }
            Value::Object(fields) => {
                if let Some(Value::String(path)) = fields.get_mut("path") {
                    *path = location.with_path(path)?.identity();
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut result: Value = request(location, op, args)?;
    qualify(&mut result, location)?;
    serde_json::from_value(result).map_err(|e| format!("Invalid WSL filesystem result: {e}"))
}

/// One Linux metadata request per distribution, never a UNC stat per file.
pub fn file_batches<T: DeserializeOwned>(paths: &[String], op: &str) -> Result<Vec<T>, String> {
    let mut groups: HashMap<String, Vec<(&String, Location)>> = HashMap::new();
    for path in paths {
        if let Some(location) = location(path)? {
            groups
                .entry(location.distribution.to_lowercase())
                .or_default()
                .push((path, location));
        }
    }
    let mut result = Vec::new();
    for paths in groups.values() {
        for batch in paths.chunks(64) {
            let values: Vec<Value> = request(
                &batch[0].1,
                op,
                json!({"paths":batch.iter().map(|(_, location)| &location.path).collect::<Vec<_>>()}),
            )?;
            let mut remaining = batch.iter();
            for mut value in values {
                let (original, _) = remaining
                    .find(|(_, location)| value["path"] == location.path)
                    .ok_or("WSL returned an unexpected metadata path")?;
                // Watchers key their results by the requested identity, including
                // supported wsl$ aliases and backslash-form attachment paths.
                value["path"] = (*original).clone().into();
                result.push(
                    serde_json::from_value(value)
                        .map_err(|e| format!("Invalid WSL metadata: {e}"))?,
                );
            }
        }
    }
    Ok(result)
}

pub fn path_request(location: &Location, op: &str, args: Value) -> Result<String, String> {
    let path: String = request(location, op, args)?;
    Ok(location.with_path(&path)?.identity())
}

pub fn transfer_path(from: &str, destination: &str, op: &str) -> Result<Option<String>, String> {
    match (location(from)?, location(destination)?) {
        (None, None) => Ok(None),
        (Some(from), Some(to)) if from.distribution.eq_ignore_ascii_case(&to.distribution) => {
            path_request(&from, op, json!({"destination":to.path})).map(Some)
        }
        _ => Err("Copy and move must stay on the same execution host and WSL distribution. Use an explicit file transfer instead.".into()),
    }
}

pub fn git(
    location: &Location,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<std::process::Output, String> {
    use base64::Engine;
    #[derive(Deserialize)]
    struct Capture {
        code: i32,
        stdout: String,
        stderr: String,
    }
    let captured: Capture = request(
        location,
        "git",
        json!({"args":args,"input":input.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes))}),
    )?;
    #[cfg(unix)]
    let status = {
        use std::os::unix::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(if captured.code < 0 {
            -captured.code
        } else {
            captured.code << 8
        })
    };
    #[cfg(windows)]
    let status = {
        use std::os::windows::process::ExitStatusExt;
        std::process::ExitStatus::from_raw(captured.code as u32)
    };
    Ok(std::process::Output {
        status,
        stdout: base64::engine::general_purpose::STANDARD
            .decode(captured.stdout)
            .map_err(|e| e.to_string())?,
        stderr: base64::engine::general_purpose::STANDARD
            .decode(captured.stderr)
            .map_err(|e| e.to_string())?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distribution_identity_and_arguments_preserve_linux_paths() {
        let value = Location::new("Ubuntu Work", "/home/me/Zażółć repo/Case").unwrap();
        assert_eq!(location(&value.identity()).unwrap(), Some(value.clone()));
        assert_eq!(
            location("\\\\wsl$\\Ubuntu Work\\home\\me\\Zażółć repo\\Case").unwrap(),
            Some(value.clone())
        );
        assert_ne!(value, value.with_path("/home/me/Zażółć repo/case").unwrap());
        assert_eq!(
            wsl_args(
                &value.distribution,
                &value.path,
                "/usr/bin/git",
                &["show".into(), "a;$(no)".into()]
            ),
            vec![
                "--distribution",
                "Ubuntu Work",
                "--cd",
                "/home/me/Zażółć repo/Case",
                "--exec",
                "/usr/bin/git",
                "show",
                "a;$(no)"
            ]
        );
        for invalid in ["C:/repo", "/a/../b", "/bad\npath", "/bad\\path"] {
            assert!(Location::new("Ubuntu", invalid).is_err());
        }
        assert!(location("C:\\native\\project").unwrap().is_none());
        let bytes: Vec<_> = "\u{feff}Ubuntu\r\nDebian Work\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(
            decode_distributions(&bytes).unwrap(),
            vec!["Ubuntu", "Debian Work"]
        );
        assert!(decode_distributions(&[255, 254, 0]).is_err());
        assert!(transfer_path(&value.identity(), "C:/native", "move").is_err());
        assert!(transfer_path("C:/native", &value.identity(), "copy").is_err());
        assert!(
            transfer_path(&value.identity(), "//wsl.localhost/Debian/home/me", "copy").is_err()
        );
    }
    #[cfg(unix)]
    #[test]
    fn filesystem_commands_use_linux_boundary_and_preserve_identity() {
        use crate::fs;
        use std::os::unix::fs::{symlink, PermissionsExt};
        use tauri::async_runtime::block_on;
        let unique = format!(
            "monocode-wsl-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(&unique);
        std::fs::create_dir(&directory).unwrap();
        struct Cleanup(std::path::PathBuf, String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                HOSTS.get().unwrap().lock().unwrap().remove(&self.1);
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(directory.clone(), unique.clone());
        // Run the production Python filesystem/Git logic. macOS lacks GNU mv;
        // replace only that external process boundary and assert its exact argv.
        // Linux CI executes the real no-clobber mv command too.
        let script = format!(
            "__name__ = 'fixture'\nexec({})\n{}\nserve()",
            serde_json::to_string(SCRIPT).unwrap(),
            r#"
if sys.platform == 'darwin':
    real_run = run
    def run(argv, cwd, input_bytes=None, timeout=25):
        if argv[0] != 'mv':
            return real_run(argv, cwd, input_bytes, timeout)
        assert argv[:4] == ['mv', '--no-clobber', '--no-target-directory', '--']
        if not os.path.lexists(argv[5]):
            os.rename(argv[4], argv[5])
        return 0, b'', b''
"#
        );
        let bridge =
            Arc::new(Bridge::start(Command::new("python3").args(["-u", "-c", &script])).unwrap());
        HOSTS
            .get_or_init(Mutex::default)
            .lock()
            .unwrap()
            .insert(unique.clone(), bridge);
        let root = Location::new(&unique, &directory.to_string_lossy()).unwrap();
        let file = fs::create_path(root.identity(), "Zażółć file.txt".into(), false).unwrap();
        assert!(file.starts_with(&root.identity()));
        block_on(fs::write_text_file(file.clone(), "hello\r\n".into())).unwrap();
        assert_eq!(
            block_on(fs::read_text_file(file.clone())).unwrap(),
            "hello\r\n"
        );
        let missing = format!("{}/missing", root.identity());
        let stats =
            serde_json::to_value(fs::stat_files(vec![file.clone(), missing.clone()]).unwrap())
                .unwrap();
        assert_eq!(stats[0]["path"], file);
        assert!(stats[0]["mtimeMs"].is_number());
        assert!(stats[1]["mtimeMs"].is_null());
        let alias = file.replace("wsl.localhost", "wsl$").replace('/', "\\");
        let alias_stats =
            serde_json::to_value(fs::stat_files(vec![alias.clone(), file.clone()]).unwrap())
                .unwrap();
        assert_eq!(alias_stats[0]["path"], alias);
        assert_eq!(alias_stats[1]["path"], file);
        let inspected = fs::inspect_paths(vec![file.clone(), missing]).unwrap();
        assert_eq!(inspected.len(), 1);
        assert_eq!(inspected[0].path, file);
        let renamed = block_on(fs::rename_path(file.clone(), "Renamed ü.txt".into())).unwrap();
        assert!(block_on(fs::read_text_file(file.clone())).is_err());
        fs::create_path(root.identity(), "occupied.txt".into(), false).unwrap();
        assert!(block_on(fs::rename_path(renamed.clone(), "occupied.txt".into())).is_err());
        assert_eq!(
            block_on(fs::read_text_file(renamed.clone())).unwrap(),
            "hello\r\n"
        );
        let copy = block_on(fs::copy_path(renamed.clone(), root.identity())).unwrap();
        assert_ne!(copy, renamed);
        assert_eq!(
            block_on(fs::read_text_file(copy.clone())).unwrap(),
            "hello\r\n"
        );
        block_on(fs::delete_path(copy.clone())).unwrap();
        assert!(block_on(fs::read_text_file(copy)).is_err());
        let native = directory.join("Renamed ü.txt");
        std::fs::set_permissions(&native, std::fs::Permissions::from_mode(0o640)).unwrap();
        symlink(&native, directory.join("link")).unwrap();
        let link = format!("{}/link", root.identity());
        block_on(fs::write_text_file(link.clone(), "through symlink".into())).unwrap();
        assert_eq!(std::fs::read_to_string(&native).unwrap(), "through symlink");
        assert_eq!(
            std::fs::metadata(&native).unwrap().permissions().mode() & 0o777,
            0o640
        );
        block_on(fs::delete_path(link)).unwrap();
        assert!(native.exists());
        assert!(fs::create_path(root.identity(), "../outside".into(), false).is_err());
        if std::env::var_os("MONOCODE_WSL_MEASURE").is_some() {
            let files: Vec<_> = (0..64)
                .map(|index| {
                    let path = directory.join(format!("editor-{index}.txt"));
                    std::fs::write(&path, "open editor\n").unwrap();
                    path
                })
                .collect();
            let identities: Vec<_> = files
                .iter()
                .map(|path| root.with_path(&path.to_string_lossy()).unwrap().identity())
                .collect();
            let mut native = Vec::new();
            let mut bridged = Vec::new();
            for _ in 0..21 {
                let start = Instant::now();
                for path in &files {
                    std::fs::metadata(path).unwrap();
                }
                native.push(start.elapsed());
                let start = Instant::now();
                assert_eq!(fs::stat_files(identities.clone()).unwrap().len(), 64);
                bridged.push(start.elapsed());
            }
            native.sort();
            bridged.sort();
            eprintln!("64-file metadata / 21 samples: native median {:?}, max {:?}; Python bridge median {:?}, max {:?}. This measures the local process boundary, not Windows-to-WSL transport or WebView cost.", native[10], native[20], bridged[10], bridged[20]);
        }
    }
    #[cfg(unix)]
    #[test]
    fn real_bridge_reads_git_and_survives_request_errors() {
        let mut command = Command::new("python3");
        command.args(["-u", "-c", SCRIPT]);
        let bridge = Bridge::start(&mut command).unwrap();
        let path = std::env::temp_dir().to_string_lossy().into_owned();
        let connected = bridge
            .request(json!({"op":"connect", "path":path}))
            .unwrap();
        assert!(connected["path"].as_str().unwrap().starts_with('/'));
        assert!(bridge
            .request(json!({"op":"unknown", "path":path}))
            .is_err());
        assert!(bridge.alive.load(Ordering::SeqCst));
        assert!(bridge
            .request(json!({"op":"unknown","path":path,"content":"a".repeat(MAX_MESSAGE)}))
            .unwrap_err()
            .contains("40 MiB"));
        assert!(bridge.alive.load(Ordering::SeqCst));
        let version = bridge
            .request(json!({"op":"git", "path":path, "args":["--version"]}))
            .unwrap();
        assert_eq!(version["code"], 0);
        bridge.process.lock().unwrap().child.kill().unwrap();
        assert!(bridge
            .request(json!({"op":"connect", "path":path}))
            .is_err());
        assert!(!bridge.alive.load(Ordering::SeqCst));
        assert!(bridge
            .request(json!({"op":"connect", "path":path}))
            .unwrap_err()
            .contains("Reconnect"));
    }
}
