use std::{io, process::ExitStatus, time::Duration};
use tokio::{process::Child, sync::watch};

/// Owns descendants even when the CLI exits before they do.
pub struct ProcessTree {
    #[cfg(windows)]
    job: isize,
    #[cfg(unix)]
    pid: u32,
}
impl ProcessTree {
    pub fn attach(child: &Child) -> io::Result<Self> {
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("child already exited"))?;
        Self::attach_pid(pid)
    }

    pub fn attach_std(child: &std::process::Child) -> io::Result<Self> {
        Self::attach_pid(child.id())
    }

    fn attach_pid(pid: u32) -> io::Result<Self> {
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::{
                Foundation::CloseHandle,
                System::{JobObjects::*, Threading::*},
            };
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            let ok = !process.is_null()
                && SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                ) != 0
                && AssignProcessToJobObject(job, process) != 0;
            let error = io::Error::last_os_error();
            if !process.is_null() {
                CloseHandle(process);
            }
            if !ok {
                CloseHandle(job);
                return Err(error);
            }
            Ok(Self { job: job as isize })
        }
        #[cfg(unix)]
        {
            Ok(Self { pid })
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = pid;
            Ok(Self {})
        }
    }
}
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job as _);
        }
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", "--", &format!("-{}", self.pid)])
                .status();
        }
    }
}

/// One Child owner: stop never locks a Child already locked by wait().
pub async fn supervise(
    child: Child,
    stop: watch::Receiver<bool>,
    tree: ProcessTree,
) -> io::Result<ExitStatus> {
    supervise_with_close(child, stop, tree, || {}).await
}

/// Revoke runtime authority before process-tree teardown or any reap/drain wait.
pub fn supervise_with_close(
    child: Child,
    mut stop: watch::Receiver<bool>,
    tree: ProcessTree,
    on_close: impl FnOnce(),
) -> impl std::future::Future<Output = io::Result<ExitStatus>> {
    // Construct outside the future: even an unpolled/aborted supervisor revokes
    // before dropping its Job Object or kill-on-drop Child. Field drop order is
    // intentional and does not depend on async-generator capture ordering.
    let process = SupervisedProcess {
        close: CloseBeforeCleanup(Some(on_close)),
        tree: Some(tree),
        child,
    };
    async move {
        let mut process = process;
        let status = tokio::select! {
            biased;
            status = process.child.wait() => {
                process.close.close();
                status
            },
            _ = stop.changed() => {
                process.close.close();
                // EOF and wait may become ready together; retain natural exit codes.
                match tokio::time::timeout(Duration::from_millis(50), process.child.wait()).await {
                    Ok(status) => status,
                    Err(_) => {
                        drop(process.tree.take());
                        let _ = process.child.start_kill();
                        process.child.wait().await
                    }
                }
            }
        };
        drop(process.tree.take());
        status
    }
}

struct SupervisedProcess<F: FnOnce()> {
    close: CloseBeforeCleanup<F>,
    tree: Option<ProcessTree>,
    child: Child,
}

struct CloseBeforeCleanup<F: FnOnce()>(Option<F>);

impl<F: FnOnce()> CloseBeforeCleanup<F> {
    fn close(&mut self) {
        if let Some(close) = self.0.take() {
            close();
        }
    }
}

impl<F: FnOnce()> Drop for CloseBeforeCleanup<F> {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Stdio;
    use tokio::{io::BufReader, process::Command};

