use super::*;

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let p: OpenSavedParams = serde_json::from_value(params)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    let state = state.lock().await;
    let root = workspace(&state, &p.session_id)?;
    let seed = state
        .courseware
        .saved_project_seed(&p.job_id, Path::new(&root))
        .map_err(error)?;
    state
        .db
        .list_courseware_teaching_history(&root, &seed)
        .map_err(error)
}

#[cfg(test)]
mod tests;
