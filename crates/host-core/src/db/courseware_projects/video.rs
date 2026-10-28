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
    pub model: String,
    pub prompt: String,
    pub idempotency_key: String,
    pub request_hash: String,
    pub phase: String,
    pub task_ref: Option<tts::TaskRef>,
    pub submission_scope: Option<media_scope::SubmissionScope>,
    pub asset: Option<VideoAsset>,
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
                && (12..=16 * 1024 * 1024).contains(&self.byte_length)
                && (1..=30_000).contains(&self.duration_ms)
                && (1..=4096).contains(&self.width)
                && (1..=4096).contains(&self.height),
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
        && action.as_object().is_some_and(|a| a.len() == 3)
        && action["id"].as_str().is_some_and(id)
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
                && !self.prompt.trim().is_empty()
                && self.prompt.encode_utf16().count() <= 4000
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
    pub fn matches(&self, project: &CoursewareProject) -> bool {
        self.source.revision == project.source.revision
            && self.source.sha256 == project.source.sha256
            && project.pages.iter().any(|page| {
                page.page_id == self.page_id
                    && !page.locked
                    && page.actions.iter().any(|action| {
                        action["id"] == self.slot_id
                            && (valid_slot(action) && action["prompt"] == self.prompt
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
        if let Some(saved) = self
            .list_courseware_videos(workspace, project_id, principal)?
            .into_iter()
            .find(|intent| {
                intent.page_id == page_id && intent.slot_id == slot_id && intent.matches(&project)
            })
        {
            anyhow::ensure!(
                saved.model == model,
                "COURSEWARE_CONFLICT: recover the original video model before preparing another"
            );
            return Ok(saved);
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
            model: model.into(),
            request_hash: request_hash(model, &prompt),
            prompt,
            phase: "prepared".into(),
            task_ref: None,
            submission_scope: None,
            asset: None,
        };
        self.save_video(workspace, &intent)?;
        tx.commit()?;
        Ok(intent)
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