    // This test executable is the fake CLI; never starts a model, MCP or hooks.
    #[test]
    fn fake_cli_child() {
        let Ok(mode) = std::env::var("CLAUDINAL_FAKE_CHILD_MODE") else {
            return;
        };
        match mode.as_str() {
            "exit" => std::process::exit(17),
            "init" => {
                println!("{{\"type\":\"system\",\"subtype\":\"init\"}}");
                std::process::exit(0)
            }
            "hang" => std::thread::sleep(Duration::from_secs(20)),
            "stdout_eof" => {
                #[cfg(windows)]
                unsafe {
                    use windows_sys::Win32::{
                        Foundation::CloseHandle,
                        System::Console::{GetStdHandle, STD_OUTPUT_HANDLE},
                    };
                    CloseHandle(GetStdHandle(STD_OUTPUT_HANDLE));
                }
                #[cfg(unix)]
                unsafe {
                    use std::os::fd::FromRawFd;
                    drop(std::fs::File::from_raw_fd(1));
                }
                std::thread::sleep(Duration::from_secs(20));
            }
            _ => std::process::exit(2),
        }
    }
    fn fake(mode: &str) -> (Child, ProcessTree) {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "proc::supervisor::tests::fake_cli_child",
                "--nocapture",
            ])
            .env("CLAUDINAL_FAKE_CHILD_MODE", mode)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        crate::child_process::hide_tokio_window(&mut command);
        let child = command.spawn().unwrap();
        let tree = ProcessTree::attach(&child).unwrap();
        (child, tree)
    }
    #[tokio::test]
    async fn observes_exit_without_output_and_keeps_code() {
        let (child, tree) = fake("exit");
        let (_stop, rx) = watch::channel(false);
        let status = tokio::time::timeout(Duration::from_secs(5), supervise(child, rx, tree))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status.code(), Some(17));
    }
    #[tokio::test]
    async fn stop_reaps_a_hung_child_without_child_mutex() {
        let (child, tree) = fake("hang");
        let (stop, rx) = watch::channel(false);
        let started = std::time::Instant::now();
        let task = tokio::spawn(supervise(child, rx, tree));
        stop.send(true).unwrap();
        let status = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(5));
        // Windows job termination can return exit code zero; wait still confirms reaping.
        assert!(status.code().is_some() || !status.success());
    }
    #[tokio::test]
    async fn drains_immediate_init_before_eof() {
        let (mut child, tree) = fake("init");
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let (stop, rx) = watch::channel(false);
        let task = tokio::spawn(supervise(child, rx, tree));
        let mut saw_init = false;
        while let Some(line) = super::super::transport::read_line(&mut stdout, 4096)
            .await
            .unwrap()
        {
            saw_init |= line.contains("\"subtype\":\"init\"");
        }
        let _ = stop.send(true);
        assert!(saw_init);
        assert!(task.await.unwrap().unwrap().success());
    }
    #[tokio::test]
    async fn stdout_eof_stops_and_reaps_a_child_that_did_not_exit() {
        let (mut child, tree) = fake("stdout_eof");
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let (stop, rx) = watch::channel(false);
        let task = tokio::spawn(supervise(child, rx, tree));
        tokio::time::timeout(Duration::from_secs(5), async {
            while super::super::transport::read_line(&mut stdout, 4096)
                .await
                .unwrap()
                .is_some()
            {}
        })
        .await
        .unwrap();
        stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn stop_revokes_before_cleanup_wait_and_only_once() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let (child, tree) = fake("hang");
        let (stop, rx) = watch::channel(false);
        let revocations = Arc::new(AtomicUsize::new(0));
        let captured = revocations.clone();
        let task = tokio::spawn(supervise_with_close(child, rx, tree, move || {
            captured.fetch_add(1, Ordering::SeqCst);
        }));
        stop.send(true).unwrap();
        // The callback runs before the supervisor's 50 ms grace/reap await.
        tokio::time::timeout(Duration::from_secs(2), async {
            while revocations.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(revocations.load(Ordering::SeqCst), 1);
        tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(revocations.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn unexpected_exit_revokes_captured_runtime_before_returning() {
        let (child, tree) = fake("exit");
        let (_stop, rx) = watch::channel(false);
        let mut captured = None;
        let status = supervise_with_close(child, rx, tree, || captured = Some("old-runtime"))
            .await
            .unwrap();
        assert_eq!(status.code(), Some(17));
        assert_eq!(captured, Some("old-runtime"));
    }

    #[tokio::test]
    async fn dropping_unpolled_supervision_revokes_before_process_cleanup() {
        let (child, tree) = fake("hang");
        let (_stop, rx) = watch::channel(false);
        let mut revoked = false;
        let supervision = supervise_with_close(child, rx, tree, || revoked = true);
        drop(supervision);
        assert!(revoked);
    }
}
