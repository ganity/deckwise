use super::*;
use crate::courseware::{OnlineSourceResolveRequest, OnlineSourceReviewTarget};
use crate::db::courseware_projects::CoursewareProject;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Baseline {
    session_id: String,
    job_id: String,
    source_byte_length: u64,
    project: CoursewareProject,
    mapping: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Review {
    session_id: String,
    baseline_id: String,
    job_id: String,
    target: OnlineSourceReviewTarget,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Clear {
    session_id: String,
    baseline_id: String,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let invalid = |error: serde_json::Error| rpc_err(1002, error.to_string(), "INVALID_PARAMS");
    let mut state = state.lock().await;
    match method {
        "courseware.onlineSource.baseline" => {
            state.courseware.invalidate_online_source_review();
            let p: Baseline = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            state
                .courseware
                .online_source_baseline(
                    &p.session_id,
                    Path::new(&root),
                    &p.job_id,
                    p.source_byte_length,
                    p.project,
                    p.mapping,
                )
                .map_err(error)
        }
        "courseware.onlineSource.review" => {
            let p: Review = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            state
                .courseware
                .online_source_review(
                    &p.session_id,
                    Path::new(&root),
                    &p.baseline_id,
                    &p.job_id,
                    p.target,
                )
                .map_err(error)
        }
        "courseware.onlineSource.resolve" => {
            let p: OnlineSourceResolveRequest = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            state
                .courseware
                .online_source_resolve(Path::new(&root), &p)
                .map_err(error)
        }
        "courseware.onlineSource.clear" => {
            let p: Clear = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            state
                .courseware
                .clear_online_source_review(&p.session_id, Path::new(&root), &p.baseline_id)
                .map_err(error)
        }
        _ => Err(rpc_err(-32601, "Method not found", "METHOD_NOT_FOUND")),
    }
}

#[cfg(test)]
mod tests;
