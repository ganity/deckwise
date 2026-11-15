//! Saved-page video slots, durable original requests and verified clip adoption.
use super::*;
use serde_json::json;
use sha2::{Digest, Sha256};

const NS: &str = "coursewareVideoIntents.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub intent_id: String,
    pub principal_key: String,
    pub project_id: String,
    pub page_id: String,
    pub slot_id: String,
    pub source: CoursewareSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_source: Option<CoursewareSource>,
    pub model: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u32>,
    pub idempotency_key: String,
    pub request_hash: String,
    pub phase: String,
    pub task_ref: Option<tts::TaskRef>,
    pub submission_scope: Option<media_scope::SubmissionScope>,
    pub asset: Option<VideoAsset>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub placements: Vec<Placement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Placement {
    pub page_id: String,
    pub action_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoAsset {
    pub sha256: String,
    pub byte_length: u64,
    pub duration_ms: u64,
    pub width: u64,
    pub height: u64,
}
impl VideoAsset {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            hash(&self.sha256)
                && (12..=40 * 1024 * 1024).contains(&self.byte_length)
                && self.duration_ms > 0
                && (1..=16_384).contains(&self.width)
                && (1..=16_384).contains(&self.height),
            "COURSEWARE_INVALID: invalid decoded video"
        );
        Ok(())
    }
    pub fn asset(&self) -> snapshots::Asset {
        snapshots::Asset {
            id: format!("video-{}", self.sha256),
            sha256: self.sha256.clone(),
            mime_type: "video/mp4".into(),
        }
    }
}
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn id(s: &str) -> bool {
    valid_id(s) && !matches!(s, "." | "..")
}
pub(super) fn valid_slot(action: &Value) -> bool {
    action["type"] == "video_slot"
        && action.as_object().is_some_and(|a| a.len() == 3 || a.len() == 4 && a.contains_key("durationSeconds"))
        && action["id"].as_str().is_some_and(id)
        && action.get("durationSeconds").is_none_or(|v| v.as_u64().is_some_and(|n| (4..=30).contains(&n)))
        && action["prompt"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 4000)
}
pub(super) fn valid_clip(action: &Value) -> bool {
    action["type"] == "video_clip"
        && action.as_object().is_some_and(|a| a.len() == 3)
        && action["id"].as_str().is_some_and(id)
        && action["videoAssetId"]
            .as_str()
            .and_then(|s| s.strip_prefix("video-"))
            .is_some_and(hash)
}
fn request_hash(model: &str, prompt: &str) -> String {
    let canonical = format!(
        "courseware-media-v1:5:video:{}:{}:{}:{}:-1:",
        model.encode_utf16().count(),
        model,
        prompt.encode_utf16().count(),
        prompt
    );
    hex::encode(Sha256::digest(canonical.as_bytes()))
}
fn prefix(workspace: &str, project: &str, principal: &str) -> Result<String> {
    anyhow::ensure!(
        hash(principal),
        "COURSEWARE_INVALID: invalid video principal"
    );
    let scope = serde_json::to_string(&(storage_key(workspace, project)?, principal))?;
    Ok(format!("{},", scope.trim_end_matches(']')))
}
fn key(workspace: &str, project: &str, principal: &str, intent: &str) -> Result<String> {
    anyhow::ensure!(id(intent), "COURSEWARE_INVALID: invalid video intent");
    Ok(format!(
        "{}{}]",
        prefix(workspace, project, principal)?,
        serde_json::to_string(intent)?
    ))
}
impl Intent {
    fn current_source(&self) -> &CoursewareSource {
        self.bound_source.as_ref().unwrap_or(&self.source)
    }
    fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            id(&self.intent_id)
                && id(&self.project_id)
                && id(&self.page_id)
                && id(&self.slot_id)
                && id(&self.model)
                && hash(&self.principal_key)
                && hash(&self.source.sha256)
                && id(&self.source.revision)
                && self
                    .bound_source
                    .as_ref()
                    .is_none_or(|s| hash(&s.sha256) && id(&s.revision))
                && !self.prompt.trim().is_empty()
                && self.prompt.encode_utf16().count() <= 4000
                && self.duration_seconds.is_none_or(|n| (4..=30).contains(&n))
                && self.idempotency_key == format!("video-{}", self.intent_id)
                && self.idempotency_key.len() <= 96
                && self.request_hash == request_hash(&self.model, &self.prompt)
                && matches!(
                    self.phase.as_str(),
                    "prepared" | "submission-unknown" | "submitted" | "adopted"
                )
                && self
                    .submission_scope
                    .as_ref()
                    .is_none_or(|scope| scope.valid())
                && (self.phase == "prepared") == self.submission_scope.is_none()
                && self.task_ref.as_ref().is_none_or(|task| id(&task.task_id)
                    && task.idempotency_key == self.idempotency_key
                    && task.request_hash == self.request_hash)
                && (matches!(self.phase.as_str(), "submitted" | "adopted"))
                    == self.task_ref.is_some(),
            "COURSEWARE_INVALID: corrupt video journal"
        );
        let mut ids = std::collections::HashSet::new();
        anyhow::ensure!(
            self.placements.len() <= 1000
                && (self.placements.is_empty() || self.phase == "adopted")
                && self.placements.iter().all(|p| id(&p.page_id)
                    && id(&p.action_id)
                    && p.action_id != self.slot_id
                    && ids.insert(&p.action_id)),
            "COURSEWARE_INVALID: invalid video placements"
        );
        if let Some(asset) = &self.asset {
            asset.validate()?;
            anyhow::ensure!(
                self.task_ref.is_some(),
                "COURSEWARE_INVALID: video asset has no task"
            );
        }
        anyhow::ensure!(
            self.phase != "adopted" || self.asset.is_some(),
            "COURSEWARE_INVALID: video adoption has no asset"
        );
        Ok(())
    }
    pub fn attached(&self, project: &CoursewareProject) -> bool {
        self.current_source() == &project.source
            && project.pages.iter().any(|page| {
                !page.locked
                    && page.actions.iter().any(|action| {
                        valid_clip(action)
                            && self
                                .asset
                                .as_ref()
                                .is_some_and(|a| action["videoAssetId"] == a.asset().id)
                            && (page.page_id == self.page_id && action["id"] == self.slot_id
                                || self.placements.iter().any(|p| {
                                    p.page_id == page.page_id && action["id"] == p.action_id
                                }))
                    })
            })
    }
    pub fn matches(&self, project: &CoursewareProject) -> bool {
        self.current_source() == &project.source
            && project.pages.iter().any(|page| {
                page.page_id == self.page_id
                    && !page.locked
                    && page.actions.iter().any(|action| {
                        action["id"] == self.slot_id
                            && (valid_slot(action) && action["prompt"] == self.prompt
                                && action["durationSeconds"].as_u64().map(|n| n as u32) == self.duration_seconds
                                || valid_clip(action)
                                    && self
                                        .asset
                                        .as_ref()
                                        .is_some_and(|a| action["videoAssetId"] == a.asset().id))
                    })
            })
    }
}
impl Database {
    pub(super) fn rebind_native_save_video(
        &self,
        workspace: &str,
        previous: &CoursewareProject,
        next: &CoursewareProject,
    ) -> Result<()> {
        anyhow::ensure!(
            !self.conn.is_autocommit(),
            "COURSEWARE_INVALID: video binding requires native-save transaction"
        );
        let scope = storage_key(workspace, &previous.project_id)?;
        let prefix = format!("[{},", serde_json::to_string(&scope)?);
        let records = self
            .conn
            .prepare(
                "SELECT value_json FROM kv WHERE ns=?1 AND substr(key,1,length(?2))=?2 LIMIT 1001",
            )?
            .query_map(params![NS, prefix], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        anyhow::ensure!(
            records.len() <= 1000,
            "COURSEWARE_INVALID: too many video bindings"
        );
        for raw in records {
            let mut intent: Intent = serde_json::from_str(&raw)?;
            intent.validate()?;
            let unchanged = previous.pages.iter().any(|p| {
                next.pages
                    .iter()
                    .find(|n| n.page_id == p.page_id)
                    .is_some_and(|n| {
                        p.actions.iter().any(|a| {
                            (valid_slot(a) || valid_clip(a))
                                && (p.page_id == intent.page_id && a["id"] == intent.slot_id
                                    || intent
                                        .placements
                                        .iter()
                                        .any(|v| v.page_id == p.page_id && a["id"] == v.action_id))
                                && n.actions.contains(a)
                        })
                    })
            });
            if intent.current_source() == &previous.source && unchanged {
                intent.bound_source = Some(next.source.clone());
                self.save_video(workspace, &intent)?;
            }
        }
        Ok(())
    }
    fn save_video(&self, workspace: &str, intent: &Intent) -> Result<()> {
        intent.validate()?;
        let key = key(
            workspace,
            &intent.project_id,
            &intent.principal_key,
            &intent.intent_id,
        )?;
        self.kv_set(NS, &key, &serde_json::to_value(intent)?)?;
        anyhow::ensure!(
            self.kv_get(NS, &key)? == Some(serde_json::to_value(intent)?),
            "COURSEWARE_CONFLICT: video journal was not saved"
        );
        Ok(())
    }
    pub fn current_courseware_video_asset(
        &self,
        workspace: &str,
        project: &CoursewareProject,
        principal: &str,
        intent_id: &str,
        session_id: &str,
    ) -> Result<VideoAsset> {
        let intent =
            self.get_courseware_video(workspace, &project.project_id, principal, intent_id)?;
        anyhow::ensure!(
            intent.phase == "adopted"
                && intent.attached(project)
                && intent
                    .submission_scope
                    .as_ref()
                    .is_some_and(|scope| scope.session_id == session_id),
            "COURSEWARE_CONFLICT: video is not attached to current teaching"
        );
        intent
            .asset
            .ok_or_else(|| anyhow::anyhow!("COURSEWARE_CONFLICT: missing video archive"))
    }

    pub(super) fn portable_video_assets(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<Vec<VideoAsset>> {
        let scope = storage_key(workspace, &project.project_id)?;
        let prefix = format!("[{},", serde_json::to_string(&scope)?);
        let mut query = self.conn.prepare("SELECT key FROM kv WHERE ns=?1 AND substr(key,1,length(?2))=?2 ORDER BY key LIMIT 1001")?;
        let keys = query
            .query_map(params![NS, prefix], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        anyhow::ensure!(
            keys.len() <= 1000,
            "COURSEWARE_INVALID: too many video receipts for copy"
        );
        let mut assets = Vec::new();
        // A manual lock prevents editing, not copying an already adopted clip.
        let mut readable = project.clone();
        for page in &mut readable.pages {
            page.locked = false;
        }
        for key in keys {
            let (saved_scope, principal, intent): (String, String, String) =
                serde_json::from_str(&key)?;
            anyhow::ensure!(
                saved_scope == scope,
                "COURSEWARE_INVALID: video copy scope differs"
            );
            let record =
                self.get_courseware_video(workspace, &project.project_id, &principal, &intent)?;
            if record.phase == "adopted" && record.attached(&readable) {
                if let Some(asset) = record.asset {
                    assets.push(asset);
                }
            }
        }
        Ok(assets)
    }

    pub fn get_courseware_video(
        &self,
        workspace: &str,
        project: &str,
        principal: &str,
        intent: &str,
    ) -> Result<Intent> {
        let saved: Intent = serde_json::from_value(
            self.kv_get(NS, &key(workspace, project, principal, intent)?)?
                .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: video intent not found"))?,
        )?;
        saved.validate()?;
        anyhow::ensure!(
            saved.project_id == project
                && saved.principal_key == principal
                && saved.intent_id == intent,
            "COURSEWARE_INVALID: video owner differs"
        );
        Ok(saved)
    }
    pub fn list_courseware_videos(
        &self,
        workspace: &str,
        project: &str,
        principal: &str,
    ) -> Result<Vec<Intent>> {
        let prefix = prefix(workspace, project, principal)?;
        let mut statement = self.conn.prepare("SELECT value_json FROM kv WHERE ns=?1 AND substr(key,1,length(?2))=?2 ORDER BY updated_at DESC,key LIMIT 1001")?;
        let rows = statement
            .query_map(params![NS, prefix], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        anyhow::ensure!(
            rows.len() <= 1000,
            "COURSEWARE_INVALID: video journal exceeds limit"
        );
        rows.into_iter()
            .map(|row| {
                let saved: Intent = serde_json::from_str(&row)?;
                self.get_courseware_video(workspace, project, principal, &saved.intent_id)
            })
            .collect()
    }
    pub fn prepare_courseware_video(
        &self,
        workspace: &str,
        project_id: &str,
        principal: &str,
        page_id: &str,
        slot_id: &str,
        model: &str,
    ) -> Result<Intent> {
        self.ensure_no_source_adoption(workspace)?;
        let project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        let page = project
            .pages
            .iter()
            .find(|page| page.page_id == page_id && !page.locked)
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: video page missing or locked"))?;
        let intents = self.list_courseware_videos(workspace, project_id, principal)?;
        if let Some(saved) = intents.iter()
            .find(|intent| {
                intent.page_id == page_id && intent.slot_id == slot_id && intent.matches(&project)
                    && !intents.iter().any(|next| next.intent_id == format!("retry-{}", hex::encode(Sha256::digest(intent.intent_id.as_bytes()))))
            })
        {
            anyhow::ensure!(
                saved.model == model,
                "COURSEWARE_CONFLICT: recover the original video model before preparing another"
            );
            return Ok(saved.clone());
        }
        let slot = page
            .actions
            .iter()
            .find(|action| action["id"] == slot_id && valid_slot(action))
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: video slot missing"))?;
        let tx = self.conn.unchecked_transaction()?;
        let intent_id = uuid::Uuid::new_v4().to_string();
        let prompt = slot["prompt"].as_str().unwrap().to_owned();
        let intent = Intent {
            idempotency_key: format!("video-{intent_id}"),
            intent_id,
            principal_key: principal.into(),
            project_id: project_id.into(),
            page_id: page_id.into(),
            slot_id: slot_id.into(),
            source: project.source,
            bound_source: None,
            model: model.into(),
            request_hash: request_hash(model, &prompt),
            prompt,
            duration_seconds: slot["durationSeconds"].as_u64().map(|n| n as u32),
            phase: "prepared".into(),
            task_ref: None,
            submission_scope: None,
            asset: None,
            placements: Vec::new(),
        };
        self.save_video(workspace, &intent)?;
        tx.commit()?;
        Ok(intent)
    }
    pub fn retry_courseware_video(&self, workspace: &str, project_id: &str, principal: &str, intent_id: &str) -> Result<Intent> {
        self.ensure_no_source_adoption(workspace)?;
        let original = self.get_courseware_video(workspace, project_id, principal, intent_id)?;
        let retry_id = format!("retry-{}", hex::encode(Sha256::digest(intent_id.as_bytes())));
        let project = self.get_courseware_project(workspace, project_id)?.ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        let intents = self.list_courseware_videos(workspace, project_id, principal)?;
        if let Some(existing) = intents.iter().find(|i| i.intent_id == retry_id && i.matches(&project)) {
            return Ok(existing.clone());
        }
        anyhow::ensure!(original.matches(&project) && original.phase == "submitted" && original.task_ref.is_some() && original.asset.is_none(),
            "COURSEWARE_CONFLICT: video retry target changed or is already satisfied");
        anyhow::ensure!(intents.len() < 1000 && !intents.iter().any(|i| i.intent_id == retry_id), "COURSEWARE_CONFLICT: video retry changed or journal is full");
        let mut retried = original;
        retried.intent_id = retry_id;
        retried.idempotency_key = format!("video-{}", retried.intent_id);
        retried.phase = "prepared".into();
        retried.task_ref = None;
        retried.submission_scope = None;
        self.save_video(workspace, &retried)?;
        Ok(retried)
    }

    pub fn begin_courseware_video(
        &self,
        workspace: &str,
        project: &str,
        principal: &str,
        intent: &str,
        session: &str,
    ) -> Result<Intent> {
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        let mut saved = self.get_courseware_video(workspace, project, principal, intent)?;
        let current = self
            .get_courseware_project(workspace, project)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        anyhow::ensure!(
            saved.phase == "prepared" && saved.matches(&current),
            "COURSEWARE_CONFLICT: video dispatch changed or already began"
        );
        saved.submission_scope = Some(self.courseware_media_submission_scope(session)?);
        saved.phase = "submission-unknown".into();
        self.save_video(workspace, &saved)?;
        tx.commit()?;
        Ok(saved)
    }
    pub fn bind_courseware_video(
        &self,
        workspace: &str,
        project: &str,
        principal: &str,
        intent: &str,
        task: tts::TaskRef,
    ) -> Result<Intent> {
        let tx = self.conn.unchecked_transaction()?;
        let mut saved = self.get_courseware_video(workspace, project, principal, intent)?;
        anyhow::ensure!(
            saved.phase != "prepared" && saved.task_ref.as_ref().is_none_or(|old| old == &task),
            "COURSEWARE_CONFLICT: video task differs"
        );
        saved.task_ref = Some(task);
        if saved.phase != "adopted" {
            saved.phase = "submitted".into();
        }
        self.save_video(workspace, &saved)?;
        tx.commit()?;
        Ok(saved)
    }
    pub fn stage_courseware_video(
        &self,
        workspace: &str,
        project: &str,
        principal: &str,
        intent: &str,
        task: &tts::TaskRef,
        asset: VideoAsset,
    ) -> Result<Intent> {
        let tx = self.conn.unchecked_transaction()?;
        let mut saved = self.get_courseware_video(workspace, project, principal, intent)?;
        anyhow::ensure!(
            saved.task_ref.as_ref() == Some(task)
                && saved.asset.as_ref().is_none_or(|old| old == &asset),
            "COURSEWARE_CONFLICT: video result differs"
        );
        saved.asset = Some(asset);
        self.save_video(workspace, &saved)?;
        tx.commit()?;
        Ok(saved)
    }
    pub fn reuse_courseware_video(
        &self,
        workspace: &str,
        write: &TeachingWrite,
        principal: &str,
        intent_id: &str,
        session_id: &str,
        action_id: &str,
    ) -> Result<CoursewareProject> {
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        anyhow::ensure!(id(action_id), "COURSEWARE_INVALID: invalid video action");
        let project = self
            .get_courseware_project(workspace, &write.project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        let asset = self.current_courseware_video_asset(
            workspace, &project, principal, intent_id, session_id,
        )?;
        let mut saved =
            self.get_courseware_video(workspace, &write.project_id, principal, intent_id)?;
        anyhow::ensure!(
            saved
                .submission_scope
                .as_ref()
                .map(serde_json::to_value)
                .transpose()?
                == Some(serde_json::to_value(
                    self.courseware_media_submission_scope(session_id)?
                )?),
            "COURSEWARE_CONFLICT: video submission scope changed"
        );
        anyhow::ensure!(
            project.source.revision == write.expected_source_revision,
            "COURSEWARE_CONFLICT: video source changed"
        );
        if saved
            .placements
            .iter()
            .any(|p| p.action_id == action_id && p.page_id == write.page_id)
        {
            anyhow::ensure!(
                project.pages.iter().any(|p| p.page_id == write.page_id
                    && p.actions.iter().any(|a| valid_clip(a)
                        && a["id"] == action_id
                        && a["videoAssetId"] == asset.asset().id)),
                "COURSEWARE_CONFLICT: reused video was removed or changed"
            );
            tx.commit()?;
            return Ok(project);
        }
        let page = project
            .pages
            .iter()
            .find(|p| p.page_id == write.page_id && !p.locked)
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: video target page missing or locked"))?;
        anyhow::ensure!(
            project
                .pages
                .iter()
                .all(|p| p.actions.iter().all(|a| a["id"] != action_id)),
            "COURSEWARE_CONFLICT: video action already exists"
        );
        let mut update = write.clone();
        update.actions = page.actions.clone();
        update
            .actions
            .push(json!({"id":action_id,"type":"video_clip","videoAssetId":asset.asset().id}));
        let project = self.write_courseware_teaching(workspace, &update)?;
        saved.placements.push(Placement {
            page_id: write.page_id.clone(),
            action_id: action_id.into(),
        });
        self.save_video(workspace, &saved)?;
        let project = self.finish_generated_scene_page(workspace, project, &write.page_id)?;
        tx.commit()?;
        Ok(project)
    }

    pub fn adopt_courseware_video(
        &self,
        workspace: &str,
        project_id: &str,
        principal: &str,
        intent: &str,
        expected_teaching: &str,
    ) -> Result<CoursewareProject> {
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        let mut saved = self.get_courseware_video(workspace, project_id, principal, intent)?;
        let project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        anyhow::ensure!(
            saved.matches(&project),
            "COURSEWARE_CONFLICT: video source, slot or lock changed"
        );
        if saved.phase == "adopted" {
            return Ok(project);
        }
        anyhow::ensure!(
            project.teaching_revision == expected_teaching,
            "COURSEWARE_CONFLICT: teaching changed before video adoption"
        );
        let asset = saved
            .asset
            .as_ref()
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: video is not archived"))?;
        let page = project
            .pages
            .iter()
            .find(|page| page.page_id == saved.page_id)
            .unwrap();
        let mut actions = page.actions.clone();
        let slot = actions
            .iter_mut()
            .find(|action| action["id"] == saved.slot_id)
            .unwrap();
        *slot = json!({"id":saved.slot_id,"type":"video_clip","videoAssetId":asset.asset().id});
        let write = TeachingWrite {
            project_id: project_id.into(),
            page_id: saved.page_id.clone(),
            expected_source_revision: project.source.revision.clone(),
            expected_teaching_revision: expected_teaching.into(),
            actions,
        };
        let project = self.write_courseware_teaching(workspace, &write)?;
        saved.phase = "adopted".into();
        self.save_video(workspace, &saved)?;
        let project = self.finish_generated_scene_page(workspace, project, &saved.page_id)?;
        tx.commit()?;
        Ok(project)
    }
}

#[cfg(test)]
mod tests;
