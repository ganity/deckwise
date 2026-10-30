//! Immutable teaching/source bindings. File verification belongs to the Host RPC boundary.
use super::*;
use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};
use serde_json::json;

const SNAPSHOTS: &str = "coursewareSnapshots.v1";
const ONLINE_SNAPSHOTS: &str = "coursewareOnlineSnapshots.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Asset {
    pub id: String,
    pub sha256: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub snapshot_id: String,
    pub project_id: String,
    pub source: CoursewareSource,
    pub teaching_revision: String,
    pub mapping_revision: String,
    pub asset_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotRecord {
    pub snapshot: Snapshot,
    pub project: CoursewareProject,
    pub identity: Value,
    pub assets: Vec<Asset>,
}

impl SnapshotRecord {
    pub fn validate(&self) -> Result<()> {
        self.project.validate_online()?;
        let identity = SavedSourceIdentity::parse(&serde_json::to_vec(&self.identity)?)?;
        let s = &self.snapshot;
        anyhow::ensure!(
            valid_id(&s.snapshot_id)
                && s.project_id == self.project.project_id
                && s.source.revision == self.project.source.revision
                && s.source.sha256 == self.project.source.sha256
                && s.teaching_revision == self.project.teaching_revision
                && self.identity["mappingRevision"] == s.mapping_revision
                && valid_id(&s.mapping_revision)
                && identity.matches_source(&s.source.sha256, self.project.pages.len())
                && self
                    .project
                    .pages
                    .iter()
                    .zip(self.identity["pages"].as_array().unwrap())
                    .all(|(page, bound)| page.page_id == bound["logicalId"]),
            "COURSEWARE_INVALID: inconsistent snapshot binding"
        );
        anyhow::ensure!(
            self.project
                .pages
                .iter()
                .all(|page| page.review_state == "ready"),
            "COURSEWARE_CONFLICT: confirm every teaching page before taking a snapshot"
        );
        let mut ids = std::collections::HashSet::new();
        anyhow::ensure!(
            self.assets.len() <= 1000,
            "COURSEWARE_INVALID: too many assets"
        );
        for asset in &self.assets {
            anyhow::ensure!(
                valid_id(&asset.id)
                    && ids.insert(asset.id.as_str())
                    && asset.sha256.len() == 64
                    && asset
                        .sha256
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    && matches!(
                        asset.mime_type.as_str(),
                        "audio/wav"
                            | "audio/mpeg"
                            | "audio/ogg"
                            | "audio/mp4"
                            | "audio/webm"
                            | "video/mp4"
                    ),
                "COURSEWARE_INVALID: invalid fixed audio asset"
            );
        }
        anyhow::ensure!(
            s.asset_ids
                == self
                    .assets
                    .iter()
                    .map(|asset| asset.id.clone())
                    .collect::<Vec<_>>(),
            "COURSEWARE_INVALID: snapshot asset ids differ"
        );
        let mut used = std::collections::HashSet::new();
        for action in self.project.pages.iter().flat_map(|page| &page.actions) {
            anyhow::ensure!(action.get("attention").is_none(), "COURSEWARE_CONFLICT: adopt decoded speech audio to resolve automatic attention before snapshot capture");
            anyhow::ensure!(
                action["type"] != "video_slot" && action["type"] != "music_slot",
                "COURSEWARE_CONFLICT: generate and adopt planned video before publishing"
            );
            if action["type"] == "video_clip" {
                let video = action["videoAssetId"].as_str().unwrap_or_default();
                anyhow::ensure!(
                    super::video::valid_clip(action)
                        && self
                            .assets
                            .iter()
                            .any(|asset| asset.id == video && asset.mime_type == "video/mp4"),
                    "COURSEWARE_CONFLICT: video clip requires its archived video asset"
                );
                used.insert(video);
            }
            if action["type"] == "speech" || action["type"] == "audio_clip" {
                let audio = action["audioAssetId"].as_str().unwrap_or("");
                anyhow::ensure!(
                    (action["type"] == "audio_clip"
                        && (music::valid_clip(action) || valid_online_clip(action))
                        || action["type"] == "speech"
                            && action["text"]
                                .as_str()
                                .is_some_and(|s| !s.trim().is_empty()))
                        && self.assets.iter().any(|asset| asset.id == audio && asset.mime_type.starts_with("audio/")),
                    "COURSEWARE_CONFLICT: each speech or music clip requires a fixed audio asset"
                );
                used.insert(audio);
            }
        }
        anyhow::ensure!(
            used == ids,
            "COURSEWARE_INVALID: unreferenced fixed audio asset"
        );
        Ok(())
    }

    pub fn mapping(&self) -> Value {
        json!({
            "revision": self.snapshot.mapping_revision,
            "sourceSha256": self.snapshot.source.sha256,
            "pages": self.identity["pages"].as_array().unwrap().iter().map(|page| json!({
                "pageId": page["logicalId"], "importPageId": page["importPageId"],
                "objects": page["objects"].as_array().unwrap().iter().map(|object| json!({
                    "objectId": object["logicalId"], "importElementId": object["importElementId"]
                })).collect::<Vec<_>>()
            })).collect::<Vec<_>>()
        })
    }
}

fn key(workspace: &str, project_id: &str, snapshot_id: &str) -> Result<String> {
    anyhow::ensure!(
        valid_id(snapshot_id),
        "COURSEWARE_INVALID: invalid snapshot id"
    );
    Ok(serde_json::to_string(&(
        storage_key(workspace, project_id)?,
        snapshot_id,
    ))?)
}

