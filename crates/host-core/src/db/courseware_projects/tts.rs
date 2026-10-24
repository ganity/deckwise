//! Private request journal; explicit audio attachment is isolated in the audio module.
use super::*;
use sha2::{Digest, Sha256};

const INTENTS: &str = "coursewareTtsIntents.v1";
const MAX_INTENTS: usize = 1000;

pub mod audio;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub intent_id: String,
    pub principal_key: String,
    pub project_id: String,
    pub page_id: String,
    pub action_id: String,
    pub expected_source_revision: String,
    pub expected_teaching_revision: String,
    pub model: String,
    pub voice: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub kind: String,
    pub model: String,
    pub input: String,
    pub voice: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRef {
    pub task_id: String,
    pub idempotency_key: String,
    pub request_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Prepared,
    SubmissionUnknown,
    Submitted,
    Rejected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RejectedRequest {
    pub idempotency_key: String,
    pub request_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub selection: Selection,
    pub source_sha256: String,
    pub request: Request,
    pub idempotency_key: String,
    pub request_hash: String,
    pub phase: Phase,
    pub task_ref: Option<TaskRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub submission_scope: Option<super::media_scope::SubmissionScope>,
}

fn hash(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub(crate) fn request_hash(request: &Request) -> String {
    let mut canonical = "courseware-media-v1".to_string();
    for field in [
        Some(request.kind.as_str()),
        Some(request.model.as_str()),
        Some(request.input.as_str()),
        request.voice.as_deref(),
    ] {
        match field {
            Some(value) => {
                canonical.push_str(&format!(":{}:{}", value.encode_utf16().count(), value))
            }
            None => canonical.push_str(":-1:"),
        }
    }
    hash(&canonical)
}

impl Selection {
    fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            [
                &self.intent_id,
                &self.project_id,
                &self.page_id,
                &self.action_id,
                &self.expected_source_revision,
                &self.expected_teaching_revision,
                &self.model,
            ]
            .iter()
            .all(|id| valid_id(id) && id.as_str() != "." && id.as_str() != "..")
                && valid_hash(&self.principal_key)
                && self.voice.as_ref().is_none_or(|voice| !voice.is_empty()
                    && voice.len() <= 64
                    && voice
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))),
            "COURSEWARE_INVALID: invalid TTS selection"
        );
        Ok(())
    }
}

impl Intent {
    fn validate(&self) -> Result<()> {
        self.selection.validate()?;
        anyhow::ensure!(
            self.phase != Phase::Rejected || self.submission_scope.as_ref().is_some_and(|scope| scope.team_project_id.is_some()),
            "COURSEWARE_INVALID: rejected request has no team scope"
        );
        anyhow::ensure!(
            valid_hash(&self.source_sha256)
                && uuid::Uuid::parse_str(&self.idempotency_key).is_ok()
                && self.request.kind == "tts"
                && self.request.model == self.selection.model
                && self.request.voice == self.selection.voice
                && !self.request.input.trim().is_empty()
                && self.request.input.encode_utf16().count() <= 4000
                && self.request_hash == request_hash(&self.request)
                && (self.phase == Phase::Submitted) == self.task_ref.is_some(),
            "COURSEWARE_INVALID: invalid stored TTS intent"
        );
        anyhow::ensure!(
            self.submission_scope.as_ref().is_none_or(|scope| {
                scope.valid() && self.phase != Phase::Prepared
            }),
            "COURSEWARE_INVALID: invalid stored TTS submission scope"
        );
        if let Some(task) = &self.task_ref {
            anyhow::ensure!(
                valid_id(&task.task_id)
                    && task.task_id != "."
                    && task.task_id != ".."
                    && task.idempotency_key == self.idempotency_key
                    && task.request_hash == self.request_hash,
                "COURSEWARE_INVALID: task differs from retained TTS request"
            );
        }
        Ok(())
    }

    fn current(&self, project: &CoursewareProject) -> bool {
        project.source.revision == self.selection.expected_source_revision
            && project.source.sha256 == self.source_sha256
            && project.teaching_revision == self.selection.expected_teaching_revision
            && project.pages.iter().any(|page| {
                page.page_id == self.selection.page_id
                    && !page.locked
                    && page.actions.iter().any(|action| {
                        action["id"] == self.selection.action_id
                            && action["type"] == "speech"
                            && action["text"] == self.request.input
                    })
            })
    }

    fn view(&self, project: &CoursewareProject) -> Value {
        serde_json::json!({"intent":self,"current":self.current(project),"audioReady":false})
    }
}

