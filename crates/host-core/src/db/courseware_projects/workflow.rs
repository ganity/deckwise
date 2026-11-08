//! Completion derives from saved actions and retained logical-page requirements.
use super::*;
use serde_json::json;
use std::collections::BTreeMap;

const NS: &str = "coursewareWorkflow.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub revision: u64,
    pub project_id: String,
    pub source_sha256: String,
    pub status: String,
    pub repair_attempts: BTreeMap<String, u8>,
    pub last_resume: Option<String>,
}

impl Database {
    pub fn courseware_completion(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<Value> {
        let assessments = self.courseware_assessment_page_ids(workspace, project)?;
        let native_saved = self.has_native_save_receipt(workspace, project)?;
        let mut issues = Vec::new();
        let mut add = |page: &CoursewarePage,
                       number: usize,
                       code: &str,
                       repair: &str,
                       action_id: Option<&Value>| {
            let mut issue = json!({"pageId":page.page_id,"pageNumber":number,"code":code,
                "repair":repair,"repairable":!page.locked});
            if let Some(id) = action_id {
                issue["actionId"] = id.clone();
            }
            issues.push(issue);
        };
        for (i, page) in project.pages.iter().enumerate() {
            if assessments.contains(&page.page_id) { continue; }
            let speeches: Vec<_> = page
                .actions
                .iter()
                .filter(|a| a["type"] == "speech")
                .collect();
            if speeches.is_empty()
                || speeches.iter().any(|a| {
                    a["text"].as_str().is_none_or(|s| s.trim().is_empty())
                        || project.task_type == "scene" && !native_saved && a["source"] != "generated"
                            && a["id"].as_str().is_some_and(|id| {
                                id.strip_prefix("narration-").is_some_and(|s| {
                                    !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit())
                                })
                            })
                })
            {
                add(page, i + 1, "NARRATION_MISSING", "narration", None);
            }
            for action in &page.actions {
                let (code, repair) = match action["type"].as_str() {
                    Some("speech") if action["audioAssetId"].as_str().is_none() => {
                        ("AUDIO_MISSING", "tts")
                    }
                    Some("music_slot") => ("MUSIC_PENDING", "music"),
                    Some("video_slot") => ("VIDEO_PENDING", "video"),
                    _ if action.get("attention").is_some() => ("ATTENTION_PENDING", "tts"),
                    _ => continue,
                };
                add(page, i + 1, code, repair, Some(&action["id"]));
            }
        }
        if let Some(scene) = self.courseware_scene_objects(workspace, project)? {
            for expected in scene["pages"].as_array().into_iter().flatten() {
                let Some((i, page)) = project
                    .pages
                    .iter()
                    .enumerate()
                    .find(|(_, p)| p.page_id == expected["pageId"])
                else {
                    if !native_saved {
                        issues.push(json!({"pageId":expected["pageId"],"code":"PAGE_MISSING","repair":"source","repairable":false}));
                    }
                    continue;
                };
                if assessments.contains(&page.page_id) { continue; }
                let teaching = &expected["teaching"];
                let question = &teaching["question"];
                if !question.is_null() {
                    let questions: Vec<_> = page
                        .actions
                        .iter()
                        .filter(|a| {
                            a["type"] == "interaction_checkpoint"
                                && a["checkpointKind"] == "chapter_summary"
                        })
                        .collect();
                    let code = if questions.is_empty() {
                        Some("QUESTION_MISSING")
                    } else if !questions
                        .iter()
                        .any(|a| scene_teaching::question_matches(a, question))
                    {
                        Some("QUESTION_TYPE_MISMATCH")
                    } else {
                        None
                    };
                    if let Some(code) = code {
                        issues.push(json!({"pageId":page.page_id,"pageNumber":i+1,"code":code,"repair":"narration","repairable":!page.locked}));
                    }
                }
                if !teaching["video"].is_null()
                    && !page.actions.iter().any(|a| a["type"] == "video_slot")
                {
                    let mut target = project.clone();
                    target.pages.retain(|p| p.page_id == page.page_id);
                    if self.portable_video_assets(workspace, &target)?.is_empty() {
                        issues.push(json!({"pageId":page.page_id,"pageNumber":i+1,"code":"VIDEO_MISSING","repair":"narration","repairable":!page.locked}));
                    }
                }
                if !teaching["music"].is_null()
                    && !page
                        .actions
                        .iter()
                        .any(|a| a["type"] == "music_slot" || a["type"] == "audio_clip")
                {
                    issues.push(json!({"pageId":page.page_id,"pageNumber":i+1,"code":"MUSIC_MISSING","repair":"narration","repairable":!page.locked}));
                }
            }
            if !native_saved && scene["pages"]
                .as_array()
                .is_some_and(|pages| pages.len() != project.pages.len())
            {
                issues.push(
                    json!({"code":"PAGE_COUNT_MISMATCH","repair":"source","repairable":false}),
                );
            }
        }
        let actions: Vec<_> = project.pages.iter().flat_map(|p| &p.actions).collect();
        let speeches = actions.iter().filter(|a| a["type"] == "speech").count();
        let audio = actions
            .iter()
            .filter(|a| a["type"] == "speech" && a["audioAssetId"].is_string())
            .count();
        Ok(
            json!({"ready":issues.is_empty(),"sourceSha256":project.source.sha256,
            "teachingRevision":project.teaching_revision,"issues":issues,
            "counts":{"pages":project.pages.len(),"speeches":speeches,"audioReady":audio,"audioMissing":speeches-audio,
                "musicClips":actions.iter().filter(|a| a["type"] == "audio_clip").count(),
                "musicPending":actions.iter().filter(|a| a["type"] == "music_slot").count(),
                "questions":actions.iter().filter(|a| a["type"] == "interaction_checkpoint" && a["checkpointKind"] == "chapter_summary").count()}}),
        )
    }

