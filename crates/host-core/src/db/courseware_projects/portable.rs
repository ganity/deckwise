//! Portable teaching content. Provider receipts and authorization stay in Host storage.
use super::*;
use crate::courseware::identity::SavedSourceIdentity;
use std::collections::{HashMap, HashSet};

mod restore;

pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_MEDIA_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Media {
    pub id: String,
    pub path: String,
    pub sha256: String,
    pub mime_type: String,
    pub byte_length: u64,
    pub duration_ms: u64,
}
impl Media {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            valid_id(&self.id)
                && !matches!(self.id.as_str(), "." | "..")
                && self.sha256.len() == 64
                && self
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                && self.path == format!("media/{}.bin", self.sha256)
                && matches!(
                    self.mime_type.as_str(),
                    "audio/wav" | "audio/mpeg" | "audio/ogg" | "audio/mp4" | "video/mp4"
                )
                && (1..=MAX_MEDIA_BYTES).contains(&self.byte_length)
                && (1..=3_600_000).contains(&self.duration_ms),
            "COURSEWARE_INVALID: invalid portable media"
        );
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneObjects {
    pub original_identity: Value,
    pub mapping: scene_objects::GeneratedSceneMapping,
}
impl SceneObjects {
    pub fn validate(&self) -> Result<()> {
        let identity = SavedSourceIdentity::parse(&serde_json::to_vec(&self.original_identity)?)?;
        anyhow::ensure!(
            identity.value()["mappingRevision"].is_string()
                && identity.value()["diagnostics"]
                    .as_array()
                    .is_some_and(Vec::is_empty),
            "COURSEWARE_INVALID: portable scene requires bound identity without diagnostics"
        );
        self.mapping.validate_source(&identity)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Teaching {
    pub schema_version: String,
    pub project_uuid: uuid::Uuid,
    pub commit_id: uuid::Uuid,
    pub project: CoursewareProject,
    pub identity: Value,
    pub media: Vec<Media>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub asset_locks: Option<asset_locks::AssetLocks>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub scene_objects: Option<SceneObjects>,
}
impl Teaching {
    pub fn parse(bytes: &[u8], commit: uuid::Uuid, source_sha256: &str) -> Result<Self> {
        anyhow::ensure!(
            bytes.len() <= MAX_BYTES,
            "COURSEWARE_INVALID: teaching exceeds byte limit"
        );
        let teaching: Self = serde_json::from_slice(bytes)?;
        teaching.validate(commit, source_sha256)?;
        Ok(teaching)
    }
    pub fn validate(&self, commit: uuid::Uuid, source_sha256: &str) -> Result<()> {
        anyhow::ensure!(
            self.schema_version == "deckwise-teaching/1"
                && !self.project_uuid.is_nil()
                && !self.commit_id.is_nil()
                && self.commit_id == commit
                && self.project.source.sha256 == source_sha256
                && serde_json::to_vec(self)?.len() <= MAX_BYTES,
            "COURSEWARE_INVALID: portable header does not match committed source"
        );
        self.project.validate_online()?;
        if let Some(locks) = &self.asset_locks {
            locks.validate()?;
        }
        if let Some(scene) = &self.scene_objects {
            scene.validate()?;
        }

        let identity = SavedSourceIdentity::parse(&serde_json::to_vec(&self.identity)?)?;
        anyhow::ensure!(
            identity.matches_source(source_sha256, self.project.pages.len())
                && self.identity["mappingRevision"].is_string()
                && self.identity["diagnostics"].as_array().is_some_and(Vec::is_empty),
            "COURSEWARE_INVALID: portable mapping requires bound identity without private diagnostics"
        );
        if let Some(locks) = &self.asset_locks {
            for lock in &locks.images {
                if lock.source_sha256 != source_sha256 {
                    continue;
                }
                let object = self.identity["pages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|page| page["logicalId"] == lock.page_id)
                    .and_then(|page| page["objects"].as_array())
                    .into_iter()
                    .flatten()
                    .find(|object| object["logicalId"] == lock.object_id);
                anyhow::ensure!(
                    lock.mapping_revision == self.identity["mappingRevision"].as_str().unwrap()
                        && object.is_some_and(|object| object["type"] == "image"
                            && object["sourceShapeId"] == lock.image.source_shape_id
                            && object["contentFingerprint"] == lock.content_fingerprint
                            && object["geometryFingerprint"] == lock.geometry_fingerprint),
                    "COURSEWARE_INVALID: copied image lock differs from saved identity"
                );
            }
        }
        let mut assets = HashMap::new();
        let mut total = 0;
        let mut metadata = HashMap::new();
        anyhow::ensure!(
            self.media.len() <= 1000,
            "COURSEWARE_INVALID: too many portable media"
        );
        for asset in &self.media {
            asset.validate()?;
            if let Some(previous) = metadata.insert(asset.sha256.as_str(), asset) {
                anyhow::ensure!(
                    previous.byte_length == asset.byte_length
                        && previous.mime_type == asset.mime_type
                        && previous.duration_ms == asset.duration_ms,
                    "COURSEWARE_INVALID: inconsistent metadata for identical media bytes"
                );
            }
            for prefix in ["tts-", "music-", "video-"] {
                if let Some(hash) = asset.id.strip_prefix(prefix) {
                    anyhow::ensure!(
                        hash == asset.sha256,
                        "COURSEWARE_INVALID: media ID hash differs"
                    );
                }
            }
            total += asset.byte_length;
            anyhow::ensure!(
                assets.insert(asset.id.as_str(), asset).is_none() && total <= 128 * 1024 * 1024,
                "COURSEWARE_INVALID: duplicate or oversized portable media"
            );
        }
        let mut used = HashSet::new();
        let page_ids: HashSet<_> = self
            .project
            .pages
            .iter()
            .map(|p| p.page_id.as_str())
            .collect();
        for (page, mapped) in self
            .project
            .pages
            .iter()
            .zip(self.identity["pages"].as_array().unwrap())
        {
            anyhow::ensure!(
                mapped["logicalId"] == page.page_id,
                "COURSEWARE_INVALID: portable page mapping differs"
            );
            let objects: HashSet<_> = mapped["objects"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|o| matches!(o["type"].as_str(), Some("shape" | "image" | "text")))
                .map(|o| o["logicalId"].as_str().unwrap())
                .collect();
            let mut node_ids = HashSet::new();
            let mut checkpoint_ids = HashSet::new();
            reviews::effects::validate_animation_sequence(&page.actions)?;
            for action in &page.actions {
                anyhow::ensure!(
                    node_ids.insert(action["id"].as_str().unwrap()),
                    "COURSEWARE_INVALID: duplicate portable node ID"
                );
                let kind = action["type"].as_str().unwrap();
                match kind {
                    "speech" => {
                        anyhow::ensure!(
                            action.as_object().unwrap().keys().all(|k| [
                                "id",
                                "type",
                                "text",
                                "source",
                                "pauseAfterMs",
                                "audioAssetId",
                                "attention",
                                "visualCues"
                            ]
                            .contains(&k.as_str()))
                                && action["text"]
                                    .as_str()
                                    .is_some_and(|s| s.encode_utf16().count() <= 32000)
                                && action.get("source").is_none_or(|s| matches!(
                                    s.as_str(),
                                    Some(
                                        "notes"
                                            | "external"
                                            | "original"
                                            | "light_rewrite"
                                            | "generated"
                                    )
                                ))
                                && action
                                    .get("pauseAfterMs")
                                    .is_none_or(|p| p.as_u64().is_some_and(|p| p <= 30000)),
                            "COURSEWARE_INVALID: unsupported portable speech"
                        );
                        if let Some(intent) = action.get("attention") {
                            for target in attention::targets(intent)? {
                                anyhow::ensure!(
                                    objects.contains(target.as_str()),
                                    "COURSEWARE_INVALID: attention target not mapped on page"
                                );
                            }
                        }
                        let audio = action
                            .get("audioAssetId")
                            .map(|id| media_ref(id, false, &assets, &mut used))
                            .transpose()?;
                        if let Some(cues) = action.get("visualCues") {
                            let cues =
                                cues.as_array().filter(|c| c.len() <= 200).ok_or_else(|| {
                                    anyhow!("COURSEWARE_INVALID: invalid portable cues")
                                })?;
                            let mut ids = HashSet::new();
                            for cue in cues {
                                anyhow::ensure!(
                                    ids.insert(cue["id"].clone())
                                        && audio.is_some_and(|a| cue["endMs"]
                                            .as_u64()
                                            .is_some_and(|end| end <= a.duration_ms)),
                                    "COURSEWARE_INVALID: cue requires current audio interval"
                                );
                                for target in reviews::effects::cue_targets(cue)? {
                                    anyhow::ensure!(
                                        objects.contains(target.as_str()),
                                        "COURSEWARE_INVALID: cue target not mapped on page"
                                    );

                                }
                            }
                        }
                    }
                    "audio_clip" => {
                        media_ref(&action["audioAssetId"], false, &assets, &mut used)?;
                    }
                    "video_clip" => {
                        media_ref(&action["videoAssetId"], true, &assets, &mut used)?;
                    }
                    "music_slot" | "video_slot" | "delay" | "native_animation" => {}
                    "interaction_checkpoint" => {
                        anyhow::ensure!(
                            valid_teaching_checkpoint(action)
                                && checkpoint_ids
                                    .insert(action["checkpointId"].as_str().unwrap_or_default()),
                            "COURSEWARE_INVALID: unsupported portable checkpoint"
                        );
                        if action["checkpointKind"] == "chapter_summary" {
                            anyhow::ensure!(
                                action["context"]["sourceSceneIds"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .all(|id| page_ids.contains(id.as_str().unwrap())),
                                "COURSEWARE_INVALID: checkpoint refers to missing page"
                            );
                        }
                    }
                    _ => anyhow::bail!("COURSEWARE_INVALID: unsupported portable node"),
                }
            }
        }
        anyhow::ensure!(
            used.len() == assets.len(),
            "COURSEWARE_INVALID: unreferenced portable media"
        );
        Ok(())
    }
}
fn media_ref<'a>(
    id: &Value,
    video: bool,
    assets: &HashMap<&str, &'a Media>,
    used: &mut HashSet<String>,
) -> Result<&'a Media> {
    let asset = id
        .as_str()
        .and_then(|id| assets.get(id))
        .copied()
        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: portable media reference missing"))?;
    anyhow::ensure!(
        (asset.mime_type == "video/mp4") == video,
        "COURSEWARE_INVALID: wrong portable media kind"
    );
    used.insert(asset.id.clone());
    Ok(asset)
}

impl Database {
    /// Copies committed editable teaching; private adoption receipts only prove local media provenance.
    pub fn portable_courseware_content(
        &self,
        workspace: &str,
        seed: &crate::courseware::SavedProjectSeed,
        expected_source_revision: &str,
        expected_teaching_revision: &str,
    ) -> Result<Teaching> {
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        let project = self
            .get_courseware_project(workspace, &seed.project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        anyhow::ensure!(
            project.source.sha256 == seed.sha256
                && project.pages.len() == seed.pages
                && project.source.revision == expected_source_revision
                && project.teaching_revision == expected_teaching_revision,
            "COURSEWARE_CONFLICT: project changed before copy"
        );
        let mut identity = self
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(workspace, &project.project_id, &seed.sha256)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: copy requires saved source mapping"))?;
        let bound = SavedSourceIdentity::parse(&serde_json::to_vec(&identity)?)?;
        anyhow::ensure!(
            seed.identity
                .as_ref()
                .is_some_and(|parsed| bound.same_export(parsed)),
            "COURSEWARE_CONFLICT: parsed copy source differs from saved mapping"
        );
        // Parser messages may include local paths; their original Host record is retained.
        identity["diagnostics"] = serde_json::json!([]);
        let mut media = HashMap::<String, Media>::new();
        let mut add = |id: String,
                       sha256: String,
                       mime_type: String,
                       byte_length: u64,
                       duration_ms: u64|
         -> Result<()> {
            let entry = Media {
                id: id.clone(),
                path: format!("media/{sha256}.bin"),
                sha256,
                mime_type,
                byte_length,
                duration_ms,
            };
            entry.validate()?;
            if let Some(old) = media.insert(id, entry.clone()) {
                anyhow::ensure!(
                    serde_json::to_value(old)? == serde_json::to_value(entry)?,
                    "COURSEWARE_CONFLICT: inconsistent copied media"
                );
            }
            Ok(())
        };
        let mut receipt_project = project.clone();
        let mut local_media = self.portable_courseware_media_entries(workspace, &project)?;
        for page in &mut receipt_project.pages {
            for action in std::mem::take(&mut page.actions) {
                if let Some(asset) = local_media.remove(&(
                    page.page_id.clone(),
                    action["id"].as_str().unwrap_or_default().into(),
                )) {
                    add(
                        asset.id,
                        asset.sha256,
                        asset.mime_type,
                        asset.byte_length,
                        asset.duration_ms,
                    )?;
                } else {
                    page.actions.push(action);
                }
            }
        }
        // Imported local files and newly generated provider results keep distinct provenance.
        for audio in self.portable_audio(workspace, &receipt_project)? {
            add(
                audio.asset().id,
                audio.sha256,
                audio.mime_type,
                audio.byte_length,
                audio.duration_ms,
            )?;
        }
        for record in self.courseware_music_adoptions(workspace, &project.project_id)? {
            if record.attached(&receipt_project) {
                add(
                    record.asset.id,
                    record.asset.sha256,
                    record.asset.mime_type,
                    record.byte_length as u64,
                    record.selection.duration_ms,
                )?;
            }
        }
        for video in self.portable_video_assets(workspace, &receipt_project)? {
            add(
                video.asset().id,
                video.sha256,
                "video/mp4".into(),
                video.byte_length,
                video.duration_ms,
            )?;
        }
        let mut media: Vec<_> = media.into_values().collect();
        media.sort_by(|a, b| a.id.cmp(&b.id));
        let content = Teaching {
            schema_version: "deckwise-teaching/1".into(),
            project_uuid: uuid::Uuid::new_v4(),
            commit_id: uuid::Uuid::new_v4(),
            asset_locks: self.courseware_asset_locks(workspace, &project.project_id)?,
            scene_objects: self.portable_scene_objects(workspace, &project)?,
            project,
            identity,
            media,
        };
        content.validate(content.commit_id, &seed.sha256)?;
        tx.commit()?;
        Ok(content)
    }
}

#[cfg(test)]
mod tests;
