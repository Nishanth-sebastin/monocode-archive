//! One idle-sleep assertion for the whole runtime, held only while a window
//! reports agents executing real work. The OS keeps control of display sleep,
//! manual sleep and critical-battery behavior; we only block idle sleep.
//!
//! - macOS: one owned `/usr/bin/caffeinate -i -w <our pid>` child. `-w` ties
//!   the helper to this process, so a crash cannot orphan the assertion.
//! - Windows: a dedicated thread holds `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`
//!   via `SetThreadExecutionState` and clears it on release.
//! - Other platforms report `supported: false`; agent work is unaffected.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

pub const STATUS_EVENT: &str = "power-assertion";

/// One window may not pin more than this many working sessions.
const MAX_WORKING_PER_WINDOW: usize = 256;
/// Acquire attempts per work streak before the row must be retried by hand.
const MAX_AUTO_ATTEMPTS: u8 = 3;

#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PowerStatus {
    supported: bool,
    enabled: bool,
    held: bool,
    working: usize,
    error: Option<String>,
}

/// One held OS assertion. Dropping it must release the assertion.
trait SleepAssertion: Send {
    /// Identity used to match a dead-helper report to the installed assertion.
    fn key(&self) -> u64;
    /// Helper process that needs an exit monitor (macOS caffeinate).
    fn take_child(&mut self) -> Option<std::process::Child> {
        None
    }
}

type AcquireFn = Box<dyn Fn() -> Result<Box<dyn SleepAssertion>, String> + Send>;

struct PowerInner {
    /// Shared setting; the last window to report wins, like localStorage.
    enabled: bool,
    /// Working session ids claimed by each open window.
    working: HashMap<String, HashSet<String>>,
    assertion: Option<Box<dyn SleepAssertion>>,
    error: Option<String>,
    /// Acquire attempts since refs last emptied; bounds failure loops.
    auto_attempts: u8,
    /// Bumped on every install/release so a dead-helper report from an older
    /// assertion can never release or reacquire for the current one.
    generation: u64,
    acquire: AcquireFn,
    last_status: Option<PowerStatus>,
}

impl PowerInner {
    fn working_count(&self) -> usize {
        self.working.values().map(|ids| ids.len()).sum()
    }
}

pub struct PowerHost {
    inner: Mutex<PowerInner>,
}

impl PowerHost {
    pub fn new() -> Self {
        Self::with_acquire(Box::new(platform::acquire))
    }

