use std::collections::HashMap;
use std::io;
use std::process::{Child, Command, ExitStatus, Stdio};

#[derive(Default)]
pub struct Processes {
    children: HashMap<uuid::Uuid, ManagedProcess>,
}

struct ManagedProcess {
    command: String,
    args: Vec<String>,
    child: Option<Child>,
    status: Option<ExitStatus>,
}

impl Processes {
    pub fn launch(&mut self, command: String, args: Vec<String>) -> io::Result<uuid::Uuid> {
        let child = spawn(&command, &args)?;
        let handle = uuid::Uuid::new_v4();
        self.children.insert(
            handle,
            ManagedProcess {
                command,
                args,
                child: Some(child),
                status: None,
            },
        );
        Ok(handle)
    }

    pub fn kill(&mut self, handle: uuid::Uuid) -> io::Result<ExitStatus> {
        let process = self.lookup(handle)?;
        if let Some(child) = &mut process.child {
            let status = match child.try_wait()? {
                Some(status) => status,
                None => {
                    child.kill()?;
                    child.wait()?
                }
            };
            process.child = None;
            process.status = Some(status);
        }
        process
            .status
            .ok_or_else(|| io::Error::other("process has no exit status"))
    }

    pub fn relaunch(&mut self, handle: uuid::Uuid) -> io::Result<uuid::Uuid> {
        let process = self.lookup(handle)?;
        if process.child.is_some() {
            return Err(io::Error::other("kill process before relaunch"));
        }
        let command = process.command.clone();
        let args = process.args.clone();
        let replacement = self.launch(command, args)?;
        self.children.remove(&handle);
        Ok(replacement)
    }

    fn lookup(&mut self, handle: uuid::Uuid) -> io::Result<&mut ManagedProcess> {
        self.children
            .get_mut(&handle)
            .ok_or_else(|| io::Error::other("unknown process handle"))
    }
}

impl Drop for Processes {
    fn drop(&mut self) {
        for process in self.children.values_mut() {
            if let Some(child) = &mut process.child {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

pub fn spawn(command: &str, args: &[String]) -> io::Result<Child> {
    spawn_with_introspection(command, args, std::env::var("MYCO_INTROSPECTION_FILE").ok().as_deref())
}

/// `spawn` with the introspection path passed in rather than read from the
/// agent's environment (so tests need not mutate process-wide env).
pub fn spawn_with_introspection(command: &str, args: &[String], introspection: Option<&str>) -> io::Result<Child> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .env_remove("MYCO_RT_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some((key, value)) =
        app_state_file_env(introspection, std::env::var_os(APP_STATE_FILE_ENV).is_some())
    {
        cmd.env(key, value);
    }
    cmd.spawn()
}

/// The env var an instrumented app publishes its state to (ADR-0016: Dogfood's
/// myco-todo reads `$MYCO_TODO_STATE_FILE`).
pub const APP_STATE_FILE_ENV: &str = "MYCO_TODO_STATE_FILE";

/// ADR-0016 maps the app's state-file variable to the runtime's introspection
/// file "at the runtime session layer"; TIF-120 found nothing did, so a
/// launched app never published and observe had no `entry_field` to click. When
/// the session's introspection channel is on, a launched app gets
/// `MYCO_TODO_STATE_FILE` pointing at the file `observe` reads, unless the
/// environment already names one (an explicit choice wins).
pub fn app_state_file_env(introspection: Option<&str>, already_set: bool) -> Option<(&'static str, String)> {
    match introspection {
        Some(path) if !path.is_empty() && !already_set => Some((APP_STATE_FILE_ENV, path.to_string())),
        _ => None,
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

    #[test]
    fn launched_apps_publish_to_the_introspection_file() {
        assert_eq!(
            app_state_file_env(Some("/tmp/todo.json"), false),
            Some((APP_STATE_FILE_ENV, "/tmp/todo.json".to_string())),
            "channel on: the app must be told where observe will read"
        );
        assert_eq!(app_state_file_env(None, false), None, "channel off: nothing set");
        assert_eq!(app_state_file_env(Some(""), false), None, "empty path is not a channel");
        assert_eq!(app_state_file_env(Some("/tmp/todo.json"), true), None, "an explicit value wins");
    }

    /// End to end through a real child: the launched process sees the variable.
    #[test]
    fn spawned_child_receives_the_state_file_variable() {
        let dir = std::env::temp_dir().join(format!("myco-spawn-env-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let out = dir.join("seen");
        let mut child = spawn_with_introspection(
            "sh",
            &["-c".into(), format!("printf %s \"${APP_STATE_FILE_ENV}\" > {}", out.display())],
            Some("/tmp/introspect-me.json"),
        )
        .unwrap();
        child.wait().unwrap();
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "/tmp/introspect-me.json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kills_reaps_and_relaunches_only_owned_children() {
        let mut processes = Processes::default();
        let first = processes.launch("sleep".into(), vec!["60".into()]).unwrap();
        assert!(processes.relaunch(first).is_err());
        let status = processes.kill(first).unwrap();
        assert_eq!(status.signal(), Some(9));
        assert_eq!(processes.kill(first).unwrap(), status);
        let second = processes.relaunch(first).unwrap();
        assert_ne!(first, second);
        assert!(processes.kill(first).is_err());
        assert_eq!(processes.kill(second).unwrap().signal(), Some(9));
    }
}