impl Database {
    pub fn import_online_courseware_snapshot(
        &self,
        workspace: &str,
        parsed: &crate::courseware::source_candidates::ParsedOutput,
        snapshot_id: &str,
        project: CoursewareProject,
        mapping: &Value,
        mut assets: Vec<Asset>,
    ) -> Result<SnapshotRecord> {
        project.validate_online()?;
        parsed.validate()?;
        anyhow::ensure!(
            project.source.sha256 == parsed.sha256
                && project.pages.len() == parsed.pages
                && mapping["sourceRevision"] == project.source.revision,
            "COURSEWARE_CONFLICT: online teaching differs from pinned source"
        );
        let fresh =
            SavedSourceIdentity::parse(&serde_json::to_vec(parsed.identity.as_ref().unwrap())?)?;
        let identity = fresh.bind_mapping(mapping)?;
        assets.sort_by(|a, b| a.id.cmp(&b.id));
        let record = SnapshotRecord {
            snapshot: Snapshot {
                snapshot_id: snapshot_id.into(),
                project_id: project.project_id.clone(),
                source: project.source.clone(),
                teaching_revision: project.teaching_revision.clone(),
                mapping_revision: mapping["revision"].as_str().unwrap_or("").into(),
                asset_ids: assets.iter().map(|asset| asset.id.clone()).collect(),
            },
            project,
            identity: identity.value().clone(),
            assets,
        };
        record.validate()?;
        let tx = self.conn.unchecked_transaction()?;
        self.persist_courseware_snapshot(workspace, &record)?;
        self.kv_set(
            ONLINE_SNAPSHOTS,
            &key(
                workspace,
                &record.snapshot.project_id,
                &record.snapshot.snapshot_id,
            )?,
            &serde_json::to_value(&record.snapshot)?,
        )?;
        tx.commit()?;
        Ok(record)
    }

    pub fn is_online_courseware_snapshot(
        &self,
        workspace: &str,
        project_id: &str,
        snapshot_id: &str,
    ) -> Result<bool> {
        let Some(origin) =
            self.kv_get(ONLINE_SNAPSHOTS, &key(workspace, project_id, snapshot_id)?)?
        else {
            return Ok(false);
        };
        let record = self.get_courseware_snapshot(workspace, project_id, snapshot_id)?;
        anyhow::ensure!(
            origin == serde_json::to_value(&record.snapshot)?,
            "COURSEWARE_CONFLICT: online snapshot origin differs"
        );
        Ok(true)
    }

    pub fn capture_courseware_snapshot(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        snapshot_id: &str,
        expected_source_revision: &str,
        expected_teaching_revision: &str,
        mut assets: Vec<Asset>,
    ) -> Result<SnapshotRecord> {
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        self.ensure_courseware_chat_resolved(workspace, &seed.project_id)?;
        let project = self
            .get_courseware_project(workspace, &seed.project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        anyhow::ensure!(
            project.source.revision == expected_source_revision
                && project.teaching_revision == expected_teaching_revision
                && project.source.sha256 == seed.sha256
                && project.pages.len() == seed.pages,
            "COURSEWARE_CONFLICT: snapshot baseline changed"
        );
        let identity = self
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(workspace, &project.project_id, &seed.sha256)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: saved source mapping is required"))?;
        let bound = SavedSourceIdentity::parse(&serde_json::to_vec(&identity)?)?;
        anyhow::ensure!(
            seed.identity
                .as_ref()
                .is_some_and(|parsed| bound.same_export(parsed)),
            "COURSEWARE_CONFLICT: fresh source identity differs"
        );
        assets.sort_by(|a, b| a.id.cmp(&b.id));
        let record = SnapshotRecord {
            snapshot: Snapshot {
                snapshot_id: snapshot_id.into(),
                project_id: project.project_id.clone(),
                source: project.source.clone(),
                teaching_revision: project.teaching_revision.clone(),
                mapping_revision: identity["mappingRevision"].as_str().unwrap_or("").into(),
                asset_ids: assets.iter().map(|asset| asset.id.clone()).collect(),
            },
            project,
            identity,
            assets,
        };
        record.validate()?;
        self.persist_courseware_snapshot(workspace, &record)?;
        tx.commit()?;
        Ok(record)
    }

    fn persist_courseware_snapshot(&self, workspace: &str, record: &SnapshotRecord) -> Result<()> {
        let key = key(
            workspace,
            &record.snapshot.project_id,
            &record.snapshot.snapshot_id,
        )?;
        let serialized = serde_json::to_string(record)?;
        if let Some(saved) = self.kv_get(SNAPSHOTS, &key)? {
            anyhow::ensure!(
                saved == serde_json::to_value(record)?,
                "COURSEWARE_CONFLICT: snapshot id already has different content"
            );
        } else {
            self.conn.execute(
                "INSERT INTO kv (ns, key, value_json, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![SNAPSHOTS, key, serialized, now_ms()],
            )?;
        }
        Ok(())
    }

    pub fn get_courseware_snapshot(
        &self,
        workspace: &str,
        project_id: &str,
        snapshot_id: &str,
    ) -> Result<SnapshotRecord> {
        let value = self
            .kv_get(SNAPSHOTS, &key(workspace, project_id, snapshot_id)?)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: snapshot not found"))?;
        let record: SnapshotRecord = serde_json::from_value(value)?;
        record.validate()?;
        anyhow::ensure!(
            record.snapshot.project_id == project_id && record.snapshot.snapshot_id == snapshot_id,
            "COURSEWARE_INVALID: snapshot identity mismatch"
        );
        Ok(record)
    }
}

#[cfg(test)]
mod online_tests;
#[cfg(test)]
mod tests;
