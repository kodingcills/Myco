use std::io::{self, Read};
use std::path::{Component, Path};

use rustix::fd::OwnedFd;
use rustix::fs::{CWD, FileType, Mode, OFlags, ResolveFlags, fcntl_setfl, fstat, ftruncate, openat2};

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

    /// Write/replace a regular file inside the grant (RT-017).
    ///
    /// Same confinement as `read`: grant-relative, no symlink traversal (any
    /// component), no mount crossing. On top of that, a write only ever lands on a
    /// regular file with a single link:
    /// - A FIFO, device, socket or directory is refused. An existing target is
    ///   probed with `O_PATH` first, so a device is refused without being opened
    ///   for write; the write open is `O_NONBLOCK|O_NOCTTY` regardless, so a FIFO
    ///   can never block the single-threaded agent (which wedged the whole session
    ///   until `reset`). New files are created `O_EXCL`.
    /// - `nlink > 1` is refused, so a hard link planted in the grant cannot be used
    ///   to truncate a file that lives outside it.
    /// - Content is capped at `WRITE_LIMIT` (1 MiB, matching `read`).
    ///
    /// Not atomic: the file is truncated, then written. ENOSPC or an agent crash
    /// mid-write leaves a short file. The caller confirms with a `read` back,
    /// which is what makes the write verifiable rather than assumed.
    pub fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        if bytes.len() > WRITE_LIMIT {
            return Err(io::Error::other("content exceeds 1 MiB limit"));
        }
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
        const RESOLVE: ResolveFlags = ResolveFlags::BENEATH
            .union(ResolveFlags::NO_SYMLINKS)
            .union(ResolveFlags::NO_XDEV);
        // Probe first with O_PATH, which opens nothing for I/O: an existing device
        // node (a watchdog, say, under an odd grant root) is refused WITHOUT ever
        // being opened for write, so no open-time side effect can fire.
        let fd = match openat2(&self.0, path, OFlags::PATH | OFlags::CLOEXEC, Mode::empty(), RESOLVE) {
            Ok(probe) => {
                require_single_link_regular(&fstat(&probe)?)?;
                // Reopen the SAME inode for writing via its fd, never by path
                // again, so a swap between probe and open cannot redirect it.
                // No O_TRUNC: truncation waits until the target is re-checked.
                use std::os::fd::AsRawFd;
                openat2(
                    CWD,
                    format!("/proc/self/fd/{}", probe.as_raw_fd()).as_str(),
                    OFlags::WRONLY | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC,
                    Mode::empty(),
                    ResolveFlags::empty(),
                )?
            }
            // A new file: O_EXCL so it is created here and now, never an existing
            // object that appeared after the probe.
            Err(rustix::io::Errno::NOENT) => openat2(
                &self.0,
                path,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NONBLOCK | OFlags::NOCTTY | OFlags::CLOEXEC,
                Mode::from_bits_truncate(0o644),
                RESOLVE,
            )?,
            Err(e) => return Err(e.into()),
        };
        // Re-check on the fd we will actually write (definitive, race-free).
        require_single_link_regular(&fstat(&fd)?)?;
        fcntl_setfl(&fd, OFlags::empty())?;
        ftruncate(&fd, 0)?;
        let mut file = std::fs::File::from(fd);
        use std::io::Write;
        file.write_all(bytes)
    }
}

/// A write lands only on a regular file with exactly one link: FIFOs, devices,
/// sockets and directories are refused, and so is a hard link that could alias a
/// file outside the grant.
fn require_single_link_regular(stat: &rustix::fs::Stat) -> io::Result<()> {
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "expected a regular file"));
    }
    if stat.st_nlink != 1 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "refusing to write a file with more than one hard link",
        ));
    }
    Ok(())
}

/// Largest content `write` accepts, matching `read`'s cap.
pub const WRITE_LIMIT: usize = 1024 * 1024;

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

#[cfg(test)]
mod write_tests {
    use super::*;
    use std::fs::{create_dir, read_to_string};

