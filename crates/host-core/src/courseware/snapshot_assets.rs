//! Host-owned media archives; input paths are never persisted in snapshot records.
use super::*;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;

fn directory(data_dir: &Path) -> Result<PathBuf> {
    let root = data_dir.canonicalize()?;
    let path = root.join("courseware-assets");
    std::fs::create_dir_all(&path)?;
    let path = path.canonicalize()?;
    anyhow::ensure!(
        path.starts_with(root),
        "COURSEWARE_INVALID: asset archive escapes Host data"
    );
    Ok(path)
}

fn path(data_dir: &Path, hash: &str) -> Result<PathBuf> {
    anyhow::ensure!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "COURSEWARE_INVALID: invalid asset hash"
    );
    Ok(directory(data_dir)?.join(format!("{hash}.bin")))
}

fn read_verified(root: &Path, path: &Path, hash: &str) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_source(root, path).map_err(|_| anyhow!("COURSEWARE_INVALID: fixed audio must be a bounded regular file within its allowed root"))?
        .file
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(
        !bytes.is_empty()
            && bytes.len() as u64 <= MAX_INPUT_BYTES
            && hex::encode(Sha256::digest(&bytes)) == hash,
        "COURSEWARE_CONFLICT: fixed audio asset bytes differ"
    );
    Ok(bytes)
}

pub fn read(data_dir: &Path, hash: &str) -> Result<Vec<u8>> {
    read_verified(data_dir, &path(data_dir, hash)?, hash)
}

pub fn verify(data_dir: &Path, hash: &str) -> Result<(PathBuf, u64)> {
    let path = path(data_dir, hash)?;
    let bytes = read_verified(data_dir, &path, hash)?;
    Ok((path, bytes.len() as u64))
}

pub fn archive(data_dir: &Path, workspace: &Path, input: &Path, hash: &str) -> Result<u64> {
    let bytes = read_verified(workspace, input, hash)?;
    archive_bytes(data_dir, hash, &bytes)
}

pub fn archive_bytes(data_dir: &Path, hash: &str, bytes: &[u8]) -> Result<u64> {
    write_archive(data_dir, hash, bytes, false)
}

pub fn restore_bytes(data_dir: &Path, hash: &str, bytes: &[u8]) -> Result<u64> {
    write_archive(data_dir, hash, bytes, true)
}

fn write_archive(data_dir: &Path, hash: &str, bytes: &[u8], restore: bool) -> Result<u64> {
    let destination = path(data_dir, hash)?;
    anyhow::ensure!(
        !bytes.is_empty()
            && bytes.len() as u64 <= MAX_INPUT_BYTES
            && hex::encode(Sha256::digest(bytes)) == hash,
        "COURSEWARE_INVALID: asset bytes differ from expected hash"
    );
    if restore {
        match std::fs::symlink_metadata(&destination) {
            Ok(metadata) => anyhow::ensure!(
                metadata.file_type().is_file(),
                "COURSEWARE_INVALID: archive restoration requires a regular file"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let directory = destination.parent().unwrap();
    let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<u64> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        // shortcut: Orphaned archives are retained until reference-aware cleanup is implemented.
        if restore {
            std::fs::rename(&temporary, &destination)?;
            std::fs::File::open(directory)?.sync_all()?;
        } else {
            match std::fs::hard_link(&temporary, &destination) {
                Ok(()) => std::fs::File::open(directory)?.sync_all()?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(verify(data_dir, hash)?.1)
    })();
    let cleanup = std::fs::remove_file(&temporary);
    let size = result?;
    if let Err(error) = cleanup {
        if !restore || error.kind() != std::io::ErrorKind::NotFound {
            return Err(error.into());
        }
    }
    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_restore_repairs_only_expected_bytes_and_leaves_ordinary_archiving_strict() {
        let host = tempfile::tempdir().unwrap();
        let bytes = b"original media bytes";
        let hash = hex::encode(Sha256::digest(bytes));
        restore_bytes(host.path(), &hash, bytes).unwrap();
        let destination = path(host.path(), &hash).unwrap();
        std::fs::write(&destination, b"corrupt").unwrap();
        assert!(archive_bytes(host.path(), &hash, bytes).is_err());
        assert!(restore_bytes(host.path(), &hash, b"different result").is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"corrupt");
        assert_eq!(
            restore_bytes(host.path(), &hash, bytes).unwrap(),
            bytes.len() as u64
        );
        assert_eq!(std::fs::read(&destination).unwrap(), bytes);
        std::fs::remove_file(&destination).unwrap();
        restore_bytes(host.path(), &hash, bytes).unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), bytes);
        assert_eq!(
            std::fs::read_dir(destination.parent().unwrap())
                .unwrap()
                .count(),
            1
        );
        std::fs::remove_file(&destination).unwrap();
        std::fs::create_dir(&destination).unwrap();
        assert!(restore_bytes(host.path(), &hash, bytes).is_err());
        assert!(destination.is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn explicit_restore_rejects_symlink_destinations_and_escaped_archive_directories() {
        use std::os::unix::fs::symlink;
        let host = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let bytes = b"original media bytes";
        let hash = hex::encode(Sha256::digest(bytes));
        let other = outside.path().join("keep.bin");
        std::fs::write(&other, b"outside data").unwrap();
        let destination = path(host.path(), &hash).unwrap();
        symlink(&other, &destination).unwrap();
        assert!(restore_bytes(host.path(), &hash, bytes).is_err());
        assert!(destination.is_symlink());
        assert_eq!(std::fs::read(&other).unwrap(), b"outside data");
        let escaped = tempfile::tempdir().unwrap();
        symlink(outside.path(), escaped.path().join("courseware-assets")).unwrap();
        assert!(restore_bytes(escaped.path(), &hash, bytes).is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 1);
    }

    #[test]
    fn fixed_assets_survive_input_edits_and_never_overwrite_corruption() {
        let host = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let input = workspace.path().join("voice.wav");
        let bytes = b"fixed audio test bytes";
        let hash = hex::encode(Sha256::digest(bytes));
        std::fs::write(&input, bytes).unwrap();
        assert_eq!(
            archive(host.path(), workspace.path(), &input, &hash).unwrap(),
            bytes.len() as u64
        );
        archive(host.path(), workspace.path(), &input, &hash).unwrap();
        std::fs::write(&input, b"edited").unwrap();
        assert_eq!(verify(host.path(), &hash).unwrap().1, bytes.len() as u64);
        assert!(archive(host.path(), workspace.path(), &input, &hash).is_err());
        let (fixed, _) = verify(host.path(), &hash).unwrap();
        std::fs::write(&fixed, b"corrupt").unwrap();
        std::fs::write(&input, bytes).unwrap();
        assert!(archive(host.path(), workspace.path(), &input, &hash).is_err());
        assert_eq!(std::fs::read(fixed).unwrap(), b"corrupt");
        assert!(archive(host.path(), host.path(), &input, &hash).is_err());
        assert!(verify(host.path(), "../escape").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn asset_symlinks_cannot_escape_the_workspace_or_host_archive() {
        use std::os::unix::fs::symlink;
        let host = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let hash = "a".repeat(64);
        symlink(outside.path(), host.path().join("courseware-assets")).unwrap();
        assert!(verify(host.path(), &hash).is_err());
        let input = workspace.path().join("voice.wav");
        let other = outside.path().join("voice.wav");
        std::fs::write(&other, b"audio").unwrap();
        symlink(other, &input).unwrap();
        assert!(read_verified(workspace.path(), &input, &hash).is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 1);
    }
}
