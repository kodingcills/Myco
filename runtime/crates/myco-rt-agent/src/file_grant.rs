use std::io::{self, Read};
use std::path::{Component, Path};

use rustix::fd::OwnedFd;
use rustix::fs::{CWD, Mode, OFlags, ResolveFlags, openat2};

#[derive(Debug)]
pub struct FileGrant(OwnedFd);

impl FileGrant {
    pub fn open(root: &Path) -> io::Result<Self> {
        if !root.is_absolute() {
            return Err(io::Error::other("grant root must be absolute"));
        }
        // A grant rooted at "/" is not a grant: it is the whole guest filesystem.
        // The tool description promises a bounded directory, so refuse the root
        // itself rather than silently granting everything (review must-fix 2).
        if root.parent().is_none() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "grant root must not be the filesystem root",
            ));
        }
        Ok(Self(openat2(
            CWD,
            root,
            OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::NO_SYMLINKS,
        )?))
    }

    pub fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        const LIMIT: usize = 1024 * 1024;
        if path.as_os_str().is_empty()
            || !path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "expected a grant-relative file path",
            ));
        }
        let fd = openat2(
            &self.0,
            path,
            OFlags::PATH | OFlags::CLOEXEC,
            Mode::empty(),
            ResolveFlags::BENEATH | ResolveFlags::NO_SYMLINKS | ResolveFlags::NO_XDEV,
        )?;
        let file = std::fs::File::from(fd);
        if !file.metadata()?.is_file() {
            return Err(io::Error::other("expected a regular file"));
        }
        use std::os::fd::AsRawFd;
        let file = std::fs::File::open(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        let mut bytes = Vec::new();
        file.take((LIMIT + 1) as u64).read_to_end(&mut bytes)?;
        if bytes.len() > LIMIT {
            return Err(io::Error::other("file exceeds 1 MiB limit"));
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{create_dir, write};
    use std::os::unix::fs::symlink;

    #[test]
    fn bounds_reads_to_regular_files_in_the_grant() {
        let base = std::env::temp_dir().join(format!("myco-file-grant-{}", std::process::id()));
        create_dir(&base).unwrap();
        let root = base.join("root");
        create_dir(&root).unwrap();
        write(root.join("state"), [0, 255]).unwrap();
        write(base.join("outside"), "outside").unwrap();
        symlink("../outside", root.join("link")).unwrap();
        create_dir(root.join("directory")).unwrap();
        write(root.join("large"), vec![0; 1024 * 1024 + 1]).unwrap();

        let grant = FileGrant::open(&root).unwrap();
        assert_eq!(grant.read(Path::new("state")).unwrap(), [0, 255]);
        for path in [
            "../outside",
            "/etc/passwd",
            "link",
            "directory",
            ".",
            "large",
        ] {
            assert!(grant.read(Path::new(path)).is_err(), "{path}");
        }
        std::fs::remove_dir_all(base).unwrap();
    }

    /// The root itself is not a grant: it would expose the whole guest filesystem.
    /// Covered transitively by the transport's fresh-agent assertion, but a direct
    /// test is what makes the refusal a property of this function (review residual
    /// risk 2).
    #[test]
    fn refuses_a_parentless_root() {
        let err = FileGrant::open(Path::new("/")).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(
            err.to_string().contains("filesystem root"),
            "error must name the reason: {err}"
        );
    }

    /// A relative root is refused before any syscall.
    #[test]
    fn refuses_a_relative_root() {
        let err = FileGrant::open(Path::new("relative/dir")).unwrap_err();
        // Pin the kind as well as the message. This shows the *absolute* guard is
        // what fired, but it does not fix the ordering: `"relative/dir".parent()`
        // is `Some("relative")`, so checking parent() first would still land here
        // with the same kind and message. Ordering is not pinned by any test.
        assert_eq!(err.kind(), io::ErrorKind::Other);
        assert!(err.to_string().contains("absolute"), "{err}");
    }
}
