//! Locate the Myco workspace (the directory containing `runtime/guest/boot.sh`)
//! without requiring the caller to know the repo layout or `cd` into it (RT-020).
//!
//! Resolution order: `$MYCO_HOME`, then walk up from the current directory, then
//! walk up from the running executable (a binary built in-tree lives under
//! `runtime/target/…`, so this finds the repo wherever the agent was launched).

use std::path::{Path, PathBuf};

const MARKER: [&str; 3] = ["runtime", "guest", "boot.sh"];

fn is_workspace(dir: &Path) -> bool {
    MARKER.iter().fold(dir.to_path_buf(), |p, s| p.join(s)).is_file()
}

fn walk_up(start: &Path) -> Option<PathBuf> {
    start.ancestors().find(|d| is_workspace(d)).map(Path::to_path_buf)
}

/// Pure resolution over explicit inputs (testable without touching the process env).
pub fn resolve(
    home: Option<&Path>,
    cwd: Option<&Path>,
    exe: Option<&Path>,
) -> Result<PathBuf, String> {
    if let Some(h) = home {
        return if is_workspace(h) {
            Ok(h.to_path_buf())
        } else {
            Err(format!(
                "MYCO_HOME={} does not contain runtime/guest/boot.sh; point it at a Myco checkout \
                 or unset it",
                h.display()
            ))
        };
    }
    cwd.and_then(walk_up)
        .or_else(|| exe.and_then(walk_up))
        .ok_or_else(|| {
            "no Myco workspace found (looked for runtime/guest/boot.sh upward from the current \
             directory and from this binary). Fix: set MYCO_HOME=/path/to/Myco"
                .to_string()
        })
}

/// Resolve from the real process environment.
pub fn discover() -> Result<PathBuf, String> {
    let home = std::env::var_os("MYCO_HOME").map(PathBuf::from);
    let cwd = std::env::current_dir().ok();
    let exe = std::env::current_exe().ok().and_then(|p| p.canonicalize().ok());
    resolve(home.as_deref(), cwd.as_deref(), exe.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fake_ws(root: &Path) {
        let g = root.join("runtime/guest");
        fs::create_dir_all(&g).unwrap();
        fs::write(g.join("boot.sh"), "").unwrap();
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myco-ws-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn finds_workspace_from_nested_cwd() {
        let r = tmp("nested");
        fake_ws(&r);
        let deep = r.join("a/b/c");
        fs::create_dir_all(&deep).unwrap();
        assert_eq!(resolve(None, Some(&deep), None).unwrap(), r);
    }

    #[test]
    fn falls_back_to_executable_location_when_cwd_is_elsewhere() {
        let r = tmp("exe");
        fake_ws(&r);
        let exe = r.join("runtime/target/debug/myco-rt-mcp");
        let elsewhere = tmp("exe-elsewhere");
        assert_eq!(resolve(None, Some(&elsewhere), Some(&exe)).unwrap(), r);
    }

    #[test]
    fn env_home_wins_and_is_validated() {
        let r = tmp("home");
        fake_ws(&r);
        let other = tmp("home-other");
        assert_eq!(resolve(Some(&r), Some(&other), None).unwrap(), r);
        let err = resolve(Some(&other), None, None).unwrap_err();
        assert!(err.contains("MYCO_HOME"), "{err}");
    }

    /// A bad `MYCO_HOME` is an error, not a fall-through.
    ///
    /// This is a deliberate choice worth pinning: if an operator sets `MYCO_HOME`
    /// to the wrong path, silently using a *different* workspace discovered from
    /// the cwd would run against a checkout they did not choose. Failing loudly is
    /// the safer default, and this test is what makes it a property rather than an
    /// accident of the current `if let` ordering.
    #[test]
    fn a_bad_myco_home_errors_instead_of_falling_through() {
        let good = tmp("badhome-good");
        fake_ws(&good);
        let bad = tmp("badhome-bad"); // exists, but is not a workspace
        let err = resolve(Some(&bad), Some(&good), None).unwrap_err();
        assert!(
            err.contains("MYCO_HOME"),
            "a bad MYCO_HOME must be named, not silently ignored: {err}"
        );
    }

    /// The nearest ancestor wins when workspaces are nested.
    ///
    /// `walk_up` uses `ancestors().find(..)`, so it takes the first (closest)
    /// match. If that ever became `filter(..).last()`, a deeply nested workspace
    /// would resolve to an outer one and run the wrong checkout.
    #[test]
    fn the_nearest_enclosing_workspace_wins() {
        let outer = tmp("nest-outer");
        fake_ws(&outer);
        let inner = outer.join("inner");
        fake_ws(&inner);
        let deep = inner.join("x/y");
        fs::create_dir_all(&deep).unwrap();

        assert_eq!(
            resolve(None, Some(&deep), None).unwrap(),
            inner,
            "the closest workspace must win, not the outermost"
        );
    }

    /// The marker is a file check, not a directory check: a workspace-shaped
    /// directory tree without `boot.sh` is not a workspace.
    #[test]
    fn a_directory_chain_without_the_marker_is_not_a_workspace() {
        let r = tmp("nomarker");
        fs::create_dir_all(r.join("runtime/guest")).unwrap(); // dir exists, boot.sh does not
        let err = resolve(None, Some(&r), Some(&r)).unwrap_err();
        assert!(
            err.contains("MYCO_HOME=/path/to/Myco"),
            "a missing marker must produce the remediation message: {err}"
        );
    }

    #[test]
    fn missing_workspace_error_names_the_fix() {
        let nowhere = tmp("none");
        let err = resolve(None, Some(&nowhere), Some(&nowhere.join("bin"))).unwrap_err();
        assert!(err.contains("MYCO_HOME=/path/to/Myco"), "{err}");
    }
}
