//! Verified candidate archives outlive temporary parser jobs; they never replace the editor source.
use super::*;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParsedOutput {
    pub sha256: String,
    pub pages: usize,
    pub identity: Option<Value>,
}

impl ParsedOutput {
    pub fn validate(&self) -> Result<()> {
        let value = self.identity.as_ref().ok_or_else(|| {
            anyhow!("COURSEWARE_INVALID: candidate requires saved-source identity")
        })?;
        let identity = identity::SavedSourceIdentity::parse(&serde_json::to_vec(value)?)?;
        anyhow::ensure!(
            identity.matches_source(&self.sha256, self.pages)
                && value.get("mappingRevision").is_none(),
            "COURSEWARE_INVALID: candidate identity differs from output"
        );
        Ok(())
    }
}

fn archive_directory(data_dir: &Path) -> Result<PathBuf> {
    let root = data_dir.canonicalize()?;
    let directory = root.join("courseware-candidates");
    std::fs::create_dir_all(&directory)?;
    let directory = directory.canonicalize()?;
    anyhow::ensure!(
        directory.starts_with(&root),
        "COURSEWARE_INVALID: candidate archive escapes Host data"
    );
    Ok(directory)
}

pub fn verify_archive(data_dir: &Path, hash: &str) -> Result<()> {
    read_archive(data_dir, hash).map(|_| ())
}

pub fn read_archive(data_dir: &Path, hash: &str) -> Result<Vec<u8>> {
    anyhow::ensure!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "COURSEWARE_INVALID: invalid candidate output hash"
    );
    let path = archive_path(data_dir, hash)?;
    let file = open_source(data_dir, &path)?.file;
    let mut bytes = Vec::new();
    file.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_INPUT_BYTES && hex::encode(Sha256::digest(&bytes)) == hash,
        "COURSEWARE_CONFLICT: candidate archive bytes changed"
    );
    Ok(bytes)
}

pub fn verify_live_source(workspace: &Path, path: &Path, hash: &str) -> Result<()> {
    let mut bytes = Vec::new();
    open_source(workspace, path)?
        .file
        .take(MAX_INPUT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_INPUT_BYTES && hex::encode(Sha256::digest(&bytes)) == hash,
        "COURSEWARE_CONFLICT: live source differs from saved revision"
    );
    Ok(())
}

pub fn archive_path(data_dir: &Path, hash: &str) -> Result<PathBuf> {
    anyhow::ensure!(
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "COURSEWARE_INVALID: invalid candidate output hash"
    );
    let directory = archive_directory(data_dir)?;
    let path = directory.join(format!("{hash}.pptx"));
    open_source(data_dir, &path)?;
    Ok(path)
}

fn archive(data_dir: &Path, hash: &str, bytes: &[u8]) -> Result<()> {
    // shortcut: Retain rejected/orphaned archives until reference-aware cleanup is implemented.
    let directory = archive_directory(data_dir)?;
    let destination = directory.join(format!("{hash}.pptx"));
    let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        // Publish without replacing an existing archive, including concurrent writers.
        match std::fs::hard_link(&temporary, &destination) {
            Ok(()) => std::fs::File::open(&directory)?.sync_all()?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        verify_archive(data_dir, hash)
    })();
    let cleanup = std::fs::remove_file(&temporary);
    result?;
    cleanup?;
    Ok(())
}

impl Parser {
    pub(super) fn verified_online_source(
        &self,
        id: &str,
        workspace: &Path,
        expected_sha256: &str,
        expected_byte_length: u64,
    ) -> Result<(ParsedOutput, Vec<u8>)> {
        let (output, bytes) = self.verified_candidate_source(id, workspace)?;
        output.validate()?;
        anyhow::ensure!(
            expected_byte_length > 0
                && expected_byte_length <= 20 * 1024 * 1024
                && bytes.len() as u64 == expected_byte_length
                && output.sha256 == expected_sha256,
            "COURSEWARE_CONFLICT: online source bytes differ from pinned hash/length"
        );
        Ok((output, bytes))
    }

    pub fn archive_online_snapshot(
        &self,
        id: &str,
        workspace: &Path,
        data_dir: &Path,
        expected_sha256: &str,
        expected_byte_length: u64,
    ) -> Result<ParsedOutput> {
        let (output, bytes) =
            self.verified_online_source(id, workspace, expected_sha256, expected_byte_length)?;
        archive(data_dir, &output.sha256, &bytes)?;
        Ok(output)
    }

    pub fn archive_candidate(
        &self,
        id: &str,
        workspace: &Path,
        data_dir: &Path,
        expected_sha256: &str,
    ) -> Result<ParsedOutput> {
        let (output, bytes) = self.verified_candidate_source(id, workspace)?;
        output.validate()?;
        anyhow::ensure!(
            output.sha256 == expected_sha256,
            "COURSEWARE_CONFLICT: parsed candidate differs from generated bytes"
        );
        archive(data_dir, &output.sha256, &bytes)?;
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archives_replay_without_overwrite_and_detect_missing_or_modified_bytes() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = b"immutable candidate";
        let hash = hex::encode(Sha256::digest(bytes));
        archive(directory.path(), &hash, bytes).unwrap();
        archive(directory.path(), &hash, bytes).unwrap();
        let path = archive_directory(directory.path())
            .unwrap()
            .join(format!("{hash}.pptx"));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::write(&path, b"tampered").unwrap();
        assert!(verify_archive(directory.path(), &hash).is_err());
        assert!(archive(directory.path(), &hash, bytes).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"tampered");
        std::fs::remove_file(path).unwrap();
        assert!(verify_archive(directory.path(), &hash).is_err());
        assert!(verify_archive(directory.path(), "../escape").is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn archive_symlinks_cannot_escape_host_data() {
        use std::os::unix::fs::symlink;
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        symlink(
            outside.path(),
            directory.path().join("courseware-candidates"),
        )
        .unwrap();
        let hash = hex::encode(Sha256::digest(b"candidate"));
        assert!(archive(directory.path(), &hash, b"candidate").is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}
