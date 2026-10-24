//! Before-dispatch receipts for actual Chat operations; never an automatic replay queue.
use super::*;
use serde_json::json;

const CHANGES: &str = "coursewareChatChanges.v1";
const PLANNED_CHANGES: &str = "coursewareChatPlannedChanges.v1";
const MAX_OPERATIONS: usize = 100;

mod adoptions;
mod plans;
mod resolutions;
pub use plans::{Plan, PlanItem};
pub use resolutions::ResolutionRequest;
#[cfg(test)]
mod tests;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation {
    tool_call_id: String,
    tool_name: String,
    args: Value,
    source: CoursewareSource,
    teaching_revision: String,
    outcome: Option<Value>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change {
    change_group_id: String,
    session_id: String,
    turn_id: String,
    baseline: CoursewareProject,
    operations: Vec<Operation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plan: Option<Plan>,
}

#[derive(Clone)]
pub struct Pending {
    namespace: &'static str,
    key: String,
    tool_call_id: String,
}

pub struct OperationRequest<'a> {
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub tool_call_id: &'a str,
    pub tool_name: &'a str,
    pub args: &'a Value,
}

fn read(value: Value) -> Result<Change> {
    let change: Change = serde_json::from_value(value)?;
    change.baseline.validate()?;
    anyhow::ensure!(
        valid_id(&change.change_group_id)
            && !change.session_id.is_empty()
            && change.session_id.len() <= 256
            && !change.turn_id.is_empty()
            && change.turn_id.len() <= 256
            && (!change.operations.is_empty() || change.plan.is_some())
            && change.operations.len() <= MAX_OPERATIONS,
        "COURSEWARE_INVALID: invalid Chat change receipt"
    );
    if let Some(plan) = &change.plan {
        plan.validate(&change.baseline)?;
    }
    Ok(change)
}

impl Database {
    fn chat_operation_view(
        &self,
        workspace: &str,
        project: &CoursewareProject,
        op: &Operation,
    ) -> Result<Value> {
        let mut value = json!({"toolCallId":op.tool_call_id,"toolName":op.tool_name,"source":op.source,
            "teachingRevision":op.teaching_revision,"outcome":op.outcome});
        let Some(candidate_id) = op
            .outcome
            .as_ref()
            .and_then(|outcome| outcome["candidateId"].as_str())
        else {
            return Ok(value);
        };
        anyhow::ensure!(
            op.outcome
                .as_ref()
                .is_some_and(|outcome| outcome["state"] == "acknowledged"),
            "COURSEWARE_INVALID: candidate receipt lacks acknowledgement"
        );
        let (kind, status, stale) = if op.tool_name == "ppt_propose_page_narration" {
            let candidate =
                self.get_narration_candidate(workspace, &project.project_id, candidate_id)?;
            (
                "page-narration",
                candidate["status"].as_str().unwrap_or_default().to_owned(),
                candidate["write"]["expectedSourceRevision"] != project.source.revision
                    || candidate["write"]["expectedTeachingRevision"] != project.teaching_revision,
            )
        } else {
            let kind = match op.tool_name.as_str() {
                "ppt_propose_page_redo" => "page-pptx",
                "ppt_propose_page_fade" => "page-fade",
                "ppt_propose_page_style_batch" => "page-style-batch",
                _ => anyhow::bail!("COURSEWARE_INVALID: unexpected candidate tool"),
            };
            let candidate =
                self.get_source_candidate(workspace, &project.project_id, candidate_id)?;
            anyhow::ensure!(
                candidate["kind"] == kind,
                "COURSEWARE_INVALID: candidate kind differs"
            );
            (
                kind,
                candidate["status"].as_str().unwrap_or_default().to_owned(),
                candidate["stale"] == true,
            )
        };
        value["candidate"] =
            self.chat_candidate_progress(workspace, project, candidate_id, kind, &status, stale)?;
        Ok(value)
    }

