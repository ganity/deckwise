use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    session_id: String,
    job_id: String,
    baseline: crate::db::courseware_projects::CoursewareProject,
    write: TeachingWrite,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stage {
    session_id: String,
    job_id: String,
    candidate_id: String,
    write: TeachingWrite,
    #[serde(default)]
    page_scoped: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    session_id: String,
    project_id: String,
    candidate_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Adopt {
    session_id: String,
    job_id: String,
    candidate_id: String,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let invalid = |error: serde_json::Error| rpc_err(1002, error.to_string(), "INVALID_PARAMS");
    match method {
        "courseware.narration.save" => {
            let p: Save = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let seed = state
                .courseware
                .saved_project_seed(&p.job_id, Path::new(&root))
                .map_err(error)?;
            let draft_key = serde_json::to_string(&(
                &root,
                &p.session_id,
                &p.write.project_id,
                &p.write.page_id,
            ))
            .map_err(invalid)?;
            if state
                .db
                .kv_get("coursewareTeachingDrafts.v1", &draft_key)
                .map_err(error)?
                .is_some()
            {
                return Err(rpc_err(
                    1008,
                    "Save or discard the narration draft before regenerating",
                    "COURSEWARE_CONFLICT",
                ));
            }
            let project = state
                .db
                .save_generated_narration(&root, &seed, &p.baseline, &p.write)
                .map_err(error)?;
            Ok(json!({"project":project}))
        }
        "courseware.narrationCandidate.stage" => {
            let p: Stage = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let seed = state
                .courseware
                .saved_project_seed(&p.job_id, Path::new(&root))
                .map_err(error)?;
            if p.page_scoped {
                state.db.stage_scoped_narration_candidate(
                    &root,
                    &seed,
                    &p.candidate_id,
                    &p.write,
                    true,
                )
            } else {
                state
                    .db
                    .stage_narration_candidate(&root, &seed, &p.candidate_id, &p.write)
            }
            .map_err(error)
        }
        "courseware.narrationCandidate.adopt" => {
            let p: Adopt = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let seed = state
                .courseware
                .saved_project_seed(&p.job_id, Path::new(&root))
                .map_err(error)?;
            let project = state
                .db
                .adopt_narration_candidate(&root, &seed, &p.candidate_id)
                .map_err(error)?;
            Ok(json!({"project": project}))
        }
        "courseware.narrationCandidate.get" | "courseware.narrationCandidate.reject" => {
            let p: Read = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            if method == "courseware.narrationCandidate.get" {
                state
                    .db
                    .get_narration_candidate(&root, &p.project_id, &p.candidate_id)
            } else {
                state
                    .db
                    .reject_narration_candidate(&root, &p.project_id, &p.candidate_id)
            }
            .map_err(error)
        }
        _ => Err(rpc_err(-32601, "Method not found", "METHOD_NOT_FOUND")),
    }
}