    fn with_acquire(acquire: AcquireFn) -> Self {
        Self {
            inner: Mutex::new(PowerInner {
                enabled: false,
                working: HashMap::new(),
                assertion: None,
                error: None,
                auto_attempts: 0,
                generation: 0,
                acquire,
                last_status: None,
            }),
        }
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, PowerInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Replace this window's working set and the shared enabled flag.
    pub fn sync(
        &self,
        app: Option<&AppHandle>,
        window: &str,
        enabled: bool,
        session_ids: Vec<String>,
    ) -> PowerStatus {
        let mut inner = self.lock_inner();
        inner.enabled = enabled;
        let ids: HashSet<String> = session_ids
            .into_iter()
            .take(MAX_WORKING_PER_WINDOW)
            .collect();
        if ids.is_empty() {
            inner.working.remove(window);
        } else {
            inner.working.insert(window.to_string(), ids);
        }
        self.reconcile(&mut inner, app)
    }

    pub fn status(&self) -> PowerStatus {
        let inner = self.lock_inner();
        Self::status_of(&inner)
    }

    /// User-invoked retry after an acquire failure; resets the attempt budget.
    pub fn retry(&self, app: Option<&AppHandle>) -> PowerStatus {
        let mut inner = self.lock_inner();
        inner.auto_attempts = 0;
        self.reconcile(&mut inner, app)
    }

    /// A closed window can no longer vouch for work; drop its refs.
    pub fn drop_window(&self, app: &AppHandle, label: &str) {
        let mut inner = self.lock_inner();
        if inner.working.remove(label).is_none() {
            return;
        }
        self.reconcile(&mut inner, Some(app));
    }

    /// Runtime exit: release whatever is held. The OS also reclaims process
    /// state, and the macOS helper is tied to this pid, but stay explicit.
    pub fn release(&self, app: Option<&AppHandle>) {
        let mut inner = self.lock_inner();
        inner.enabled = false;
        inner.working.clear();
        self.reconcile(&mut inner, app);
    }

    /// A helper process exited on its own. Reported by the monitor thread
    /// installed alongside the assertion; stale generations are ignored.
    fn helper_exited(&self, app: Option<&AppHandle>, key: u64, generation: u64) {
        let mut inner = self.lock_inner();
        if inner.generation != generation || inner.assertion.as_ref().map(|a| a.key()) != Some(key)
        {
            return;
        }
        eprintln!("monocode power: sleep-assertion helper exited (key={key})");
        // The helper is already dead; taking it just unregisters. Dropping it
        // SIGTERMs a reaped pid, which is a harmless no-op.
        inner.assertion = None;
        self.reconcile(&mut inner, app);
    }

    /// Acquire when enabled with working refs; release otherwise. Never holds
    /// more than one OS assertion and never retries in a loop: failures park
    /// in `error` after MAX_AUTO_ATTEMPTS until refs empty or the user retries.
    fn reconcile(&self, inner: &mut PowerInner, app: Option<&AppHandle>) -> PowerStatus {
        let want = inner.enabled && inner.working_count() > 0;
        if !want {
            inner.auto_attempts = 0;
            inner.error = None;
            if let Some(assertion) = inner.assertion.take() {
                inner.generation += 1;
                eprintln!(
                    "monocode power: released idle-sleep assertion (platform={})",
                    platform::NAME
                );
                // Dropping here is safe under the lock: macOS release is a
                // SIGTERM (its monitor only locks after we let go) and the
                // Windows thread never touches this mutex.
                drop(assertion);
            }
            let status = Self::status_of(inner);
            self.emit(inner, app, &status);
            return status;
        }

        if inner.assertion.is_none() && inner.auto_attempts < MAX_AUTO_ATTEMPTS {
            inner.auto_attempts += 1;
            let working = inner.working_count();
            match (inner.acquire)() {
                Ok(mut assertion) => {
                    let key = assertion.key();
                    let child = assertion.take_child();
                    inner.assertion = Some(assertion);
                    inner.error = None;
                    inner.generation += 1;
                    let generation = inner.generation;
                    eprintln!(
                        "monocode power: acquired idle-sleep assertion (platform={}, working={working})",
                        platform::NAME
                    );
                    if let (Some(app), Some(child)) = (app, child) {
                        Self::monitor_helper(app.clone(), child, key, generation);
                    }
                }
                Err(error) => {
                    eprintln!(
                        "monocode power: acquire failed (platform={}): {error}",
                        platform::NAME
                    );
                    inner.error = Some(error);
                }
            }
        }
        let status = Self::status_of(inner);
        self.emit(inner, app, &status);
        status
    }

    fn monitor_helper(app: AppHandle, mut child: std::process::Child, key: u64, generation: u64) {
        thread::spawn(move || {
            let _ = child.wait();
            if let Some(host) = app.try_state::<PowerHost>() {
                host.helper_exited(Some(&app), key, generation);
            }
        });
    }

    fn status_of(inner: &PowerInner) -> PowerStatus {
        PowerStatus {
            supported: platform::SUPPORTED,
            enabled: inner.enabled,
            held: inner.assertion.is_some(),
            working: inner.working_count(),
            error: inner.error.clone(),
        }
    }

    fn emit(&self, inner: &mut PowerInner, app: Option<&AppHandle>, status: &PowerStatus) {
        if inner.last_status.as_ref() == Some(status) {
            return;
        }
        inner.last_status = Some(status.clone());
        if let Some(app) = app {
            let _ = app.emit(STATUS_EVENT, status);
        }
    }
}

impl Drop for PowerHost {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.inner.lock() {
            let _ = inner.assertion.take();
        }
    }
}

#[tauri::command(async)]
pub fn power_sync(
    app: AppHandle,
    window: WebviewWindow,
    host: State<'_, PowerHost>,
    enabled: bool,
    session_ids: Vec<String>,
) -> Result<PowerStatus, String> {
    Ok(host.sync(Some(&app), window.label(), enabled, session_ids))
}

#[tauri::command]
pub fn power_status(host: State<'_, PowerHost>) -> PowerStatus {
    host.status()
}

#[tauri::command(async)]
pub fn power_retry(app: AppHandle, host: State<'_, PowerHost>) -> Result<PowerStatus, String> {
    Ok(host.retry(Some(&app)))
}

#[cfg(target_os = "macos")]
mod platform {
    use super::SleepAssertion;
    use std::process::{Child, Command, Stdio};

    pub const NAME: &str = "macos";
    pub const SUPPORTED: bool = true;