    fn grant(root: &Path) -> FileGrant {
        FileGrant::open(root).expect("grant")
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("myco-fg-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        create_dir(&p).expect("mkdir");
        p
    }

    #[test]
    fn writes_a_new_file_and_reads_it_back() {
        let root = tmp("write");
        let g = grant(&root);
        g.write(Path::new("state.json"), b"{\"n\":1}").expect("write");
        assert_eq!(read_to_string(root.join("state.json")).unwrap(), "{\"n\":1}");
        assert_eq!(g.read(Path::new("state.json")).unwrap(), b"{\"n\":1}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_replaces_existing_content() {
        let root = tmp("replace");
        std::fs::write(root.join("f"), "old").unwrap();
        let g = grant(&root);
        g.write(Path::new("f"), b"new").expect("write");
        assert_eq!(read_to_string(root.join("f")).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A shorter replacement must not leave the old tail behind (proves TRUNC).
    #[test]
    fn a_shorter_write_leaves_no_stale_tail() {
        let root = tmp("shorter");
        std::fs::write(root.join("f"), "a much longer old body").unwrap();
        grant(&root).write(Path::new("f"), b"new").expect("write");
        assert_eq!(read_to_string(root.join("f")).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A final-component symlink pointing outside the grant is refused, and the
    /// outside file is untouched. (Exercises NO_SYMLINKS/BENEATH; `..` alone is
    /// stopped by the component check before openat2 runs.)
    #[test]
    fn write_refuses_a_final_symlink_out_of_the_grant() {
        let root = tmp("sym-final");
        let outside = tmp("sym-final-outside");
        std::fs::write(outside.join("target"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.join("target"), root.join("link")).unwrap();
        assert!(grant(&root).write(Path::new("link"), b"pwned").is_err());
        assert_eq!(read_to_string(outside.join("target")).unwrap(), "keep");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// The same through an intermediate directory symlink.
    #[test]
    fn write_refuses_an_intermediate_symlink_out_of_the_grant() {
        let root = tmp("sym-mid");
        let outside = tmp("sym-mid-outside");
        std::os::unix::fs::symlink(&outside, root.join("dir")).unwrap();
        assert!(grant(&root).write(Path::new("dir/new"), b"pwned").is_err());
        assert!(!outside.join("new").exists(), "nothing may be created outside the grant");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// A FIFO with no reader must fail fast, not block the agent.
    #[test]
    fn write_to_a_fifo_fails_fast_instead_of_blocking() {
        let root = tmp("fifo");
        rustix::fs::mknodat(
            CWD,
            root.join("pipe").as_path(),
            FileType::Fifo,
            Mode::from_bits_truncate(0o644),
            0,
        )
        .unwrap();
        let started = std::time::Instant::now();
        assert!(grant(&root).write(Path::new("pipe"), b"x").is_err());
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "write blocked on a FIFO");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_refuses_a_directory() {
        let root = tmp("dir");
        create_dir(root.join("sub")).unwrap();
        assert!(grant(&root).write(Path::new("sub"), b"x").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A hard link in the grant to a file outside it must not be truncated.
    #[test]
    fn write_refuses_a_hard_linked_file() {
        let root = tmp("hardlink");
        let outside = tmp("hardlink-outside");
        std::fs::write(outside.join("secret"), "keep").unwrap();
        std::fs::hard_link(outside.join("secret"), root.join("alias")).unwrap();
        let err = grant(&root).write(Path::new("alias"), b"x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(read_to_string(outside.join("secret")).unwrap(), "keep");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn write_refuses_absolute_dot_and_empty_paths() {
        let root = tmp("paths");
        let g = grant(&root);
        for bad in ["/etc/passwd", ".", "./f", ""] {
            let err = g.write(Path::new(bad), b"x").unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "{bad:?}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_refuses_content_over_the_limit() {
        let root = tmp("big");
        let err = grant(&root).write(Path::new("f"), &vec![0u8; WRITE_LIMIT + 1]).unwrap_err();
        assert!(err.to_string().contains("1 MiB"), "{err}");
        assert!(!root.join("f").exists(), "an oversize write must not create the file");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_refuses_parent_traversal() {
        let root = tmp("escape");
        let g = grant(&root);
        let err = g.write(Path::new("../outside"), b"x").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
        assert!(!root.parent().unwrap().join("outside").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