    pub fn courseware_workflow_checkpoint(
        &self,
        workspace: &str,
        session_id: &str,
        project_id: &str,
    ) -> Result<Option<Checkpoint>> {
        self.kv_get(
            NS,
            &serde_json::to_string(&(workspace, session_id, project_id))?,
        )?
        .map(serde_json::from_value)
        .transpose()
        .map_err(Into::into)
    }

    pub fn save_courseware_workflow_checkpoint(
        &self,
        workspace: &str,
        session_id: &str,
        turn_id: &str,
        expected_revision: u64,
        next: &Checkpoint,
    ) -> Result<Checkpoint> {
        let tx = self.conn.unchecked_transaction()?;
        let running: bool = self.conn.query_row("SELECT EXISTS(SELECT 1 FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.id=?1 AND t.session_id=?2 AND t.status='running' AND s.mode='agent' AND s.deleted_at IS NULL)", params![turn_id, session_id], |r| r.get(0))?;
        anyhow::ensure!(
            running,
            "TOOL_TURN_CANCELLED: workflow requires its running Agent turn"
        );
        anyhow::ensure!(
            matches!(next.status.as_str(), "running" | "blocked" | "completed")
                && next.repair_attempts.len() <= 100
                && next
                    .repair_attempts
                    .iter()
                    .all(|(k, v)| valid_hash(k) && *v <= 2)
                && next.last_resume.as_ref().is_none_or(|v| valid_hash(v)),
            "COURSEWARE_INVALID: invalid workflow checkpoint"
        );
        let project = self
            .get_courseware_project(workspace, &next.project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: workflow project missing"))?;
        anyhow::ensure!(
            project.source.sha256 == next.source_sha256,
            "COURSEWARE_CONFLICT: workflow source changed"
        );
        let current =
            self.courseware_workflow_checkpoint(workspace, session_id, &next.project_id)?;
        anyhow::ensure!(
            current
                .as_ref()
                .is_none_or(|c| c.source_sha256 == next.source_sha256),
            "COURSEWARE_CONFLICT: workflow source requires verified native-save lineage"
        );
        anyhow::ensure!(
            current.as_ref().map_or(0, |c| c.revision) == expected_revision
                && next.revision == expected_revision + 1,
            "COURSEWARE_CONFLICT: workflow checkpoint changed"
        );
        anyhow::ensure!(
            current
                .as_ref()
                .is_none_or(|c| c.repair_attempts.iter().all(|(key, count)| next
                    .repair_attempts
                    .get(key)
                    .is_some_and(|next| next >= count))),
            "COURSEWARE_CONFLICT: workflow repair budgets cannot be reset"
        );
        if next.status == "completed" {
            anyhow::ensure!(
                self.courseware_completion(workspace, &project)?["ready"] == true,
                "COURSEWARE_INCOMPLETE: approved teaching requirements remain unfinished"
            );
            self.validate_courseware_review_audio(workspace, &project, &project)?;
        }
        self.kv_set(
            NS,
            &serde_json::to_string(&(workspace, session_id, &next.project_id))?,
            &serde_json::to_value(next)?,
        )?;
        tx.commit()?;
        Ok(next.clone())
    }

    // Called only inside the transaction committing verified native-save lineage.
    pub(super) fn rebind_native_workflow(
        &self,
        workspace: &str,
        previous: &CoursewareProject,
        next: &CoursewareProject,
    ) -> Result<()> {
        let rows = self
            .conn
            .prepare("SELECT key,value_json FROM kv WHERE ns=?1")?
            .query_map([NS], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (key, raw) in rows {
            let scope: (String, String, String) = serde_json::from_str(&key)?;
            if scope.0 != workspace || scope.2 != previous.project_id {
                continue;
            }
            let mut checkpoint: Checkpoint = serde_json::from_str(&raw)?;
            if checkpoint.source_sha256 != previous.source.sha256 {
                continue;
            }
            checkpoint.source_sha256.clone_from(&next.source.sha256);
            checkpoint.revision += 1;
            checkpoint.last_resume = None;
            if checkpoint.status == "completed" {
                checkpoint.status = "blocked".into();
            }
            self.kv_set(NS, &key, &serde_json::to_value(checkpoint)?)?;
        }
        Ok(())
    }
}

fn valid_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

#[cfg(test)]
mod tests;