fn prefix(workspace: &str, project_id: &str, principal_key: &str) -> Result<String> {
    anyhow::ensure!(
        valid_hash(principal_key),
        "COURSEWARE_INVALID: invalid TTS principal"
    );
    let scope = storage_key(workspace, project_id)?;
    let encoded = serde_json::to_string(&(scope, principal_key))?;
    Ok(format!("{},", encoded.trim_end_matches(']')))
}

fn key(workspace: &str, project_id: &str, principal_key: &str, intent_id: &str) -> Result<String> {
    anyhow::ensure!(
        valid_id(intent_id) && intent_id != "." && intent_id != "..",
        "COURSEWARE_INVALID: invalid TTS intent id"
    );
    Ok(format!(
        "{}{}]",
        prefix(workspace, project_id, principal_key)?,
        serde_json::to_string(intent_id)?
    ))
}

impl Database {
    fn tts_intent(
        &self,
        workspace: &str,
        project_id: &str,
        principal_key: &str,
        intent_id: &str,
    ) -> Result<Intent> {
        let value = self
            .kv_get(
                INTENTS,
                &key(workspace, project_id, principal_key, intent_id)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: TTS intent not found"))?;
        let intent: Intent = serde_json::from_value(value)?;
        intent.validate()?;
        anyhow::ensure!(
            intent.selection.project_id == project_id
                && intent.selection.principal_key == principal_key
                && intent.selection.intent_id == intent_id,
            "COURSEWARE_INVALID: stored TTS scope differs"
        );
        Ok(intent)
    }

    pub fn list_courseware_tts(
        &self,
        workspace: &str,
        project_id: &str,
        principal_key: &str,
    ) -> Result<Vec<Value>> {
        let prefix = prefix(workspace, project_id, principal_key)?;
        let project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        let mut statement = self.conn.prepare("SELECT value_json FROM kv WHERE ns=?1 AND substr(key,1,length(?2))=?2 ORDER BY updated_at DESC,key LIMIT 1001")?;
        let records = statement
            .query_map(params![INTENTS, prefix], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        anyhow::ensure!(
            records.len() <= MAX_INTENTS,
            "COURSEWARE_INVALID: TTS journal exceeds limit"
        );
        records
            .into_iter()
            .map(|raw| {
                let record: Intent = serde_json::from_str(&raw)?;
                let intent = self.tts_intent(
                    workspace,
                    project_id,
                    principal_key,
                    &record.selection.intent_id,
                )?;
                Ok(
                    serde_json::json!({"selection":intent.selection,"phase":intent.phase,
                "requestHash":intent.request_hash,"idempotencyKey":intent.idempotency_key,
                "taskRef":intent.task_ref,"current":intent.current(&project),"audioReady":false}),
                )
            })
            .collect()
    }

    pub fn prepare_courseware_tts(&self, workspace: &str, selection: Selection) -> Result<Value> {
        selection.validate()?;
        let key = key(
            workspace,
            &selection.project_id,
            &selection.principal_key,
            &selection.intent_id,
        )?;
        let tx = self.conn.unchecked_transaction()?;
        let project = self
            .get_courseware_project(workspace, &selection.project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        let intent = if self.kv_get(INTENTS, &key)?.is_some() {
            let intent = self.tts_intent(
                workspace,
                &selection.project_id,
                &selection.principal_key,
                &selection.intent_id,
            )?;
            anyhow::ensure!(
                intent.selection == selection,
                "COURSEWARE_CONFLICT: intent id has different request"
            );
            intent
        } else {
            self.ensure_no_source_adoption(workspace)?;
            anyhow::ensure!(
                self.list_courseware_tts(
                    workspace,
                    &selection.project_id,
                    &selection.principal_key
                )?
                .len()
                    < MAX_INTENTS,
                "COURSEWARE_CONFLICT: TTS journal is full"
            );
            let action = project
                .pages
                .iter()
                .find(|page| page.page_id == selection.page_id)
                .and_then(|page| {
                    page.actions
                        .iter()
                        .find(|action| action["id"] == selection.action_id)
                })
                .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: speech action not found"))?;
            let input = action["text"]
                .as_str()
                .filter(|_| action["type"] == "speech")
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: selected action is not speech"))?;
            let request = Request {
                kind: "tts".into(),
                model: selection.model.clone(),
                input: input.into(),
                voice: selection.voice.clone(),
            };
            let intent = Intent {
                selection,
                source_sha256: project.source.sha256.clone(),
                request_hash: request_hash(&request),
                request,
                idempotency_key: uuid::Uuid::new_v4().to_string(),
                phase: Phase::Prepared,
                task_ref: None,
                submission_scope: None,
            };
            intent.validate()?;
            anyhow::ensure!(
                intent.current(&project),
                "COURSEWARE_CONFLICT: TTS source, teaching or lock changed"
            );
            let record = serde_json::to_value(&intent)?;
            let inserted = self.conn.execute(
                "INSERT INTO kv(ns,key,value_json,updated_at) VALUES(?1,?2,?3,?4)",
                params![INTENTS, key, serde_json::to_string(&record)?, now_ms()],
            )?;
            anyhow::ensure!(
                inserted == 1 && self.kv_get(INTENTS, &key)? == Some(record),
                "COURSEWARE_CONFLICT: TTS intent was not persisted"
            );
            intent
        };
        tx.commit()?;
        // A paid call must never precede this checked WAL durability barrier.
        self.source_adoption_barrier()?;
        Ok(intent.view(&project))
    }

    pub fn get_courseware_tts(
        &self,
        workspace: &str,
        project_id: &str,
        principal_key: &str,
        intent_id: &str,
    ) -> Result<Value> {
        let intent = self.tts_intent(workspace, project_id, principal_key, intent_id)?;
        let project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        Ok(intent.view(&project))
    }

    pub fn begin_courseware_tts(
        &self,
        workspace: &str,
        project_id: &str,
        principal_key: &str,
        intent_id: &str,
        session_id: &str,
    ) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        let mut intent = self.tts_intent(workspace, project_id, principal_key, intent_id)?;
        let project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        anyhow::ensure!(
            intent.current(&project),
            "COURSEWARE_CONFLICT: TTS baseline is stale"
        );
        anyhow::ensure!(
            intent.phase == Phase::Prepared,
            "COURSEWARE_CONFLICT: query the retained task instead of submitting"
        );
        intent.submission_scope = Some(self.courseware_media_submission_scope(session_id)?);
        intent.phase = Phase::SubmissionUnknown;
        self.save_tts_intent(workspace, &intent)?;
        tx.commit()?;
        self.source_adoption_barrier()?;
        Ok(intent.view(&project))
    }

    pub fn bind_courseware_tts(
        &self,
        workspace: &str,
        project_id: &str,
        principal_key: &str,
        intent_id: &str,
        task: TaskRef,
    ) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let mut intent = self.tts_intent(workspace, project_id, principal_key, intent_id)?;
        anyhow::ensure!(
            matches!(intent.phase, Phase::SubmissionUnknown | Phase::Submitted),
            "COURSEWARE_CONFLICT: TTS was not dispatched"
        );
        anyhow::ensure!(
            intent.task_ref.as_ref().is_none_or(|saved| saved == &task),
            "COURSEWARE_CONFLICT: TTS already bound to a different task"
        );
        intent.task_ref = Some(task);
        intent.phase = Phase::Submitted;
        intent.validate()?;
        self.save_tts_intent(workspace, &intent)?;
        tx.commit()?;
        self.source_adoption_barrier()?;
        self.get_courseware_tts(workspace, project_id, principal_key, intent_id)
    }

    pub fn reject_courseware_tts(
        &self, workspace: &str, project_id: &str, principal_key: &str,
        intent_id: &str, rejected: RejectedRequest,
    ) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let mut intent = self.tts_intent(workspace, project_id, principal_key, intent_id)?;
        anyhow::ensure!(
            intent.phase == Phase::SubmissionUnknown && intent.task_ref.is_none()
                && intent.idempotency_key == rejected.idempotency_key
                && intent.request_hash == rejected.request_hash
                && intent.submission_scope.as_ref().is_some_and(|scope| scope.team_project_id.is_some()),
            "COURSEWARE_CONFLICT: no matching unbound team submission"
        );
        intent.phase = Phase::Rejected;
        intent.validate()?;
        self.save_tts_intent(workspace, &intent)?;
        tx.commit()?;
        self.source_adoption_barrier()?;
        self.get_courseware_tts(workspace, project_id, principal_key, intent_id)
    }

    fn save_tts_intent(&self, workspace: &str, intent: &Intent) -> Result<()> {
        let record = serde_json::to_value(intent)?;
        let key = key(
            workspace,
            &intent.selection.project_id,
            &intent.selection.principal_key,
            &intent.selection.intent_id,
        )?;
        let changed = self.conn.execute(
            "UPDATE kv SET value_json=?1,updated_at=?2 WHERE ns=?3 AND key=?4",
            params![serde_json::to_string(&record)?, now_ms(), INTENTS, key],
        )?;
        anyhow::ensure!(
            changed == 1 && self.kv_get(INTENTS, &key)? == Some(record),
            "COURSEWARE_CONFLICT: TTS journal was not saved"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests;
