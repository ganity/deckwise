use super::*;
use serde::{Deserialize, Serialize};

const NAMESPACE: &str = "coursewareProjects.v1";
const MAX_BYTES: usize = 2 * 1024 * 1024;
const HISTORY_NAMESPACE: &str = "coursewareHistory.v1";

pub mod asset_locks;
mod candidates;
pub mod classroom;
pub mod chat_changes;
mod identities;
pub mod media_scope;
pub mod music;
pub mod native_save;
pub mod portable;
pub mod question;
pub mod reviews;
pub mod scene_objects;
pub mod scene_teaching;
pub mod snapshots;
pub mod source_candidates;
mod teaching_history;
pub mod tts;
pub mod video;
pub mod workflow;

pub(crate) fn present_option<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoursewareSource {
    pub revision: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoursewareEducationContext {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub school_stage: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub grade: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub subject: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub custom_subject_name: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub textbook_version: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub chapter: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub lesson_type: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub visual_style: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub full_english_teaching: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "read_body_page_limit")]
    pub body_page_limit: Option<u8>,
}

fn read_body_page_limit<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<u8>, D::Error> {
    let value = u8::deserialize(deserializer)?;
    if !(1..=30).contains(&value) {
        return Err(serde::de::Error::custom("bodyPageLimit must be between 1 and 30"));
    }
    Ok(Some(value))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoursewarePage {
    pub page_id: String,
    pub actions: Vec<Value>,
    pub locked: bool,
    /// Legacy wire metadata; never a human approval or playback gate.
    pub review_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CoursewareProject {
    pub schema_version: String,
    pub project_id: String,
    pub task_type: String,
    pub title: String,
    pub source: CoursewareSource,
    pub teaching_revision: String,
    pub pages: Vec<CoursewarePage>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub education_context: Option<CoursewareEducationContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeachingWrite {
    pub project_id: String,
    pub page_id: String,
    pub expected_source_revision: String,
    pub expected_teaching_revision: String,
    pub actions: Vec<Value>,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}

pub(super) fn valid_online_clip(action: &Value) -> bool {
    action.as_object().is_some_and(|fields| fields.len() == 3)
        && action["type"] == "audio_clip"
        && valid_id(action["id"].as_str().unwrap_or_default())
        && action["audioAssetId"].as_str().is_some_and(|id| {
            uuid::Uuid::parse_str(id).is_ok_and(|parsed| parsed.to_string() == id)
        })
}

mod attention;

pub(crate) fn valid_teaching_delay(action: &Value) -> bool {
    action.as_object().is_some_and(|fields| fields.len() == 3)
        && action["type"] == "delay"
        && action["id"].as_str().is_some_and(valid_id)
        && action["durationMs"].as_u64().is_some_and(|ms| ms <= 30000)
}

pub(crate) fn valid_native_animation(action: &Value) -> bool {
    action.as_object().is_some_and(|fields| fields.len() == 5)
        && action["id"].as_str().is_some_and(valid_id)
        && action["type"] == "native_animation"
        && action["version"].as_u64() == Some(1)
        && action["sourceSha256"].as_str().is_some_and(|hash| {
            hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
        && action["stepIndex"]
            .as_u64()
            .is_some_and(|index| index < 200)
}

pub(crate) fn valid_teaching_checkpoint(action: &Value) -> bool {
    let id = |value: &Value| {
        value
            .as_str()
            .is_some_and(|id| valid_id(id) && !matches!(id, "." | ".."))
    };
    let fields = |value: &Value, keys: &[&str]| {
        value.as_object().is_some_and(|object| {
            object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
        })
    };
    let text = |value: &Value, max: usize| {
        value
            .as_str()
            .is_some_and(|text| !text.trim().is_empty() && text.encode_utf16().count() <= max)
    };
    if action["type"] != "interaction_checkpoint"
        || !id(&action["id"])
        || !id(&action["checkpointId"])
    {
        return false;
    }
    if action["checkpointKind"] == "teacher_continue" {
        return fields(action, &["id", "type", "checkpointId", "checkpointKind"]);
    }
    let answer = &action["referenceAnswer"];
    let context = &action["context"];
    action["checkpointKind"] == "chapter_summary"
        && action.get("response").is_none_or(question::valid)
        && fields(
            &{
                let mut clean = action.clone();
                clean.as_object_mut().unwrap().remove("response");
                clean
            },
            &[
                "id",
                "type",
                "checkpointId",
                "checkpointKind",
                "chapterId",
                "chapterTitle",
                "question",
                "referenceAnswer",
                "context",
            ],
        )
        && id(&action["chapterId"])
        && text(&action["chapterTitle"], 1000)
        && text(&action["question"], 4000)
        && fields(answer, &["summary", "keyPoints"])
        && text(&answer["summary"], 4000)
        && answer["keyPoints"].as_array().is_some_and(|points| {
            !points.is_empty() && points.len() <= 8 && points.iter().all(|point| text(point, 1000))
        })
        && fields(context, &["chapterSummary", "sourceSceneIds"])
        && text(&context["chapterSummary"], 4000)
        && context["sourceSceneIds"].as_array().is_some_and(|ids| {
            let mut seen = std::collections::HashSet::new();
            !ids.is_empty()
                && ids.len() <= 100
                && ids.iter().all(|id| {
                    id.as_str().is_some_and(|id| {
                        valid_id(id) && !matches!(id, "." | "..") && seen.insert(id)
                    })
                })
        })
}

fn validate_actions(actions: &[Value]) -> Result<()> {
    validate_actions_mode(actions, false)
}

fn narration_sentences(text: &str) -> Vec<&str> {
    let mut sentences = Vec::new();
    let mut chars = text.char_indices().peekable();
    let (mut start, mut ended, mut previous) = (0, false, None::<char>);
    while let Some((index, ch)) = chars.next() {
        let punctuation = matches!(ch, '。' | '！' | '？' | '!' | '?' | '.' | '\n');
        let closing = matches!(
            ch,
            '”' | '’' | '"' | '\'' | ')' | ']' | '}' | '»' | '】' | '」' | '』'
        );
        if ended && !ch.is_whitespace() && !punctuation && !closing {
            sentences.push(&text[start..index]);
            start = index;
            ended = false;
        }
        let decimal = ch == '.'
            && previous.is_some_and(|c| c.is_ascii_digit())
            && chars.peek().is_some_and(|(_, c)| c.is_ascii_digit());
        if punctuation && !decimal {
            ended = true;
        }
        previous = Some(ch);
    }
    if start < text.len() {
        sentences.push(&text[start..]);
    }
    sentences
}

fn validate_actions_mode(actions: &[Value], online: bool) -> Result<()> {
    let mut ids = std::collections::HashSet::new();
    let mut native_index = 0;
    if actions.len() > 1000
        || actions.iter().any(|action| {
            let id = action.get("id").and_then(Value::as_str).unwrap_or("");
            let kind = action.get("type").and_then(Value::as_str).unwrap_or("");
            !valid_id(id)
                || !valid_id(kind)
                || !ids.insert(id)
                || action.get("attention").is_some_and(|intent| {
                    kind != "speech"
                        || attention::targets(intent).is_err()
                        || action.get("visualCues").is_some()
                })
                || kind == "audio_clip"
                    && !(music::valid_clip(action) || online && valid_online_clip(action))
                || kind == "delay" && !valid_teaching_delay(action)
                || kind == "native_animation" && {
                    let valid = valid_native_animation(action)
                        && action["stepIndex"].as_u64() == Some(native_index);
                    native_index += 1;
                    !valid
                }
                || kind == "music_slot" && !music::valid_slot(action)
                || kind == "video_slot" && !video::valid_slot(action)
                || kind == "video_clip" && !video::valid_clip(action)
        })
    {
        return Err(anyhow!("COURSEWARE_INVALID: invalid action envelope"));
    }
    Ok(())
}

impl CoursewareProject {
    pub(crate) fn validate(&self) -> Result<()> {
        self.validate_mode(false)
    }

    pub(crate) fn validate_online(&self) -> Result<()> {
        self.validate_mode(true)
    }

    fn validate_mode(&self, online: bool) -> Result<()> {
        let mut ids = std::collections::HashSet::new();
        if self.schema_version != "deckwise-courseware/1"
            || !valid_id(&self.project_id)
            || !matches!(self.task_type.as_str(), "plain" | "scene" | "import")
            || self.title.encode_utf16().count() > 500
            || !valid_id(&self.source.revision)
            || self.source.sha256.len() != 64
            || !self.source.sha256.bytes().all(|c| c.is_ascii_hexdigit())
            || !valid_id(&self.teaching_revision)
            || self.pages.is_empty()
            || self.pages.len() > 100
            || serde_json::to_vec(self)?.len() > MAX_BYTES
        {
            return Err(anyhow!("COURSEWARE_INVALID: invalid project"));
        }
        if let Some(context) = &self.education_context {
            if [
                &context.school_stage,
                &context.grade,
                &context.subject,
                &context.custom_subject_name,
                &context.textbook_version,
                &context.chapter,
                &context.lesson_type,
                &context.visual_style,
            ]
            .iter()
            .any(|text| {
                text.as_ref()
                    .is_some_and(|text| text.encode_utf16().count() > 500)
            }) {
                return Err(anyhow!("COURSEWARE_INVALID: invalid education context"));
            }
        }
        for page in &self.pages {
            if !valid_id(&page.page_id)
                || !ids.insert(&page.page_id)
                || !matches!(page.review_state.as_str(), "ready" | "review")
            {
                return Err(anyhow!("COURSEWARE_INVALID: invalid logical page"));
            }
            validate_actions_mode(&page.actions, online)?;
            anyhow::ensure!(page.actions.iter().all(|action| action["type"] != "native_animation" ||
                action["sourceSha256"] == self.source.sha256),
                "COURSEWARE_CONFLICT: native animation bindings require the exact saved PPTX; remove or rebind them");
        }
        Ok(())
    }
}

fn storage_key(workspace: &str, project_id: &str) -> Result<String> {
    if !valid_id(project_id) {
        return Err(anyhow!("COURSEWARE_INVALID: invalid project id"));
    }
    let workspace = canonical_project_path(workspace)
        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: workspace required"))?;
    Ok(serde_json::to_string(&(workspace, project_id))?)
}

impl Database {
    #[cfg(test)]
    pub fn open_saved_courseware_project(
        &self,
        workspace: &str,
        project_id: &str,
        sha256: &str,
        page_count: usize,
    ) -> Result<CoursewareProject> {
        self.open_saved_courseware_project_with_metadata(
            workspace, project_id, sha256, page_count, "import", None,
        )
    }

    fn open_saved_courseware_project_with_metadata(
        &self,
        workspace: &str,
        project_id: &str,
        sha256: &str,
        page_count: usize,
        task_type: &str,
        education_context: Option<CoursewareEducationContext>,
    ) -> Result<CoursewareProject> {
        if !(1..=100).contains(&page_count) {
            return Err(anyhow!("COURSEWARE_INVALID: invalid parsed page count"));
        }
        if let Some(project) = self.get_courseware_project(workspace, project_id)? {
            // Changed sources must pass identity reconciliation before reaching this byte guard.
            if project.source.sha256 != sha256 || project.pages.len() != page_count {
                return Err(anyhow!("COURSEWARE_CONFLICT: PPTX changed; reconcile page identities before editing teaching"));
            }
            return Ok(project);
        }
        let project = CoursewareProject {
            schema_version: "deckwise-courseware/1".into(),
            project_id: project_id.into(),
            task_type: task_type.into(),
            title: project_id.trim_start_matches("office-").into(),
            source: CoursewareSource {
                revision: sha256.into(),
                sha256: sha256.into(),
            },
            teaching_revision: uuid::Uuid::new_v4().to_string(),
            pages: (0..page_count)
                .map(|_| CoursewarePage {
                    page_id: uuid::Uuid::new_v4().to_string(),
                    actions: vec![],
                    locked: false,
                    review_state: "review".into(),
                })
                .collect(),
            education_context,
        };
        self.create_courseware_project(workspace, &project)?;
        Ok(project)
    }

    /// Internal entry point: the editor coordinator must verify source bytes and lineage first.
    pub fn create_courseware_project(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<()> {
        project.validate()?;
        let key = storage_key(workspace, &project.project_id)?;
        let changed = self.conn.execute(
            "INSERT INTO kv (ns, key, value_json, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(ns, key) DO NOTHING",
            params![NAMESPACE, key, serde_json::to_string(project)?, now_ms()],
        )?;
        if changed != 1 {
            return Err(anyhow!("COURSEWARE_CONFLICT: project already exists"));
        }
        Ok(())
    }

    pub fn get_courseware_project(
        &self,
        workspace: &str,
        project_id: &str,
    ) -> Result<Option<CoursewareProject>> {
        let key = storage_key(workspace, project_id)?;
        let value = self.kv_get(NAMESPACE, &key)?;
        value
            .map(|value| {
                let project: CoursewareProject = serde_json::from_value(value)?;
                project.validate()?;
                if project.project_id != project_id {
                    return Err(anyhow!("COURSEWARE_INVALID: project identity mismatch"));
                }
                Ok(project)
            })
            .transpose()
    }

    pub fn initialize_generated_narration(
        &self,
        workspace: &str,
        project_id: &str,
        source_sha256: &str,
        title: &str,
        narrations: &[String],
    ) -> Result<CoursewareProject> {
        let key = storage_key(workspace, project_id)?;
        let mut project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        if !matches!(project.task_type.as_str(), "plain" | "scene")
            || project.source.sha256 != source_sha256
            || project.pages.len() != narrations.len()
            || title.trim().is_empty()
            || title.encode_utf16().count() > 500
            || narrations
                .iter()
                .any(|text| project.task_type != "scene" && text.trim().is_empty() || text.encode_utf16().count() > 2500)
        {
            return Err(anyhow!(
                "COURSEWARE_INVALID: generated narration does not match source"
            ));
        }
        let expected: Vec<_> = narrations
            .iter()
            .map(|text| {
                narration_sentences(text)
                    .into_iter()
                    .enumerate()
                    .map(|(index, sentence)| {
                        serde_json::json!({
                            "id": format!("narration-{index}"), "type": "speech", "text": sentence,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        if project.title == title
            && project
                .pages
                .iter()
                .zip(&expected)
                .zip(narrations)
                .all(|((page, actions), text)| {
                    page.actions == *actions
                        || page.actions
                            == vec![serde_json::json!({
                                "id": "narration-0", "type": "speech", "text": text,
                            })]
                })
        {
            return Ok(project);
        }
        if project
            .pages
            .iter()
            .any(|page| !page.actions.is_empty() || page.locked)
        {
            return Err(anyhow!(
                "COURSEWARE_CONFLICT: generated narration would overwrite teaching"
            ));
        }
        let original = serde_json::to_string(&project)?;
        project.title = title.to_string();
        for (page, actions) in project.pages.iter_mut().zip(expected) {
            page.actions = actions;
        }
        project.teaching_revision = uuid::Uuid::new_v4().to_string();
        project.validate()?;
        let changed = self.conn.execute(
            "UPDATE kv SET value_json = ?1, updated_at = ?2 WHERE ns = ?3 AND key = ?4 AND value_json = ?5",
            params![serde_json::to_string(&project)?, now_ms(), NAMESPACE, key, original],
        )?;
        if changed != 1 {
            return Err(anyhow!(
                "COURSEWARE_CONFLICT: project changed during narration initialization"
            ));
        }
        Ok(project)
    }

    pub fn write_courseware_teaching(
        &self,
        workspace: &str,
        write: &TeachingWrite,
    ) -> Result<CoursewareProject> {
        if !valid_id(&write.page_id)
            || !valid_id(&write.expected_source_revision)
            || !valid_id(&write.expected_teaching_revision)
            || serde_json::to_vec(write)?.len() > MAX_BYTES
        {
            return Err(anyhow!("COURSEWARE_INVALID: invalid teaching write"));
        }
        validate_actions(&write.actions)?;
        self.update_courseware_page(
            workspace,
            &write.project_id,
            &write.page_id,
            &write.expected_source_revision,
            &write.expected_teaching_revision,
            |page| {
                if page.locked {
                    return Err(anyhow!("COURSEWARE_LOCKED: unlock the page before editing"));
                }
                page.actions = write.actions.clone();
                page.review_state = "review".to_string();
                Ok(())
            },
        )
    }

    pub fn set_courseware_page_lock(
        &self,
        workspace: &str,
        project_id: &str,
        page_id: &str,
        expected_source_revision: &str,
        expected_teaching_revision: &str,
        locked: bool,
    ) -> Result<CoursewareProject> {
        self.update_courseware_page(
            workspace,
            project_id,
            page_id,
            expected_source_revision,
            expected_teaching_revision,
            |page| {
                page.locked = locked;
                Ok(())
            },
        )
    }

    pub fn review_courseware_page(
        &self,
        workspace: &str,
        project_id: &str,
        page_id: &str,
        expected_source_revision: &str,
        expected_teaching_revision: &str,
    ) -> Result<CoursewareProject> {
        self.update_courseware_page(
            workspace,
            project_id,
            page_id,
            expected_source_revision,
            expected_teaching_revision,
            |page| {
                page.review_state = "ready".into();
                Ok(())
            },
        )
    }

    fn update_courseware_page(
        &self,
        workspace: &str,
        project_id: &str,
        page_id: &str,
        expected_source_revision: &str,
        expected_teaching_revision: &str,
        update: impl FnOnce(&mut CoursewarePage) -> Result<()>,
    ) -> Result<CoursewareProject> {
        if !valid_id(page_id)
            || !valid_id(expected_source_revision)
            || !valid_id(expected_teaching_revision)
        {
            return Err(anyhow!("COURSEWARE_INVALID: invalid page write identity"));
        }
        let key = storage_key(workspace, project_id)?;
        let mut project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        if project.source.revision != expected_source_revision
            || project.teaching_revision != expected_teaching_revision
        {
            return Err(anyhow!("COURSEWARE_CONFLICT: revisions changed"));
        }
        let original = serde_json::to_string(&project)?;
        let page = project
            .pages
            .iter_mut()
            .find(|page| page.page_id == page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_PAGE_NOT_FOUND: logical page not found"))?;
        update(page)?;
        project.teaching_revision = uuid::Uuid::new_v4().to_string();
        project.validate()?;
        let changed = self.conn.execute(
            "UPDATE kv SET value_json = ?1, updated_at = ?2
             WHERE ns = ?3 AND key = ?4 AND value_json = ?5",
            params![
                serde_json::to_string(&project)?,
                now_ms(),
                NAMESPACE,
                key,
                original
            ],
        )?;
        if changed != 1 {
            return Err(anyhow!("COURSEWARE_CONFLICT: project changed during save"));
        }
        Ok(project)
    }
}

#[cfg(test)]
mod tests;
