//! Explicit image locks. Raw OOXML identifiers locate nodes only within one saved hash.
use super::*;
use std::collections::HashSet;

const NS: &str = "coursewareAssetLocks.v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageProof {
    pub source_shape_id: String,
    pub asset_sha256: String,
    pub picture_sha256: String,
    pub z_index: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LockedImage {
    pub page_id: String,
    pub object_id: String,
    pub source_sha256: String,
    pub mapping_revision: String,
    pub content_fingerprint: String,
    pub geometry_fingerprint: String,
    pub image: ImageProof,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetLocks {
    pub revision: String,
    pub images: Vec<LockedImage>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreservedImage {
    pub page_id: String,
    pub object_id: String,
    pub output_shape_id: String,
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl AssetLocks {
    pub(crate) fn validate(&self) -> Result<()> {
        let mut ids = HashSet::new();
        anyhow::ensure!(
            valid_id(&self.revision)
                && self.images.len() <= 1000
                && self.images.iter().all(|lock| valid_id(&lock.page_id)
                    && valid_id(&lock.object_id)
                    && valid_id(&lock.mapping_revision)
                    && hash(&lock.source_sha256)
                    && hash(&lock.content_fingerprint)
                    && hash(&lock.geometry_fingerprint)
                    && hash(&lock.image.asset_sha256)
                    && hash(&lock.image.picture_sha256)
                    && lock.image.z_index < 10000
                    && !lock.image.source_shape_id.is_empty()
                    && lock
                        .image
                        .source_shape_id
                        .bytes()
                        .all(|b| b.is_ascii_digit())
                    && ids.insert(lock.object_id.clone())),
            "COURSEWARE_INVALID: invalid saved image locks"
        );
        Ok(())
    }
}

impl Database {
    pub(super) fn restore_portable_asset_locks(
        &self,
        workspace: &str,
        project_id: &str,
        locks: &AssetLocks,
    ) -> Result<()> {
        locks.validate()?;
        self.kv_set(
            NS,
            &storage_key(workspace, project_id)?,
            &serde_json::to_value(locks)?,
        )
    }

    pub(super) fn courseware_asset_locks(
        &self,
        workspace: &str,
        project_id: &str,
    ) -> Result<Option<AssetLocks>> {
        let Some(value) = self.kv_get(NS, &storage_key(workspace, project_id)?)? else {
            return Ok(None);
        };
        let record: AssetLocks = serde_json::from_value(value)?;
        record.validate()?;
        Ok(Some(record))
    }

    fn lock_project(
        &self,
        workspace: &str,
        project_id: &str,
        page_id: &str,
        source: &str,
        teaching: &str,
    ) -> Result<(CoursewareProject, Value)> {
        self.ensure_no_source_adoption(workspace)?;
        let project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        anyhow::ensure!(
            project.source.revision == source && project.teaching_revision == teaching,
            "COURSEWARE_CONFLICT: image-lock teaching/source changed"
        );
        let page = project
            .pages
            .iter()
            .find(|p| p.page_id == page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_PAGE_NOT_FOUND: image-lock page missing"))?;
        anyhow::ensure!(!page.locked, "COURSEWARE_LOCKED: page is locked");
        let identity = self
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(workspace, project_id, &project.source.sha256)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: saved image identity missing"))?;
        self.courseware_mapping_revision(workspace, &project)?;
        Ok((project, identity))
    }

    pub fn courseware_asset_lock_context(
        &self,
        workspace: &str,
        project_id: &str,
        page_id: &str,
        source: &str,
        teaching: &str,
    ) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let (project, identity) =
            self.lock_project(workspace, project_id, page_id, source, teaching)?;
        let record = self.courseware_asset_locks(workspace, project_id)?;
        let mapping = self.courseware_mapping(workspace, &project)?;
        let page = identity["pages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["logicalId"] == page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: saved image page identity missing"))?;
        let result = serde_json::json!({"projectId":project_id,"sourceSha256":project.source.sha256,"mappingRevision":mapping["revision"],"pageId":page_id,"mapping":mapping,
            "objects":page["objects"],"locks":record});
        tx.commit()?;
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_courseware_asset_lock(
        &self,
        workspace: &str,
        project_id: &str,
        page_id: &str,
        source: &str,
        teaching: &str,
        expected_revision: Option<&str>,
        object_id: &str,
        locked: bool,
        proof: Option<ImageProof>,
    ) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let (project, identity) =
            self.lock_project(workspace, project_id, page_id, source, teaching)?;
        let previous = self.courseware_asset_locks(workspace, project_id)?;
        anyhow::ensure!(
            previous.as_ref().map(|v| v.revision.as_str()) == expected_revision,
            "COURSEWARE_CONFLICT: image locks changed"
        );
        let mut images = previous
            .as_ref()
            .map(|v| v.images.clone())
            .unwrap_or_default();
        if locked {
            let proof = proof
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: verified image proof required"))?;
            anyhow::ensure!(
                hash(&proof.asset_sha256)
                    && hash(&proof.picture_sha256)
                    && proof.z_index < 10000
                    && (1..=200).contains(&proof.source_shape_id.len())
                    && proof.source_shape_id.bytes().all(|b| b.is_ascii_digit()),
                "COURSEWARE_INVALID: invalid image proof"
            );
            let page = identity["pages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["logicalId"] == page_id)
                .unwrap();
            let (index, object) = page["objects"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .find(|(_, o)| o["logicalId"] == object_id)
                .ok_or_else(|| {
                    anyhow!("COURSEWARE_INVALID: image target is not on current page")
                })?;
            anyhow::ensure!(
                object["type"] == "image"
                    && object["sourceShapeId"] == proof.source_shape_id
                    && index == proof.z_index,
                "COURSEWARE_INVALID: verified image differs from Host saved object"
            );
            let mapping_revision = self.courseware_mapping_revision(workspace, &project)?;
            let lock = LockedImage {
                page_id: page_id.into(),
                object_id: object_id.into(),
                source_sha256: project.source.sha256,
                mapping_revision,
                content_fingerprint: object["contentFingerprint"].as_str().unwrap().into(),
                geometry_fingerprint: object["geometryFingerprint"].as_str().unwrap().into(),
                image: proof,
            };
            if let Some(old) = images.iter_mut().find(|v| v.object_id == object_id) {
                anyhow::ensure!(
                    *old == lock,
                    "COURSEWARE_CONFLICT: stale image lock must be explicitly cleared"
                );
            } else {
                images.push(lock);
            }
        } else {
            anyhow::ensure!(
                proof.is_none(),
                "COURSEWARE_INVALID: unlock cannot supply image proof"
            );
            let old = images
                .iter()
                .find(|v| v.object_id == object_id)
                .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: image lock missing"))?;
            anyhow::ensure!(
                old.page_id == page_id
                    || !project.pages.iter().any(|page| page.page_id == old.page_id),
                "COURSEWARE_INVALID: cannot unlock peer-page image"
            );
            images.retain(|v| v.object_id != object_id);
        }
        anyhow::ensure!(
            images.len() <= 1000,
            "COURSEWARE_INVALID: too many image locks"
        );
        if previous.as_ref().is_none_or(|old| old.images != images) {
            self.kv_set(
                NS,
                &storage_key(workspace, project_id)?,
                &serde_json::to_value(AssetLocks {
                    revision: uuid::Uuid::new_v4().to_string(),
                    images,
                })?,
            )?;
        }
        tx.commit()?;
        self.courseware_asset_lock_context(workspace, project_id, page_id, source, teaching)
    }

    pub(super) fn candidate_asset_locks(
        &self,
        workspace: &str,
        project: &CoursewareProject,
        targets: &[&str],
    ) -> Result<Option<AssetLocks>> {
        let record = self.courseware_asset_locks(workspace, &project.project_id)?;
        let revision = self.courseware_mapping_revision(workspace, project)?;
        anyhow::ensure!(record.as_ref().into_iter().flat_map(|r|&r.images).filter(|v|targets.contains(&v.page_id.as_str()))
            .all(|v|v.source_sha256==project.source.sha256 && v.mapping_revision==revision),
            "COURSEWARE_CONFLICT: target has stale image locks; explicitly clear or relock current saved images");
        Ok(record)
    }

    pub(super) fn rebind_candidate_asset_locks(
        &self,
        workspace: &str,
        previous: &CoursewareProject,
        next: &CoursewareProject,
        mapping_revision: &str,
        expected: &Option<AssetLocks>,
        proofs: &[PreservedImage],
    ) -> Result<()> {
        anyhow::ensure!(
            self.courseware_asset_locks(workspace, &previous.project_id)? == *expected,
            "COURSEWARE_CONFLICT: image locks changed before adoption"
        );
        let Some(mut record) = expected.clone() else {
            return Ok(());
        };
        let old_mapping = self.courseware_mapping_revision(workspace, previous)?;
        for lock in &mut record.images {
            if lock.source_sha256 == previous.source.sha256 && lock.mapping_revision == old_mapping
            {
                lock.source_sha256 = next.source.sha256.clone();
                lock.mapping_revision = mapping_revision.into();
                if let Some(proof) = proofs
                    .iter()
                    .find(|p| p.object_id == lock.object_id && p.page_id == lock.page_id)
                {
                    lock.image.source_shape_id = proof.output_shape_id.clone();
                }
            }
        }
        record.revision = uuid::Uuid::new_v4().to_string();
        self.kv_set(
            NS,
            &storage_key(workspace, &previous.project_id)?,
            &serde_json::to_value(record)?,
        )?;
        Ok(())
    }
}

pub(super) fn verify_preserved_images(
    source: &Value,
    output: &Value,
    targets: &[&str],
    record: &Option<AssetLocks>,
    proofs: &[PreservedImage],
) -> Result<()> {
    let expected: Vec<_> = record
        .as_ref()
        .into_iter()
        .flat_map(|r| &r.images)
        .filter(|v| targets.contains(&v.page_id.as_str()))
        .collect();
    anyhow::ensure!(
        proofs.len() == expected.len()
            && proofs
                .iter()
                .map(|p| (&p.page_id, &p.object_id))
                .collect::<HashSet<_>>()
                .len()
                == proofs.len(),
        "COURSEWARE_INVALID: incomplete locked-image output proof"
    );
    for lock in expected {
        let proof = proofs
            .iter()
            .find(|p| p.page_id == lock.page_id && p.object_id == lock.object_id)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing locked image"))?;
        let pages = source["pages"].as_array().unwrap();
        let index = pages
            .iter()
            .position(|p| p["logicalId"] == lock.page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing image-lock page"))?;
        let old = pages[index]["objects"]
            .as_array()
            .unwrap()
            .get(lock.image.z_index)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing original image-lock object"))?;
        let page = output["pages"]
            .as_array()
            .and_then(|p| p.get(index))
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing locked output page"))?;
        let image = page["objects"]
            .as_array()
            .and_then(|o| o.get(lock.image.z_index))
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing preserved image layer"))?;
        anyhow::ensure!(
            old["logicalId"] == lock.object_id
                && old["type"] == "image"
                && old["sourceShapeId"] == lock.image.source_shape_id
                && old["contentFingerprint"] == lock.content_fingerprint
                && old["geometryFingerprint"] == lock.geometry_fingerprint
                && image["type"] == "image"
                && image["sourceShapeId"] == proof.output_shape_id
                && !proof.output_shape_id.is_empty()
                && image["contentFingerprint"] == lock.content_fingerprint
                && image["geometryFingerprint"] == lock.geometry_fingerprint,
            "COURSEWARE_INVALID: locked image content, geometry or layer changed"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests;
