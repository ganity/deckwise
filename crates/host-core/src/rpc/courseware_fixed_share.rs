//! Durable query-only recovery for explicitly requested fixed-build publication.
use super::*;

const NAMESPACE: &str = "coursewareFixedShare.v1";
const TASK_NAMESPACE: &str = "coursewareTask.v1";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    project_id: String,
    snapshot_id: String,
    build_id: String,
    manifest_sha256: String,
    team_project_id: String,
    channel: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    intent_id: String,
    selection: Selection,
    state: String,
    #[serde(default)]
    receipt_aware: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    session_id: String,
    principal_key: String,
    selection: Option<Selection>,
    intent_id: Option<String>,
    #[serde(default)]
    receipt_aware: bool,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn failure(error: anyhow::Error) -> JsonRpcError {
    rpc_err(1008, error.to_string(), "COURSEWARE_SHARE_CONFLICT")
}

fn load(db: &crate::db::Database, key: &str) -> anyhow::Result<Option<Intent>> {
    db.kv_get(NAMESPACE, key)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(Into::into)
}

fn task(
    db: &crate::db::Database,
    workspace: &str,
    session_id: &str,
    selection: &Selection,
) -> anyhow::Result<Option<Value>> {
    if db.is_online_courseware_snapshot(workspace, &selection.project_id, &selection.snapshot_id)? {
        anyhow::ensure!(
            selection.project_id == selection.team_project_id,
            "An online snapshot can only be published to its original team project"
        );
        return Ok(None);
    }
    let task = db
        .kv_get(TASK_NAMESPACE, session_id)?
        .ok_or_else(|| anyhow!("Select a courseware task first"))?;
    anyhow::ensure!(
        task.get("teamProjectId")
            .is_none_or(|team| team == &selection.team_project_id),
        "Courseware task is already bound to another team project"
    );
    Ok(Some(task))
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let has_receipt_aware = params.get("receiptAware").is_some();
    let p: Params = serde_json::from_value(params)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    if !valid_id(&p.session_id)
        || !hash(&p.principal_key)
        || (method != "courseware.fixedShare.prepare" && has_receipt_aware)
        || (method == "courseware.fixedShare.prepare"
            && (p.selection.is_none() || p.intent_id.is_some()))
        || (method == "courseware.fixedShare.get"
            && (p.selection.is_some() || p.intent_id.is_some()))
        || (method == "courseware.fixedShare.complete"
            && (p.selection.is_some()
                || p.intent_id
                    .as_ref()
                    .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())))
    {
        return Err(rpc_err(
            1002,
            "Invalid fixed share request",
            "INVALID_PARAMS",
        ));
    }
    let state = state.lock().await;
    let workspace =
        resolve_persisted_project_workspace(&state, &p.session_id)?.ok_or_else(|| {
            rpc_err(
                1002,
                "A persisted project session is required",
                "COURSEWARE_INVALID",
            )
        })?;
    let key = serde_json::to_string(&(&workspace, &p.session_id, &p.principal_key))
        .map_err(|e| failure(e.into()))?;
    let result = (|| -> anyhow::Result<Value> {
        let current = load(&state.db, &key)?;
        match method {
            "courseware.fixedShare.get" => Ok(json!({ "intent": current })),
            "courseware.fixedShare.prepare" => {
                anyhow::ensure!(current.as_ref().is_none_or(|intent| intent.state == "bound"),
                    "Courseware share result is unknown; query the existing intent before sharing again");
                let selection = p.selection.unwrap();
                anyhow::ensure!(
                    valid_id(&selection.project_id)
                        && valid_id(&selection.snapshot_id)
                        && hash(&selection.build_id)
                        && hash(&selection.manifest_sha256)
                        && uuid::Uuid::parse_str(&selection.team_project_id).is_ok()
                        && matches!(selection.channel.as_str(), "shared" | "formal"),
                    "Invalid fixed share selection"
                );
                task(&state.db, &workspace, &p.session_id, &selection)?;
                state.db.get_courseware_snapshot(
                    &workspace,
                    &selection.project_id,
                    &selection.snapshot_id,
                )?;
                let intent = Intent {
                    intent_id: uuid::Uuid::new_v4().to_string(),
                    selection,
                    state: "unknown".into(),
                    receipt_aware: p.receipt_aware,
                };
                state
                    .db
                    .kv_set(NAMESPACE, &key, &serde_json::to_value(&intent)?)?;
                state.db.source_adoption_barrier()?;
                Ok(json!({ "intent": intent }))
            }
            "courseware.fixedShare.complete" => {
                let mut intent = current.ok_or_else(|| anyhow!("Fixed share intent not found"))?;
                anyhow::ensure!(
                    Some(&intent.intent_id) == p.intent_id.as_ref(),
                    "Fixed share intent changed"
                );
                let tx = state.db.conn().unchecked_transaction()?;
                if let Some(mut bound) =
                    task(&state.db, &workspace, &p.session_id, &intent.selection)?
                {
                    bound["teamProjectId"] = json!(intent.selection.team_project_id);
                    state.db.kv_set(TASK_NAMESPACE, &p.session_id, &bound)?;
                }
                intent.state = "bound".into();
                state
                    .db
                    .kv_set(NAMESPACE, &key, &serde_json::to_value(&intent)?)?;
                tx.commit()?;
                state.db.source_adoption_barrier()?;
                Ok(json!({ "intent": intent }))
            }
            _ => Err(anyhow!("Unknown fixed share method")),
        }
    })();
    result.map_err(failure)
}

#[cfg(test)]
mod tests;
