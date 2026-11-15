use super::*;
use crate::db::courseware_projects::tts::{RejectedRequest, Selection, TaskRef};

mod audio;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    session_id: String,
    selection: Selection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Get {
    session_id: String,
    project_id: String,
    principal_key: String,
    intent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct List {
    session_id: String,
    project_id: String,
    principal_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bind {
    session_id: String,
    project_id: String,
    principal_key: String,
    intent_id: String,
    task_ref: TaskRef,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reject {
    session_id: String,
    project_id: String,
    principal_key: String,
    intent_id: String,
    rejected_request: RejectedRequest,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    if matches!(
        method,
        "courseware.tts.audio.stage" | "courseware.tts.audio.get" | "courseware.tts.audio.adopt"
    ) {
        return audio::handle(state, method, params).await;
    }
    let invalid = |error: serde_json::Error| rpc_err(1002, error.to_string(), "INVALID_PARAMS");
    let state = state.lock().await;
    match method {
        "courseware.tts.prepare" => {
            let p: Prepare = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            state
                .db
                .prepare_courseware_tts(&root, p.selection)
                .map_err(error)
        }
        "courseware.tts.list" => {
            let p: List = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            let intents = state
                .db
                .list_courseware_tts(&root, &p.project_id, &p.principal_key)
                .map_err(error)?;
            Ok(json!({"intents":intents}))
        }
        "courseware.tts.get" | "courseware.tts.begin" => {
            let p: Get = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            if method == "courseware.tts.begin" {
                state
                    .db
                    .begin_courseware_tts(
                        &root,
                        &p.project_id,
                        &p.principal_key,
                        &p.intent_id,
                        &p.session_id,
                    )
                    .map_err(error)
            } else {
                state
                    .db
                    .get_courseware_tts(&root, &p.project_id, &p.principal_key, &p.intent_id)
                    .map_err(error)
            }
        }
        "courseware.tts.reject" => {
            let p: Reject = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            state
                .db
                .reject_courseware_tts(
                    &root,
                    &p.project_id,
                    &p.principal_key,
                    &p.intent_id,
                    p.rejected_request,
                )
                .map_err(error)
        }
        "courseware.tts.bind" => {
            let p: Bind = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            state
                .db
                .bind_courseware_tts(
                    &root,
                    &p.project_id,
                    &p.principal_key,
                    &p.intent_id,
                    p.task_ref,
                )
                .map_err(error)
        }
        _ => Err(rpc_err(-32601, "Method not found", "METHOD_NOT_FOUND")),
    }
}

#[cfg(test)]
mod tests;