    /// `-i` blocks idle system sleep only (display may still turn off); `-w`
    /// ties the assertion to this process so a crash releases it too.
    pub fn acquire() -> Result<Box<dyn SleepAssertion>, String> {
        let parent = std::process::id().to_string();
        let mut cmd = Command::new("/usr/bin/caffeinate");
        cmd.args(["-i", "-w", &parent]);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = cmd
            .spawn()
            .map_err(|e| format!("Could not start caffeinate: {e}"))?;
        Ok(Box::new(Caffeinate {
            pid: child.id(),
            child: Some(child),
        }))
    }

    struct Caffeinate {
        pid: u32,
        /// Ownership moves to the monitor thread while the assertion lives;
        /// present only if the assertion is dropped before that handoff.
        child: Option<Child>,
    }

    impl SleepAssertion for Caffeinate {
        fn key(&self) -> u64 {
            self.pid as u64
        }
        fn take_child(&mut self) -> Option<Child> {
            self.child.take()
        }
    }

    impl Drop for Caffeinate {
        fn drop(&mut self) {
            unsafe { libc::kill(self.pid as i32, libc::SIGTERM) };
            if let Some(mut child) = self.child.take() {
                let _ = child.wait();
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Live check against the real power assertion API. Run with:
        /// `cargo test power::platform -- --ignored`
        #[test]
        #[ignore = "queries real pmset assertions"]
        fn caffeinate_holds_and_releases_idle_sleep() {
            let mut assertion = acquire().expect("caffeinate spawns");
            let mut child = assertion.take_child().expect("helper child");
            let marker = format!("pid {}(caffeinate)", child.id());
            let our_assertion = || {
                let output = Command::new("pmset")
                    .args(["-g", "assertions"])
                    .output()
                    .expect("pmset runs");
                let text = String::from_utf8_lossy(&output.stdout);
                // Only the line tied to our helper counts; the machine may
                // legitimately hold other idle-sleep assertions.
                text.lines().any(|line| {
                    line.contains(&marker) && line.contains("PreventUserIdleSystemSleep")
                })
            };
            std::thread::sleep(std::time::Duration::from_secs(1));
            assert!(our_assertion(), "pmset should show the assertion");
            drop(assertion);
            let _ = child.wait();
            std::thread::sleep(std::time::Duration::from_secs(1));
            assert!(!our_assertion(), "pmset should show the release");
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::SleepAssertion;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::thread::{self, JoinHandle};
    use windows_sys::Win32::System::Power::{
        SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
    };

    pub const NAME: &str = "windows";
    pub const SUPPORTED: bool = true;

    static NEXT_KEY: AtomicU64 = AtomicU64::new(1);

    /// The execution state is per-thread, so one dedicated thread must both
    /// set and clear it. The thread parks until dropped; process exit also
    /// reclaims the state.
    pub fn acquire() -> Result<Box<dyn SleepAssertion>, String> {
        let wanted = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let handle = thread::spawn(move || {
            unsafe { SetThreadExecutionState(wanted) };
            // A fresh thread has no prior state, so the first call's 0 return
            // cannot tell success from failure; the second call reports what
            // the first installed.
            if unsafe { SetThreadExecutionState(wanted) } != wanted {
                let _ = ready_tx.send(Err(
                    "SetThreadExecutionState did not hold the system-awake request".into(),
                ));
                return;
            }
            if ready_tx.send(Ok(())).is_err() {
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
                return;
            }
            let _ = stop_rx.recv();
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        });
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Box::new(ThreadAssertion {
                key: NEXT_KEY.fetch_add(1, Ordering::Relaxed),
                stop: stop_tx,
                handle: Some(handle),
            })),
            Ok(Err(error)) => {
                let _ = handle.join();
                Err(error)
            }
            Err(_) => Err("Power assertion thread failed to start".into()),
        }
    }

    struct ThreadAssertion {
        key: u64,
        stop: mpsc::Sender<()>,
        handle: Option<JoinHandle<()>>,
    }

    impl SleepAssertion for ThreadAssertion {
        fn key(&self) -> u64 {
            self.key
        }
    }

    impl Drop for ThreadAssertion {
        fn drop(&mut self) {
            let _ = self.stop.send(());
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::SleepAssertion;

    pub const NAME: &str = "unsupported";
    pub const SUPPORTED: bool = false;

    pub fn acquire() -> Result<Box<dyn SleepAssertion>, String> {
        Err("Keeping the computer awake is not supported on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    struct FakeAssertion {
        key: u64,
    }

    impl SleepAssertion for FakeAssertion {
        fn key(&self) -> u64 {
            self.key
        }
    }

    type AcquireLog = Arc<AtomicU64>;

    fn fake_host(fail: bool) -> (PowerHost, AcquireLog) {
        let calls = Arc::new(AtomicU64::new(0));
        let log = calls.clone();
        let host = PowerHost::with_acquire(Box::new(move || {
            let key = log.fetch_add(1, Ordering::SeqCst) + 1;
            if fail {
                return Err("acquire refused".to_string());
            }
            Ok(Box::new(FakeAssertion { key }) as Box<dyn SleepAssertion>)
        }));
        (host, calls)
    }

    fn held_key(host: &PowerHost) -> Option<u64> {
        host.lock_inner().assertion.as_ref().map(|a| a.key())
    }

    #[test]
    fn acquires_once_per_work_streak() {
        let (host, calls) = fake_host(false);
        let status = host.sync(None, "main", true, vec!["s1".into()]);
        assert!(status.held && status.working == 1);
        let status = host.sync(None, "main", true, vec!["s1".into(), "s2".into()]);
        assert!(status.held && status.working == 2);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn holds_until_last_window_reports_idle() {
        let (host, _) = fake_host(false);
        host.sync(None, "a", true, vec!["s1".into()]);
        host.sync(None, "b", true, vec!["s2".into()]);
        host.sync(None, "a", true, vec![]);
        assert!(host.status().held);
        host.sync(None, "b", true, vec![]);
        assert!(!host.status().held);
    }

    #[test]
    fn disabled_setting_never_acquires() {
        let (host, calls) = fake_host(false);
        let status = host.sync(None, "main", false, vec!["s1".into()]);
        assert!(!status.held);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn disabling_releases_and_reenabling_reacquires() {
        let (host, calls) = fake_host(false);
        host.sync(None, "main", true, vec!["s1".into()]);
        let status = host.sync(None, "main", false, vec!["s1".into()]);
        assert!(!status.held);
        let status = host.sync(None, "main", true, vec!["s1".into()]);
        assert!(status.held);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn failed_acquire_reports_error_and_bounds_attempts() {
        let (host, calls) = fake_host(true);
        let status = host.sync(None, "main", true, vec!["s1".into()]);
        assert!(!status.held && status.error.is_some());
        host.sync(None, "main", true, vec!["s1".into(), "s2".into()]);
        host.sync(None, "main", true, vec!["s2".into()]);
        host.sync(None, "main", true, vec!["s3".into()]);
        assert_eq!(calls.load(Ordering::SeqCst), MAX_AUTO_ATTEMPTS as u64);
        assert!(host.status().error.is_some());
        // The user retry resets the budget.
        host.retry(None);
        assert_eq!(calls.load(Ordering::SeqCst), MAX_AUTO_ATTEMPTS as u64 + 1);
    }

    #[test]
    fn failure_clears_when_work_ends() {
        let (host, _) = fake_host(true);
        host.sync(None, "main", true, vec!["s1".into()]);
        let status = host.sync(None, "main", true, vec![]);
        assert!(!status.held && status.error.is_none());
    }

    #[test]
    fn dead_helper_reacquires_while_work_remains() {
        let (host, calls) = fake_host(false);
        host.sync(None, "main", true, vec!["s1".into()]);
        let generation = host.lock_inner().generation;
        // A report for an older generation is ignored.
        host.helper_exited(None, 999, generation - 1);
        assert!(host.status().held);
        // The installed helper dying reacquires inside the budget.
        host.helper_exited(None, held_key(&host).unwrap(), generation);
        assert!(host.status().held);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn dead_helper_stops_reacquiring_past_the_budget() {
        let (host, calls) = fake_host(false);
        host.sync(None, "main", true, vec!["s1".into()]);
        loop {
            let (key, generation) = {
                let inner = host.lock_inner();
                (inner.assertion.as_ref().map(|a| a.key()), inner.generation)
            };
            let Some(key) = key else { break };
            host.helper_exited(None, key, generation);
        }
        let status = host.status();
        assert!(!status.held);
        assert_eq!(calls.load(Ordering::SeqCst), MAX_AUTO_ATTEMPTS as u64);
    }

    #[test]
    fn window_drop_releases_when_it_was_the_only_reporter() {
        let (host, _) = fake_host(false);
        host.sync(None, "main", true, vec!["s1".into()]);
        {
            let mut inner = host.lock_inner();
            inner.working.remove("main");
        }
        host.sync(None, "other", true, vec![]);
        assert!(!host.status().held);
    }

    #[test]
    fn release_clears_state() {
        let (host, _) = fake_host(false);
        host.sync(None, "main", true, vec!["s1".into()]);
        host.release(None);
        let status = host.status();
        assert!(!status.held && !status.enabled && status.working == 0);
    }
}
