use super::*;
use crate::db::courseware_projects::source_candidates::{
    FadeEvidence, RedoEvidence, SourceCandidateRequest, StyleBatchEvidence,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    session_id: String,
    job_id: String,
    request: SourceCandidateRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stage {
    session_id: String,
    project_id: String,
    candidate_id: String,
    job_id: String,
    output_sha256: String,
    fade_evidence: Option<FadeEvidence>,
    redo_evidence: Option<RedoEvidence>,
    batch_evidence: Option<StyleBatchEvidence>,
    #[serde(default)]
    preserved_images: Vec<crate::db::courseware_projects::asset_locks::PreservedImage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    session_id: String,
    project_id: String,
    candidate_id: String,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let invalid = |error: serde_json::Error| rpc_err(1002, error.to_string(), "INVALID_PARAMS");
    match method {
        "courseware.sourceCandidate.prepare" => {
            let p: Prepare = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let seed = state
                .courseware
                .saved_project_seed(&p.job_id, Path::new(&root))
                .map_err(error)?;
            // Keep the exact original bytes available after the single parser job is released.
            state
                .courseware
                .archive_candidate(&p.job_id, Path::new(&root), &state.data_dir, &seed.sha256)
                .map_err(error)?;
            state
                .db
                .prepare_source_candidate(&root, &seed, p.request)
                .map_err(error)
        }
        "courseware.sourceCandidate.stage" => {
            let p: Stage = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let pending = state
                .db
                .get_source_candidate(&root, &p.project_id, &p.candidate_id)
                .map_err(error)?;
            if pending["stale"] == true || pending["status"] == "rejected" {
                return Err(rpc_err(
                    1008,
                    "Source candidate is stale or rejected",
                    "COURSEWARE_CONFLICT",
                ));
            }
            let output = state
                .courseware
                .archive_candidate(
                    &p.job_id,
                    Path::new(&root),
                    &state.data_dir,
                    &p.output_sha256,
                )
                .map_err(error)?;
            if p.fade_evidence.is_some() || p.redo_evidence.is_some() || p.batch_evidence.is_some()
            {
                let hash = pending["source"]["sha256"]
                    .as_str()
                    .ok_or_else(|| rpc_err(1002, "Missing source hash", "COURSEWARE_INVALID"))?;
                crate::courseware::source_candidates::verify_archive(&state.data_dir, hash)
                    .map_err(error)?;
                state
                    .db
                    .stage_source_candidate_with_locked_proofs(
                        &root,
                        &p.project_id,
                        &p.candidate_id,
                        output,
                        (p.fade_evidence, p.redo_evidence, p.batch_evidence),
                        p.preserved_images,
                    )
                    .map_err(error)
            } else {
                state
                    .db
                    .stage_source_candidate(&root, &p.project_id, &p.candidate_id, output)
                    .map_err(error)
            }
        }
        "courseware.sourceCandidate.get"
        | "courseware.sourceCandidate.context"
        | "courseware.sourceCandidate.preview"
        | "courseware.sourceCandidate.reject" => {
            let p: Read = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            if method == "courseware.sourceCandidate.reject" {
                return state
                    .db
                    .reject_source_candidate(&root, &p.project_id, &p.candidate_id)
                    .map_err(error);
            }
            if method == "courseware.sourceCandidate.context" {
                let context = state
                    .db
                    .source_candidate_context(&root, &p.project_id, &p.candidate_id)
                    .map_err(error)?;
                let hash = context["mapping"]["sourceSha256"]
                    .as_str()
                    .ok_or_else(|| rpc_err(1002, "Missing source hash", "COURSEWARE_INVALID"))?;
                crate::courseware::source_candidates::verify_archive(&state.data_dir, hash)
                    .map_err(error)?;
                return Ok(context);
            }
            let candidate = state
                .db
                .get_source_candidate(&root, &p.project_id, &p.candidate_id)
                .map_err(error)?;
            if method == "courseware.sourceCandidate.preview" {
                if candidate["status"] != "needs-review" || candidate["stale"] == true {
                    return Err(rpc_err(
                        1008,
                        "Source candidate is stale or not awaiting review",
                        "COURSEWARE_CONFLICT",
                    ));
                }
                let hash = candidate["outputSha256"].as_str().ok_or_else(|| {
                    rpc_err(1002, "Missing candidate output hash", "COURSEWARE_INVALID")
                })?;
                let path =
                    crate::courseware::source_candidates::archive_path(&state.data_dir, hash)
                        .map_err(error)?;
                crate::courseware::source_candidates::verify_archive(&state.data_dir, hash)
                    .map_err(error)?;
                return Ok(serde_json::json!({ "candidate": candidate, "path": path }));
            }
            if let Some(hash) = candidate["outputSha256"].as_str() {
                crate::courseware::source_candidates::verify_archive(&state.data_dir, hash)
                    .map_err(error)?;
            }
            Ok(candidate)
        }
        _ => Err(rpc_err(-32601, "Method not found", "METHOD_NOT_FOUND")),
    }
}
