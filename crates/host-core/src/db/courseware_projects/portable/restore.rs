//! Non-destructive import into the current SQLite authority, not sidecar save migration.
use super::*;
use crate::courseware::SavedProjectSeed;

const ORIGINS: &str = "coursewarePortableOrigins.v1";

impl Database {
    /// Only an identical imported baseline may associate a changed PPTX for explicit source review.
    pub fn imported_portable_courseware(
        &self,
        workspace: &str,
        content: &Teaching,
    ) -> Result<Option<CoursewareProject>> {
        content.validate(content.commit_id, &content.project.source.sha256)?;
        let id = format!("portable-{}", content.project_uuid);
        let Some(origin) = self.kv_get(ORIGINS, &storage_key(workspace, &id)?)? else {
            return Ok(None);
        };
        anyhow::ensure!(
            origin == serde_json::to_value(content)?,
            "COURSEWARE_CONFLICT: imported project has a different portable baseline"
        );
        self.get_courseware_project(workspace, &id)?
            .map(Some)
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: imported project is missing"))
    }
    /// The caller must verify/archive every local media file before invoking this transaction.
    pub fn restore_portable_courseware_content(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        content: &Teaching,
    ) -> Result<CoursewareProject> {
        content.validate(content.commit_id, &seed.sha256)?;
        let identity = SavedSourceIdentity::parse(&serde_json::to_vec(&content.identity)?)?;
        // Portable content omits private parser diagnostics; all mapping evidence still must match.
        let fresh = seed
            .identity
            .as_ref()
            .map(|fresh| {
                let mut value = fresh.value().clone();
                value["diagnostics"] = serde_json::json!([]);
                SavedSourceIdentity::parse(&serde_json::to_vec(&value)?)
            })
            .transpose()?;
        anyhow::ensure!(
            seed.pages == content.project.pages.len()
                && fresh
                    .as_ref()
                    .is_some_and(|fresh| identity.same_export(fresh)),
            "COURSEWARE_CONFLICT: portable teaching differs from parsed PPTX"
        );
        let project_id = format!("portable-{}", content.project_uuid);
        let key = storage_key(workspace, &project_id)?;
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        if let Some(origin) = self.kv_get(ORIGINS, &key)? {
            let origin: Teaching = serde_json::from_value(origin)?;
            origin.validate(origin.commit_id, &seed.sha256)?;
            anyhow::ensure!(
                serde_json::to_value(&origin)? == serde_json::to_value(content)?,
                "COURSEWARE_CONFLICT: imported project already has a different portable baseline"
            );
            let project = self
                .get_courseware_project(workspace, &project_id)?
                .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: imported project is missing"))?;
            anyhow::ensure!(
                project.source.sha256 == seed.sha256,
                "COURSEWARE_CONFLICT: local source changed; explicit source review is required"
            );
            // An unchanged copy never overwrites edits acknowledged by this profile.
            tx.commit()?;
            return Ok(project);
        }
        anyhow::ensure!(
            self.get_courseware_project(workspace, &project_id)?
                .is_none(),
            "COURSEWARE_CONFLICT: portable destination already exists without an import marker"
        );
        let mut project = content.project.clone();
        project.project_id = project_id;
        self.create_courseware_project(workspace, &project)?;
        self.kv_set(
            identities::IDENTITY_NAMESPACE,
            &identities::identity_key(workspace, &project.project_id, &seed.sha256)?,
            &content.identity,
        )?;
        if let Some(scene) = &content.scene_objects {
            self.restore_portable_scene_objects(workspace, &project, scene)?;
        }
        if let Some(locks) = &content.asset_locks {
            self.restore_portable_asset_locks(workspace, &project.project_id, locks)?;
        }
        self.kv_set(ORIGINS, &key, &serde_json::to_value(content)?)?;
        // Read through the normal context validator before committing any imported records.
        self.courseware_mapping(workspace, &project)?;
        self.courseware_scene_objects(workspace, &project)?;
        tx.commit()?;
        Ok(project)
    }

    /// Portable provenance proves local reuse only; it is never a paid-provider receipt.
    pub fn portable_courseware_media(
        &self,
        workspace: &str,
        project_id: &str,
        page_id: &str,
        action_id: &str,
    ) -> Result<Option<Media>> {
        let project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project is missing"))?;
        Ok(self
            .portable_courseware_media_entries(workspace, &project)?
            .remove(&(page_id.into(), action_id.into())))
    }

    pub fn portable_courseware_media_entries(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<HashMap<(String, String), Media>> {
        let Some(origin) = self.kv_get(ORIGINS, &storage_key(workspace, &project.project_id)?)?
        else {
            return Ok(HashMap::new());
        };
        let origin: Teaching = serde_json::from_value(origin)?;
        origin.validate(origin.commit_id, &origin.project.source.sha256)?;
        anyhow::ensure!(
            project.project_id == format!("portable-{}", origin.project_uuid),
            "COURSEWARE_CONFLICT: portable media source changed"
        );
        if project.source.sha256 != origin.project.source.sha256 {
            // Explicit source review preserves logical IDs; a bare source-hash edit cannot authorize reuse.
            self.courseware_mapping(workspace, project)?;
        }
        let original: HashMap<_, _> = origin
            .project
            .pages
            .iter()
            .flat_map(|page| {
                page.actions.iter().map(move |action| {
                    (
                        (
                            page.page_id.as_str(),
                            action["id"].as_str().unwrap_or_default(),
                        ),
                        action,
                    )
                })
            })
            .collect();
        let media: HashMap<_, _> = origin
            .media
            .iter()
            .map(|asset| (asset.id.as_str(), asset))
            .collect();
        let mut entries = HashMap::new();
        for page in &project.pages {
            for current in &page.actions {
                let id = current["id"].as_str().unwrap_or_default();
                let Some(saved) = original.get(&(page.page_id.as_str(), id)) else {
                    continue;
                };
                let field = match current["type"].as_str() {
                    Some("speech") if current["text"] == saved["text"] => "audioAssetId",
                    Some("audio_clip") => "audioAssetId",
                    Some("video_clip") => "videoAssetId",
                    _ => continue,
                };
                if current["type"] != saved["type"] || current[field] != saved[field] {
                    continue;
                }
                if let Some(asset) = current[field].as_str().and_then(|id| media.get(id)) {
                    entries.insert((page.page_id.clone(), id.into()), (*asset).clone());
                }
            }
        }
        Ok(entries)
    }
}
