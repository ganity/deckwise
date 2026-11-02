//! Adopted sequential music clips; exported tasks remain immutable.
use super::*;
use media_scope::SubmissionScope;
use snapshots::Asset;
use tts::TaskRef;

pub const JOURNAL: &str = "coursewareMediaCanvasMusic.v1";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub version: u8,
    pub project_id: String,
    pub page_id: String,
    pub action_id: String,
    pub source: CoursewareSource,
    pub prompt: String,
}

impl Target {
    pub fn valid(&self) -> bool {
        self.version == 1
            && valid_id(&self.project_id)
            && valid_id(&self.page_id)
            && valid_id(&self.action_id)
            && valid_id(&self.source.revision)
            && hash(&self.source.sha256)
            && !self.prompt.trim().is_empty()
            && self.prompt.encode_utf16().count() <= 4000
    }
    pub fn matches(&self, project: &CoursewareProject) -> bool {
        self.project_id == project.project_id
            && self.source == project.source
            && project.pages.iter().any(|p| {
                p.page_id == self.page_id
                    && !p.locked
                    && p.actions.iter().any(|a| {
                        a["id"] == self.action_id && valid_slot(a) && a["prompt"] == self.prompt
                    })
            })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub session_id: String,
    pub principal_key: String,
    pub intent_id: String,
    pub project_id: String,
    pub page_id: String,
    pub expected_source_revision: String,
    pub expected_teaching_revision: String,
    pub duration_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Adoption {
    pub selection: Selection,
    pub source: CoursewareSource,
    pub bound_source: CoursewareSource,
    pub action_id: String,
    pub asset: Asset,
    pub byte_length: usize,
    pub task_ref: TaskRef,
    pub submission_scope: SubmissionScope,
    pub adopted_teaching_revision: String,
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn valid_slot(action: &Value) -> bool {
    action["type"] == "music_slot" && action.as_object().is_some_and(|a| a.len() == 4)
        && action["id"].as_str().is_some_and(valid_id)
        && action["prompt"].as_str().is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 4000)
        && action["title"].as_str().is_some_and(|s| !s.trim().is_empty() && s.encode_utf16().count() <= 100)
}

pub fn valid_clip(action: &Value) -> bool {
    action.as_object().is_some_and(|object| object.len() == 3)
        && action["type"] == "audio_clip"
        && valid_id(action["id"].as_str().unwrap_or_default())
        && action["audioAssetId"]
            .as_str()
            .and_then(|id| id.strip_prefix("music-"))
            .is_some_and(hash)
}

impl Adoption {
    pub fn view(&self) -> Value {
        serde_json::json!({"intentId":self.selection.intent_id,"pageId":self.selection.page_id,
            "actionId":self.action_id,"assetId":self.asset.id,"durationMs":self.selection.duration_ms})
    }

    pub(super) fn attached(&self, project: &CoursewareProject) -> bool {
        project.project_id == self.selection.project_id
            && self.bound_source.revision == project.source.revision
            && self.bound_source.sha256 == project.source.sha256
            && project.pages.iter().any(|page| {
                page.page_id == self.selection.page_id
                    && page.actions.iter().any(|action| {
                        valid_clip(action)
                            && action["id"] == self.action_id
                            && action["audioAssetId"] == self.asset.id
                    })
            })
    }
}

fn key(workspace: &str, project_id: &str) -> Result<String> {
    Ok(serde_json::to_string(&(
        "adoptions",
        storage_key(workspace, project_id)?,
    ))?)
}

impl Database {
    pub(super) fn rebind_native_save_music(
        &self,
        workspace: &str,
        previous: &CoursewareProject,
        next: &CoursewareProject,
    ) -> Result<()> {
        use sha2::{Digest, Sha256};
        anyhow::ensure!(
            !self.conn.is_autocommit(),
            "COURSEWARE_INVALID: music binding requires native-save transaction"
        );
        let prefix = format!(
            "[{},",
            serde_json::to_string(&std::fs::canonicalize(workspace)?)?
        );
        let rows = self.conn.prepare("SELECT key,value_json FROM kv WHERE ns=?1 AND substr(key,1,length(?2))=?2 LIMIT 1001")?
            .query_map(params![JOURNAL, prefix], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        anyhow::ensure!(
            rows.len() <= 1000,
            "COURSEWARE_INVALID: too many music journals"
        );
        for (key, raw) in rows {
            let mut intents: Vec<Value> = serde_json::from_str(&raw)?;
            for intent in &mut intents {
                if intent["request"]["kind"] != "music" {
                    continue;
                }
                let mut target = if intent.get("target").is_some() {
                    let target: Target = serde_json::from_value(intent["target"].clone())?;
                    anyhow::ensure!(target.valid(), "COURSEWARE_INVALID: invalid music target");
                    if target.project_id != previous.project_id || target.source != previous.source
                    {
                        continue;
                    }
                    target
                } else {
                    let Some(draft) = intent["draft"]["id"].as_str() else {
                        continue;
                    };
                    let matches = previous
                        .pages
                        .iter()
                        .enumerate()
                        .flat_map(|(index, page)| {
                            let prefix =
                                format!("auto-music-{}-p{}-", previous.source.sha256, index + 1);
                            page.actions.iter().filter_map(move |action| {
                                let id = action["id"].as_str()?;
                                let suffix =
                                    draft.strip_prefix(&prefix)?.strip_prefix(&format!(
                                        "{}-",
                                        &hex::encode(Sha256::digest(id.as_bytes()))[..16]
                                    ))?;
                                if suffix.len() != 24
                                    || !suffix.bytes().all(|c| c.is_ascii_hexdigit())
                                    || !valid_slot(action)
                                {
                                    return None;
                                }
                                Some(Target {
                                    version: 1,
                                    project_id: previous.project_id.clone(),
                                    page_id: page.page_id.clone(),
                                    action_id: id.into(),
                                    source: previous.source.clone(),
                                    prompt: action["prompt"].as_str()?.into(),
                                })
                            })
                        })
                        .collect::<Vec<_>>();
                    if matches.len() != 1 {
                        if draft.starts_with(&format!("auto-music-{}-p", previous.source.sha256)) {
                            intent["unresolvedProjectId"] =
                                Value::String(previous.project_id.clone());
                        }
                        continue;
                    }
                    matches[0].clone()
                };
                let action = |p: &CoursewareProject| {
                    p.pages
                        .iter()
                        .find(|p| p.page_id == target.page_id)
                        .and_then(|p| p.actions.iter().find(|a| a["id"] == target.action_id))
                        .cloned()
                };
                let old = action(previous);
                if old.is_some() && old == action(next) {
                    target.source = next.source.clone();
                    intent["target"] = serde_json::to_value(target)?;
                }
            }
            let targets = intents
                .iter()
                .filter(|i| i["request"]["kind"] == "music" && i.get("target").is_some())
                .map(|i| (i["intentId"].clone(), i["target"].clone()))
                .collect::<Vec<_>>();
            for intent in &mut intents {
                if let Some((_, target)) = targets
                    .iter()
                    .find(|(id, _)| *id == intent["sourceIntentId"])
                {
                    intent["target"] = target.clone();
                }
            }
            self.kv_set(JOURNAL, &key, &serde_json::to_value(intents)?)?;
        }
        Ok(())
    }
    /// An unapproved slot is removable only while every matching order is unsubmitted.
    pub(super) fn music_slot_has_submission(&self, workspace: &str, slot_id: &str) -> Result<bool> {
        use sha2::{Digest, Sha256};
        let root = std::fs::canonicalize(workspace)?;
        let slot = format!(
            "-{}-",
            &hex::encode(Sha256::digest(slot_id.as_bytes()))[..16]
        );
        let rows = self
            .conn
            .prepare("SELECT key,value_json FROM kv WHERE ns=?1")?
            .query_map([JOURNAL], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (key, raw) in rows {
            let scope: Vec<String> = serde_json::from_str(&key)?;
            if scope.len() != 3 || std::path::Path::new(&scope[0]) != root {
                continue;
            }
            let intents: Vec<Value> = serde_json::from_str(&raw)?;
            if intents.iter().any(|i| {
                i["draft"]["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("auto-music-") && id.contains(&slot))
                    && (!matches!(i["phase"].as_str(), Some("prepared" | "rejected"))
                        || !i["taskRef"].is_null())
            }) {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub fn courseware_music_adoptions(
        &self,
        workspace: &str,
        project_id: &str,
    ) -> Result<Vec<Adoption>> {
        let records: Vec<Adoption> = self
            .kv_get(JOURNAL, &key(workspace, project_id)?)?
            .map(serde_json::from_value)
            .transpose()?
            .unwrap_or_default();
        let mut actions = std::collections::HashSet::new();
        let mut intents = std::collections::HashSet::new();
        anyhow::ensure!(
            records.len() <= 300,
            "COURSEWARE_INVALID: too many adopted music clips"
        );
        for record in &records {
            let s = &record.selection;
            anyhow::ensure!(
                s.project_id == project_id
                    && valid_id(&s.session_id)
                    && hash(&s.principal_key)
                    && valid_id(&s.intent_id)
                    && valid_id(&s.page_id)
                    && s.slot_id.as_ref().is_none_or(|id| valid_id(id))
                    && valid_id(&s.expected_source_revision)
                    && valid_id(&s.expected_teaching_revision)
                    && (1..=86_400_000).contains(&s.duration_ms)
                    && valid_id(&record.action_id)
                    && actions.insert(&record.action_id)
                    && intents.insert((&s.session_id, &s.principal_key, &s.intent_id, &s.page_id))
                    && record.source.revision == s.expected_source_revision
                    && hash(&record.source.sha256)
                    && valid_id(&record.bound_source.revision)
                    && hash(&record.bound_source.sha256)
                    && valid_id(&record.adopted_teaching_revision)
                    && record.asset.id == format!("music-{}", record.asset.sha256)
                    && hash(&record.asset.sha256)
                    && record.asset.mime_type == "audio/mpeg"
                    && (4..=16 * 1024 * 1024).contains(&record.byte_length)
                    && record.submission_scope.valid()
                    && record.submission_scope.session_id == s.session_id,
                "COURSEWARE_INVALID: invalid music adoption receipt"
            );
            self.validate_courseware_music_export(workspace, record)?;
        }
        Ok(records)
    }

    fn validate_courseware_music_export(&self, workspace: &str, record: &Adoption) -> Result<()> {
        let s = &record.selection;
        let journal_key = serde_json::to_string(&(
            std::fs::canonicalize(workspace)?,
            &s.session_id,
            &s.principal_key,
        ))?;
        let journal = self.kv_get(JOURNAL, &journal_key)?;
        let export = journal
            .as_ref()
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|intent| intent["intentId"] == s.intent_id)
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: music export provenance is missing"))?;
        anyhow::ensure!(
            export["request"]["kind"] == "music-export"
                && export["phase"] == "submitted"
                && export["taskRef"] == serde_json::to_value(&record.task_ref)?
                && export["submissionScope"] == serde_json::to_value(&record.submission_scope)?
                && export["asset"]
                    == serde_json::json!({"taskRef":record.task_ref,"sha256":record.asset.sha256,
                "mimeType":record.asset.mime_type,"byteLength":record.byte_length}),
            "COURSEWARE_CONFLICT: adopted music differs from its exported archive"
        );
        Ok(())
    }

    pub fn adopt_courseware_music(
        &self,
        workspace: &str,
        selection: Selection,
        asset: Asset,
        byte_length: usize,
        task_ref: TaskRef,
        submission_scope: SubmissionScope,
    ) -> Result<(CoursewareProject, Adoption)> {
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        anyhow::ensure!(
            serde_json::to_value(&submission_scope)?
                == serde_json::to_value(
                    self.courseware_media_submission_scope(&selection.session_id)?
                )?,
            "COURSEWARE_CONFLICT: music submission scope changed"
        );
        let project = self
            .get_courseware_project(workspace, &selection.project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: courseware project not found"))?;
        anyhow::ensure!(
            project.source.revision == selection.expected_source_revision,
            "COURSEWARE_CONFLICT: music target source changed"
        );
        let mut records = self.courseware_music_adoptions(workspace, &selection.project_id)?;
        if let Some(old) = records.iter().find(|old| {
            old.selection.session_id == selection.session_id
                && old.selection.principal_key == selection.principal_key
                && old.selection.intent_id == selection.intent_id
                && old.selection.page_id == selection.page_id
        }) {
            anyhow::ensure!(
                old.selection.duration_ms == selection.duration_ms
                    && old.selection.slot_id == selection.slot_id
                    && (old.selection.expected_teaching_revision
                        == selection.expected_teaching_revision
                        || project.teaching_revision == selection.expected_teaching_revision)
                    && serde_json::to_value(&old.asset)? == serde_json::to_value(&asset)?
                    && old.byte_length == byte_length
                    && old.task_ref == task_ref
                    && old.attached(&project),
                "COURSEWARE_CONFLICT: adopted music target or content changed"
            );
            tx.commit()?;
            self.source_adoption_barrier()?;
            return Ok((project, old.clone()));
        }
        let page = project
            .pages
            .iter()
            .find(|page| page.page_id == selection.page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_PAGE_NOT_FOUND: music target page not found"))?;
        let mut actions = page.actions.clone();
        let action_id = selection.slot_id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let clip = serde_json::json!({"id":action_id,"type":"audio_clip","audioAssetId":asset.id});
        if let Some(slot_id) = &selection.slot_id {
            let index = actions.iter().position(|a| a["id"] == *slot_id && valid_slot(a))
                .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: music slot changed or was removed"))?;
            actions[index] = clip;
        } else { actions.push(clip); }
        let saved = self.write_courseware_teaching(
            workspace,
            &TeachingWrite {
                project_id: selection.project_id.clone(),
                page_id: selection.page_id.clone(),
                expected_source_revision: selection.expected_source_revision.clone(),
                expected_teaching_revision: selection.expected_teaching_revision.clone(),
                actions,
            },
        )?;
        let record = Adoption {
            selection,
            source: project.source.clone(),
            bound_source: project.source,
            action_id,
            asset,
            byte_length,
            task_ref,
            submission_scope,
            adopted_teaching_revision: saved.teaching_revision.clone(),
        };
        records.push(record.clone());
        self.kv_set(
            JOURNAL,
            &key(workspace, &saved.project_id)?,
            &serde_json::to_value(&records)?,
        )?;
        self.courseware_music_adoptions(workspace, &saved.project_id)?;
        let saved =
            self.finish_generated_scene_page(workspace, saved, &record.selection.page_id)?;
        tx.commit()?;
        self.source_adoption_barrier()?;
        Ok((saved, record))
    }

    pub fn courseware_music_snapshot_asset(
        &self,
        workspace: &str,
        project: &CoursewareProject,
        session_id: &str,
        principal_key: &str,
        intent_id: &str,
        asset: &Asset,
    ) -> Result<Adoption> {
        let records = self.courseware_music_adoptions(workspace, &project.project_id)?;
        let current_scope =
            serde_json::to_value(self.courseware_media_submission_scope(session_id)?)?;
        let record = records
            .iter()
            .find(|record| {
                record.selection.session_id == session_id
                    && record.selection.principal_key == principal_key
                    && record.selection.intent_id == intent_id
                    && record.attached(project)
                    && serde_json::to_value(&record.asset).ok() == serde_json::to_value(asset).ok()
            })
            .ok_or_else(|| anyhow!("COURSEWARE_CONFLICT: adopted music provenance is missing"))?;
        anyhow::ensure!(
            record.attached(project)
                && serde_json::to_value(&record.asset)? == serde_json::to_value(asset)?
                && serde_json::to_value(&record.submission_scope)? == current_scope,
            "COURSEWARE_CONFLICT: adopted music does not match current teaching or scope"
        );
        for page in &project.pages {
            for action in &page.actions {
                if action["type"] == "audio_clip" && action["audioAssetId"] == asset.id {
                    anyhow::ensure!(
                        records
                            .iter()
                            .any(|candidate| candidate.selection.session_id == session_id
                                && candidate.selection.principal_key == principal_key
                                && candidate.selection.page_id == page.page_id
                                && candidate.action_id == action["id"]
                                && candidate.asset.id == asset.id
                                && serde_json::to_value(&candidate.submission_scope)
                                    .ok()
                                    .as_ref()
                                    == Some(&current_scope)
                                && candidate.attached(project)),
                        "COURSEWARE_CONFLICT: music action has no matching adoption receipt"
                    );
                }
            }
        }
        Ok(record.clone())
    }

    pub(in crate::db) fn review_courseware_music(
        &self,
        workspace: &str,
        previous: &CoursewareProject,
        next: &CoursewareProject,
        rebind: bool,
    ) -> Result<()> {
        anyhow::ensure!(
            !self.conn.is_autocommit(),
            "COURSEWARE_INVALID: music rebinding requires source-review transaction"
        );
        let mut records = self.courseware_music_adoptions(workspace, &previous.project_id)?;
        let mut matched = std::collections::HashSet::new();
        for record in &mut records {
            let preserved = next.pages.iter().any(|page| {
                page.page_id == record.selection.page_id
                    && page.actions.iter().any(|action| {
                        valid_clip(action)
                            && action["id"] == record.action_id
                            && action["audioAssetId"] == record.asset.id
                    })
            });
            if !record.attached(previous) || !preserved {
                continue;
            }
            matched.insert((
                record.selection.page_id.clone(),
                record.action_id.clone(),
                record.asset.id.clone(),
            ));
            if rebind {
                record.bound_source = next.source.clone();
            }
        }
        for page in &next.pages {
            for action in &page.actions {
                if action["type"] == "audio_clip" {
                    anyhow::ensure!(valid_clip(action) && matched.contains(&(page.page_id.clone(),
                action["id"].as_str().unwrap_or_default().to_owned(), action["audioAssetId"].as_str().unwrap_or_default().to_owned())),
                "COURSEWARE_AUDIO_REQUIRED: source review requires a matching adopted music receipt");
                }
            }
        }
        if rebind && !records.is_empty() {
            self.kv_set(
                JOURNAL,
                &key(workspace, &previous.project_id)?,
                &serde_json::to_value(records)?,
            )?;
        }
        Ok(())
    }
}
