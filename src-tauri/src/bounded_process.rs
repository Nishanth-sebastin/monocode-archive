use std::io::Read;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Captures a finite CLI response without allowing a stalled child or pipe to
/// retain an unbounded worker. Every process is isolated from user-owned trees.
pub(crate) fn output(
    command: &mut Command,
    timeout: Duration,
    limit: usize,
) -> Result<Output, String> {
    output_cancellable(command, timeout, limit, || false)
}

pub(crate) fn output_cancellable(
    command: &mut Command,
    timeout: Duration,
    limit: usize,
    cancelled: impl Fn() -> bool,
) -> Result<Output, String> {
    if cancelled() {
        return Err("Command cancelled".into());
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    let (mut child, job) = crate::windows::spawn_scoped(command).map_err(|e| e.to_string())?;
    #[cfg(not(windows))]
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    let read = |pipe: Box<dyn Read + Send>| {
        let (tx, rx) = mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe
                .take(limit as u64 + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
                .map_err(|e| e.to_string());
            let _ = tx.send(result);
        });
        (rx, reader)
    };
    let (out, out_reader) = read(Box::new(child.stdout.take().ok_or("Missing stdout")?));
    let (err, err_reader) = read(Box::new(child.stderr.take().ok_or("Missing stderr")?));
    let deadline = Instant::now() + timeout;
    let mut stdout = None;
    let mut stderr = None;
    let mut status = None;
    let result = loop {
        if cancelled() {
            break Err("Command cancelled".into());
        }
        if stdout.is_none() {
            stdout = out.try_recv().ok();
        }
        if stderr.is_none() {
            stderr = err.try_recv().ok();
        }
        if stdout
            .as_ref()
            .is_some_and(|value| value.as_ref().is_ok_and(|bytes| bytes.len() > limit))
            || stderr
                .as_ref()
                .is_some_and(|value| value.as_ref().is_ok_and(|bytes| bytes.len() > limit))
        {
            break Err("Command output exceeded its limit".into());
        }
        if status.is_none() && stdout.is_some() && stderr.is_some() {
            match child.try_wait() {
                Ok(value) => status = value,
                Err(error) => break Err(error.to_string()),
            }
        }
        if status.is_some() && stdout.is_some() && stderr.is_some() {
            break Ok(());
        }
        if Instant::now() >= deadline {
            break Err(
                "Command timed out; its result may be uncertain. Refresh before retrying a write."
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    // Close the scoped Windows job even when its leader already exited.
    #[cfg(windows)]
    {
        let _ = pid;
        drop(job);
    }
    #[cfg(unix)]
    if result.is_err() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
    }
    let _ = out_reader.join();
    let _ = err_reader.join();
    result?;
    Ok(Output {
        status: status.ok_or("Missing command status")?,
        stdout: stdout.ok_or("Missing output")??,
        stderr: stderr.ok_or("Missing error output")??,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captures_output_and_rejects_overflow_and_timeout() {
        #[cfg(unix)]
        let command = |script: &str| {
            let mut c = Command::new("sh");
            c.args(["-c", script]);
            c
        };
        #[cfg(windows)]
        let command = |script: &str| {
            let mut c = Command::new("cmd");
            c.args(["/C", script]);
            c
        };
        let result = output(&mut command("echo hello"), Duration::from_secs(5), 1024).unwrap();
        assert!(result.status.success());
        assert_eq!(String::from_utf8(result.stdout).unwrap().trim(), "hello");
        assert!(
            output(&mut command("echo too-long"), Duration::from_secs(5), 3)
                .unwrap_err()
                .contains("limit")
        );
        #[cfg(unix)]
        let script = "sleep 10 & wait";
        #[cfg(windows)]
        let script = "ping -n 10 127.0.0.1 > nul";
        let start = Instant::now();
        assert!(
            output(&mut command(script), Duration::from_millis(100), 1024)
                .unwrap_err()
                .contains("timed out")
        );
        assert!(start.elapsed() < Duration::from_secs(5));
        let checks = std::sync::atomic::AtomicUsize::new(0);
        let start = Instant::now();
        assert!(output_cancellable(
            &mut command(script),
            Duration::from_secs(10),
            1024,
            || checks.fetch_add(1, std::sync::atomic::Ordering::Relaxed) > 0
        )
        .unwrap_err()
        .contains("cancelled"));
        assert!(start.elapsed() < Duration::from_secs(5));
    }
}