    pub fn prepare_courseware_chat_change(
        &self,
        workspace: &str,
        project_id: &str,
        request: OperationRequest<'_>,
    ) -> Result<Pending> {
        let OperationRequest {
            session_id,
            turn_id,
            tool_call_id,
            tool_name,
            args,
        } = request;
        anyhow::ensure!(
            [session_id, turn_id, tool_call_id]
                .iter()
                .all(|id| !id.is_empty() && id.len() <= 256)
                && tool_name.len() <= 100
                && serde_json::to_vec(args)?.len() <= 64 * 1024,
            "COURSEWARE_INVALID: invalid Chat change request"
        );
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        let project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: Chat project not found"))?;
        let scope = storage_key(workspace, project_id)?;
        let key = serde_json::to_string(&(&scope, session_id, turn_id))?;
        let namespace = if self.kv_get(PLANNED_CHANGES, &key)?.is_some() {
            PLANNED_CHANGES
        } else {
            CHANGES
        };
        anyhow::ensure!(
            self.kv_get(resolutions::RESOLUTIONS, &key)?.is_none(),
            "COURSEWARE_CONFLICT: this Chat request was explicitly closed; start a new turn"
        );
        let mut change = if let Some(value) = self.kv_get(namespace, &key)? {
            read(value)?
        } else {
            let prefix = format!("[{},", serde_json::to_string(&scope)?);
            let count: i64 = self.conn.query_row(
                "SELECT count(*) FROM kv WHERE ns IN (?1,?2) AND substr(key,1,length(?3))=?3",
                params![CHANGES, PLANNED_CHANGES, prefix],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                count < 1000,
                "COURSEWARE_INVALID: too many retained Chat changes"
            );
            Change {
                change_group_id: uuid::Uuid::new_v4().to_string(),
                session_id: session_id.into(),
                turn_id: turn_id.into(),
                baseline: project.clone(),
                operations: vec![],
                plan: None,
            }
        };
        anyhow::ensure!(
            change.session_id == session_id
                && change.turn_id == turn_id
                && change.baseline.project_id == project_id
                && change.operations.len() < MAX_OPERATIONS,
            "COURSEWARE_CONFLICT: Chat change scope differs or is full"
        );
        anyhow::ensure!(!change.operations.iter().any(|op| op.tool_call_id == tool_call_id)
            && !change.plan.as_ref().is_some_and(|plan| plan.tool_call_id == tool_call_id),
            "COURSEWARE_CONFLICT: Chat operation already dispatched; inspect its receipt before retrying");
        change.operations.push(Operation {
            tool_call_id: tool_call_id.into(),
            tool_name: tool_name.into(),
            args: args.clone(),
            source: project.source.clone(),
            teaching_revision: project.teaching_revision,
            outcome: None,
        });
        let value = serde_json::to_value(change)?;
        anyhow::ensure!(
            serde_json::to_vec(&value)?.len() <= MAX_BYTES,
            "COURSEWARE_INVALID: Chat change receipt is too large"
        );
        self.kv_set(namespace, &key, &value)?;
        anyhow::ensure!(
            self.kv_get(namespace, &key)? == Some(value),
            "COURSEWARE_CONFLICT: Chat intent was not saved"
        );
        tx.commit()?;
        self.source_adoption_barrier()?;
        Ok(Pending {
            namespace,
            key,
            tool_call_id: tool_call_id.into(),
        })
    }

    pub fn finish_courseware_chat_change(&self, pending: &Pending, outcome: Value) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        anyhow::ensure!(
            self.kv_get(resolutions::RESOLUTIONS, &pending.key)?
                .is_none(),
            "COURSEWARE_CONFLICT: closed Chat receipts cannot be rewritten"
        );
        let raw = self
            .kv_get(pending.namespace, &pending.key)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: Chat receipt missing"))?;
        let mut change = read(raw)?;
        let operation = change
            .operations
            .iter_mut()
            .find(|op| op.tool_call_id == pending.tool_call_id)
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: Chat operation missing"))?;
        anyhow::ensure!(
            operation.outcome.is_none(),
            "COURSEWARE_CONFLICT: Chat outcome already recorded"
        );
        operation.outcome = Some(outcome);
        let value = serde_json::to_value(change)?;
        anyhow::ensure!(
            serde_json::to_vec(&value)?.len() <= MAX_BYTES,
            "COURSEWARE_INVALID: Chat outcome is too large"
        );
        self.kv_set(pending.namespace, &pending.key, &value)?;
        anyhow::ensure!(
            self.kv_get(pending.namespace, &pending.key)? == Some(value),
            "COURSEWARE_CONFLICT: Chat outcome was not saved"
        );
        tx.commit()?;
        self.source_adoption_barrier()
    }

    pub(super) fn courseware_chat_change_context(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<Vec<Value>> {
        let scope = storage_key(workspace, &project.project_id)?;
        let prefix = format!("[{},", serde_json::to_string(&scope)?);
        let mut statement = self.conn.prepare(
            "SELECT c.key,c.value_json FROM kv c LEFT JOIN kv r ON r.ns='coursewareChatResolutions.v1' AND r.key=c.key WHERE c.ns IN (?1,?2) AND substr(c.key,1,length(?3))=?3 ORDER BY CASE WHEN c.ns=?2 AND r.key IS NULL THEN 0 ELSE 1 END,c.updated_at DESC,c.key LIMIT 10")?;
        let rows = statement
            .query_map(params![CHANGES, PLANNED_CHANGES, prefix], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(|(key, raw)| {
            let change = read(serde_json::from_str(&raw)?)?;
            anyhow::ensure!(change.baseline.project_id == project.project_id, "COURSEWARE_INVALID: Chat project differs");
            let mut view = json!({"changeGroupId":change.change_group_id, "sessionId":change.session_id,"turnId":change.turn_id,
                "baselineSource":change.baseline.source,"baselineTeachingRevision":change.baseline.teaching_revision,
                "operations":change.operations.iter().map(|op| self.chat_operation_view(workspace, project, op)).collect::<Result<Vec<_>>>()? });
            if let Some(plan) = &change.plan {
                view["plan"] = plans::progress(plan, &view["operations"], &change.operations)?;
                view["receiptSha256"] = json!(resolutions::digest(&change)?);
                if let Some(resolution) = self.chat_resolution(&key, &change)? { view["resolution"] = resolution; }
            }
            Ok(view)
        }).collect()
    }
}
