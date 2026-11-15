//! Recoverable Host-owned PPTX/teaching pair; authority migration is mounted separately.
use crate::db::courseware_projects::portable::{Media, Teaching, MAX_MEDIA_BYTES};
use anyhow::{anyhow, ensure, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

const SOURCE: &str = "lesson.pptx";
const TEACHING: &str = "lesson.teaching.json";
const MAX_SOURCE: u64 = 50 * 1024 * 1024;
const MAX_TEACHING: u64 = 8 * 1024 * 1024;
const MAX_JOURNAL: u64 = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Revision {
    pub version: u8,
    pub commit_id: uuid::Uuid,
    pub source_sha256: String,
    pub teaching_sha256: String,
}

impl Revision {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1
                && !self.commit_id.is_nil()
                && valid_hash(&self.source_sha256)
                && valid_hash(&self.teaching_sha256),
            "COURSEWARE_INVALID: invalid project commit revision"
        );
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending {
    version: u8,
    previous: Option<Revision>,
    next: Revision,
}

// Retained directory handles prevent parent-path symlink swaps from redirecting I/O.
struct Directory(File);
impl Directory {
    fn open(path: &Path) -> Result<Self> {
        Ok(Self(
            OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY)
                .open(path)?,
        ))
    }
    fn path(&self, name: &str) -> PathBuf {
        assert!(!name.is_empty() && !name.contains('/') && name != "." && name != "..");
        PathBuf::from(format!("/proc/self/fd/{}/{}", self.0.as_raw_fd(), name))
    }
    fn child(&self, name: &str) -> Result<Self> {
        let path = self.path(name);
        match std::fs::create_dir(&path) {
            Ok(()) => self.0.sync_all()?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        Self::open(&path)
    }
    fn read(&self, name: &str, limit: u64) -> Result<Option<Vec<u8>>> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(self.path(name))
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        ensure!(
            file.metadata()?.is_file() && file.metadata()?.len() <= limit,
            "COURSEWARE_INVALID: bounded regular project file required"
        );
        let mut bytes = Vec::new();
        file.take(limit + 1).read_to_end(&mut bytes)?;
        ensure!(
            bytes.len() as u64 <= limit,
            "COURSEWARE_INVALID: project file grew beyond limit"
        );
        Ok(Some(bytes))
    }
    fn create(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.path(name))?;
        file.write_all(bytes)?;
        file.sync_all()?;
        self.0.sync_all()?;
        Ok(())
    }
    fn publish(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let temporary = format!("{}.tmp", uuid::Uuid::new_v4());
        self.create(&temporary, bytes)?;
        let result = std::fs::hard_link(self.path(&temporary), self.path(name));
        let _ = std::fs::remove_file(self.path(&temporary));
        result?;
        self.0.sync_all()?;
        Ok(())
    }
    fn move_without_replace(
        &self,
        name: &str,
        destination: &Directory,
        target: &str,
    ) -> Result<()> {
        let source = std::ffi::CString::new(name)?;
        let target = std::ffi::CString::new(target)?;
        // SAFETY: directory descriptors and NUL-terminated names remain alive throughout the syscall.
        let result = unsafe {
            libc::renameat2(
                self.0.as_raw_fd(),
                source.as_ptr(),
                destination.0.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        self.0.sync_all()?;
        destination.0.sync_all()?;
        Ok(())
    }
    fn replace(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let temporary = format!("{}.tmp", uuid::Uuid::new_v4());
        self.create(&temporary, bytes)?;
        let result = std::fs::rename(self.path(&temporary), self.path(name));
        if result.is_err() {
            let _ = std::fs::remove_file(self.path(&temporary));
        }
        result?;
        self.0.sync_all()?;
        Ok(())
    }
    fn remove(&self, name: &str) -> Result<()> {
        std::fs::remove_file(self.path(name))?;
        self.0.sync_all()?;
        Ok(())
    }
}

pub struct ProjectCommitStore {
    root: Directory,
    metadata: Directory,
    objects: Directory,
    displaced: Directory,
    media: Directory,
    _lock: File,
    #[cfg(test)]
    fail_after: Option<usize>,
    #[cfg(test)]
    boundaries: usize,
}

pub struct CommittedFiles {
    pub revision: Revision,
    pub source: Vec<u8>,
    pub teaching: Vec<u8>,
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl ProjectCommitStore {
    /// The caller supplies an authorized existing project directory, never a renderer path.
    #[cfg(test)]
    pub fn open(root: &Path) -> Result<Self> {
        Self::from_directory(Directory::open(&root.canonicalize()?)?)
    }
    /// Anchor every relative component before journal recovery can modify project files.
    pub fn open_in_workspace(workspace: &Path, root: &Path) -> Result<Self> {
        let workspace = workspace.canonicalize()?;
        let relative = root.strip_prefix(&workspace)?;
        let mut directory = Directory::open(&workspace)?;
        for component in relative.components() {
            let std::path::Component::Normal(name) = component else {
                anyhow::bail!("COURSEWARE_INVALID: invalid portable project directory");
            };
            let name = name
                .to_str()
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: non-UTF8 project directory"))?;
            directory = Directory::open(&directory.path(name))?;
        }
        Self::from_directory(directory)
    }
    fn from_directory(root: Directory) -> Result<Self> {
        let metadata = root.child(".deckwise")?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(metadata.path("writer.lock"))?;
        ensure!(
            lock.metadata()?.is_file(),
            "COURSEWARE_INVALID: invalid project writer lock"
        );
        lock.try_lock()
            .map_err(|_| anyhow!("COURSEWARE_CONFLICT: project is already open for commit"))?;
        let objects = metadata.child("objects")?;
        let displaced = metadata.child("displaced")?;
        let media = root.child("media")?;
        let device = std::os::unix::fs::MetadataExt::dev(&root.0.metadata()?);
        ensure!(
            [&metadata, &objects, &displaced, &media]
                .iter()
                .all(|directory| directory
                    .0
                    .metadata()
                    .is_ok_and(|value| std::os::unix::fs::MetadataExt::dev(&value) == device)),
            "COURSEWARE_INVALID: project commit files must share a filesystem"
        );
        let mut store = Self {
            root,
            metadata,
            objects,
            displaced,
            media,
            _lock: lock,
            #[cfg(test)]
            fail_after: None,
            #[cfg(test)]
            boundaries: 0,
        };
        store.recover()?;
        Ok(store)
    }
    /// Publishes a new copy under the authorized workspace; never overwrites a destination.
    pub fn create_copy(
        workspace: &Path,
        content: &Teaching,
        source: &[u8],
        mut load_media: impl FnMut(&Media) -> Result<Vec<u8>>,
    ) -> Result<PathBuf> {
        content.validate(content.commit_id, &digest(source))?;
        let workspace_path = workspace.canonicalize()?;
        let parent = Directory::open(&workspace_path)?.child("courseware-copies")?;
        let name = format!("{}.deckwise", content.project_uuid);
        std::fs::create_dir(parent.path(&name))?;
        parent.0.sync_all()?;
        let mut copy = Self::from_directory(Directory::open(&parent.path(&name))?)?;
        for asset in &content.media {
            copy.archive_media(asset, &load_media(asset)?)?;
        }
        copy.commit(
            None,
            content.commit_id,
            source,
            &serde_json::to_vec(content)?,
        )?;
        ensure!(
            copy.current()?.is_some(),
            "COURSEWARE_CONFLICT: copied project is not committed"
        );
        let result = workspace_path.join("courseware-copies").join(name);
        let current = Directory::open(&result)?;
        use std::os::unix::fs::MetadataExt;
        ensure!(
            current.0.metadata()?.ino() == copy.root.0.metadata()?.ino()
                && current.0.metadata()?.dev() == copy.root.0.metadata()?.dev(),
            "COURSEWARE_CONFLICT: copied project directory moved"
        );
        Ok(result)
    }
    fn boundary(&mut self) -> Result<()> {
        #[cfg(test)]
        {
            self.boundaries += 1;
            if self.fail_after == Some(self.boundaries)
                && std::env::var_os("DECKWISE_COMMIT_CRASH_PROBE").is_some()
            {
                std::process::exit(72);
            }
            ensure!(
                self.fail_after != Some(self.boundaries),
                "injected project commit interruption"
            );
        }
        Ok(())
    }
    fn index(&self) -> Result<Option<Revision>> {
        self.metadata
            .read("current.json", MAX_JOURNAL)?
            .map(|bytes| {
                let revision: Revision = serde_json::from_slice(&bytes)?;
                revision.validate()?;
                Ok(revision)
            })
            .transpose()
    }
    fn object(&self, hash: &str, extension: &str, limit: u64) -> Result<Vec<u8>> {
        ensure!(
            valid_hash(hash),
            "COURSEWARE_INVALID: invalid commit object hash"
        );
        let bytes = self
            .objects
            .read(&format!("{hash}.{extension}"), limit)?
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: missing committed project object"))?;
        ensure!(
            digest(&bytes) == hash,
            "COURSEWARE_CONFLICT: committed project object changed"
        );
        Ok(bytes)
    }
    // shortcut: retain orphaned/old commit objects until reference-aware cleanup exists.
    fn archive(&self, bytes: &[u8], extension: &str, limit: u64) -> Result<String> {
        let hash = digest(bytes);
        let name = format!("{hash}.{extension}");
        if self.objects.read(&name, limit)?.is_none() {
            self.objects.publish(&name, bytes)?;
        }
        self.object(&hash, extension, limit)?;
        Ok(hash)
    }
    fn public_matches(&self, revision: Option<&Revision>) -> Result<()> {
        for (name, limit, expected) in [
            (SOURCE, MAX_SOURCE, revision.map(|r| &r.source_sha256)),
            (TEACHING, MAX_TEACHING, revision.map(|r| &r.teaching_sha256)),
        ] {
            let actual = self.root.read(name, limit)?.map(|bytes| digest(&bytes));
            ensure!(
                actual.as_ref() == expected,
                "COURSEWARE_CONFLICT: external project file changed"
            );
        }
        Ok(())
    }
    /// Only Host-decoded assets may supply MIME and measured duration metadata.
    pub fn archive_media(&self, asset: &Media, bytes: &[u8]) -> Result<()> {
        asset.validate()?;
        ensure!(
            bytes.len() as u64 == asset.byte_length && digest(bytes) == asset.sha256,
            "COURSEWARE_INVALID: portable media bytes differ"
        );
        let name = format!("{}.bin", asset.sha256);
        if self.media.read(&name, MAX_MEDIA_BYTES)?.is_none() {
            self.media.publish(&name, bytes)?;
        }
        self.verify_media(asset)
    }
    fn verify_media(&self, asset: &Media) -> Result<()> {
        self.read_media(asset).map(|_| ())
    }
    pub fn read_media(&self, asset: &Media) -> Result<Vec<u8>> {
        asset.validate()?;
        let bytes = self
            .media
            .read(&format!("{}.bin", asset.sha256), MAX_MEDIA_BYTES)?
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: portable media is missing"))?;
        ensure!(
            bytes.len() as u64 == asset.byte_length && digest(&bytes) == asset.sha256,
            "COURSEWARE_CONFLICT: portable media changed"
        );
        Ok(bytes)
    }
    fn validate_teaching(&self, bytes: &[u8], revision: &Revision) -> Result<Teaching> {
        let teaching = Teaching::parse(bytes, revision.commit_id, &revision.source_sha256)?;
        for asset in &teaching.media {
            self.verify_media(asset)?;
        }
        Ok(teaching)
    }
    pub fn current(&mut self) -> Result<Option<CommittedFiles>> {
        self.recover()?;
        let revision = self.index()?;
        self.public_matches(revision.as_ref())?;
        revision
            .map(|revision| {
                let source = self.object(&revision.source_sha256, "pptx", MAX_SOURCE)?;
                let teaching = self.object(&revision.teaching_sha256, "json", MAX_TEACHING)?;
                self.validate_teaching(&teaching, &revision)?;
                Ok(CommittedFiles {
                    source,
                    teaching,
                    revision,
                })
            })
            .transpose()
    }

    /// Attachment checks the unchanged baseline while a reviewed native save may change the public PPTX.
    pub fn attachment_baseline(&self, parsed_sha256: &str) -> Result<Teaching> {
        let revision = self
            .index()?
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: portable commit is missing"))?;
        let public = self
            .root
            .read(TEACHING, MAX_TEACHING)?
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: portable teaching is missing"))?;
        ensure!(
            digest(&public) == revision.teaching_sha256,
            "COURSEWARE_CONFLICT: external portable teaching changed"
        );
        let source = self
            .root
            .read(SOURCE, MAX_SOURCE)?
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: portable source is missing"))?;
        ensure!(
            digest(&source) == parsed_sha256,
            "COURSEWARE_CONFLICT: parsed source differs from portable source"
        );
        self.object(&revision.source_sha256, "pptx", MAX_SOURCE)?;
        let teaching = self.object(&revision.teaching_sha256, "json", MAX_TEACHING)?;
        self.validate_teaching(&teaching, &revision)
    }
    pub fn commit(
        &mut self,
        expected: Option<&Revision>,
        commit_id: uuid::Uuid,
        source: &[u8],
        teaching: &[u8],
    ) -> Result<Revision> {
        let previous = self.current()?.map(|files| files.revision);
        ensure!(
            previous.as_ref() == expected,
            "COURSEWARE_CONFLICT: project commit revision changed"
        );
        self.public_matches(previous.as_ref())?;
        ensure!(
            !source.is_empty()
                && source.len() as u64 <= MAX_SOURCE
                && !teaching.is_empty()
                && teaching.len() as u64 <= MAX_TEACHING,
            "COURSEWARE_INVALID: project commit exceeds byte limit"
        );
        let next = Revision {
            version: 1,
            commit_id,
            source_sha256: digest(source),
            teaching_sha256: digest(teaching),
        };
        next.validate()?;
        let content = self.validate_teaching(teaching, &next)?;
        if let Some(old) = &previous {
            let bytes = self.object(&old.teaching_sha256, "json", MAX_TEACHING)?;
            let old_content = self.validate_teaching(&bytes, old)?;
            ensure!(
                content.project_uuid == old_content.project_uuid
                    && content.project.project_id == old_content.project.project_id,
                "COURSEWARE_CONFLICT: project identity cannot change during commit"
            );
        }
        ensure!(
            previous
                .as_ref()
                .is_none_or(|old| old.commit_id != next.commit_id),
            "COURSEWARE_CONFLICT: commit id must change"
        );
        self.archive(source, "pptx", MAX_SOURCE)?;
        self.boundary()?;
        self.archive(teaching, "json", MAX_TEACHING)?;
        self.boundary()?;
        self.public_matches(previous.as_ref())?;
        let pending = Pending {
            version: 1,
            previous,
            next: next.clone(),
        };
        self.metadata
            .publish("pending.json", &serde_json::to_vec(&pending)?)?;
        self.boundary()?;
        self.recover()?;
        self.boundary()?;
        Ok(next)
    }
    fn displaced_hash(&self, name: &str, limit: u64) -> Result<Option<String>> {
        Ok(self
            .displaced
            .read(name, limit)?
            .map(|bytes| digest(&bytes)))
    }
    fn replace_public(
        &mut self,
        name: &str,
        limit: u64,
        next: &str,
        previous: Option<&String>,
        bytes: &[u8],
        backup: &str,
    ) -> Result<()> {
        let actual = self.root.read(name, limit)?.map(|bytes| digest(&bytes));
        if actual.as_deref() == Some(next) {
            self.boundary()?;
            self.boundary()?;
            return Ok(());
        }
        if actual.is_some() {
            ensure!(
                actual.as_ref() == previous && self.displaced_hash(backup, limit)?.is_none(),
                "COURSEWARE_CONFLICT: project replacement target changed"
            );
            self.root
                .move_without_replace(name, &self.displaced, backup)?;
            let captured = self.displaced_hash(backup, limit);
            if captured.as_ref().ok().and_then(|value| value.as_ref()) != previous {
                // Restore only into an empty pathname; retain both files if another editor filled it.
                let _ = self
                    .displaced
                    .move_without_replace(backup, &self.root, name);
                return Err(anyhow!(
                    "COURSEWARE_CONFLICT: external edit captured during replacement"
                ));
            }
        } else {
            ensure!(
                self.displaced_hash(backup, limit)?.as_ref() == previous,
                "COURSEWARE_CONFLICT: missing public project file without retained predecessor"
            );
        }
        self.boundary()?;
        // No-replace publication cannot clobber an external save racing the earlier checks.
        self.root.publish(name, bytes)?;
        self.boundary()?;
        Ok(())
    }
    fn recover(&mut self) -> Result<()> {
        let Some(bytes) = self.metadata.read("pending.json", MAX_JOURNAL)? else {
            return Ok(());
        };
        let pending: Pending = serde_json::from_slice(&bytes)?;
        ensure!(
            pending.version == 1,
            "COURSEWARE_INVALID: unsupported project journal"
        );
        pending.next.validate()?;
        if let Some(previous) = &pending.previous {
            previous.validate()?;
        }
        let current = self.index()?;
        ensure!(
            current == pending.previous || current.as_ref() == Some(&pending.next),
            "COURSEWARE_CONFLICT: project journal index changed"
        );
        if current.as_ref() == Some(&pending.next) {
            self.public_matches(Some(&pending.next))?;
        }
        let source = self.object(&pending.next.source_sha256, "pptx", MAX_SOURCE)?;
        let teaching = self.object(&pending.next.teaching_sha256, "json", MAX_TEACHING)?;
        let next_content = self.validate_teaching(&teaching, &pending.next)?;
        if let Some(previous) = &pending.previous {
            let bytes = self.object(&previous.teaching_sha256, "json", MAX_TEACHING)?;
            let old_content = self.validate_teaching(&bytes, previous)?;
            ensure!(
                next_content.project_uuid == old_content.project_uuid
                    && next_content.project.project_id == old_content.project.project_id,
                "COURSEWARE_CONFLICT: recovery cannot change project identity"
            );
        }
        let files = [
            (
                SOURCE,
                MAX_SOURCE,
                &pending.next.source_sha256,
                pending.previous.as_ref().map(|old| &old.source_sha256),
                source,
            ),
            (
                TEACHING,
                MAX_TEACHING,
                &pending.next.teaching_sha256,
                pending.previous.as_ref().map(|old| &old.teaching_sha256),
                teaching,
            ),
        ];
        // Validate the whole pair before replacing either file on recovery.
        for (name, limit, next, previous, _) in &files {
            let actual = self.root.read(name, *limit)?.map(|bytes| digest(&bytes));
            let backup = format!("{}-{name}", pending.next.commit_id);
            let captured = self.displaced_hash(&backup, *limit)?;
            ensure!(
                actual.as_ref() == Some(next)
                    || actual.as_ref() == *previous
                    || (actual.is_none() && previous.is_some() && captured.as_ref() == *previous),
                "COURSEWARE_CONFLICT: interrupted project contains external changes"
            );
            ensure!(
                captured.is_none() || captured.as_ref() == *previous,
                "COURSEWARE_CONFLICT: retained predecessor contains external changes"
            );
        }
        for (name, limit, next, previous, bytes) in files {
            let backup = format!("{}-{name}", pending.next.commit_id);
            self.replace_public(name, limit, next, previous, &bytes, &backup)?;
        }
        self.public_matches(Some(&pending.next))?;
        self.metadata
            .replace("current.json", &serde_json::to_vec(&pending.next)?)?;
        self.boundary()?;
        self.metadata.remove("pending.json")?;
        self.boundary()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
