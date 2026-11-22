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
    Command::new(command)
        .args(args)
        .env_remove("MYCO_RT_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;

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
