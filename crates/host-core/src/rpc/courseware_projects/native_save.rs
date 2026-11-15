use super::*;
use crate::db::courseware_projects::native_save::{ClassroomSave, NativeLineage};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    session_id: String,
    job_id: String,
    source_path: String,
    lineage: NativeLineage,
    #[serde(default)]
    classroom_save: Option<ClassroomSave>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resolve {
    session_id: String,
    save_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForPath {
    session_id: String,
    source_path: String,
}

fn canonical(root: &str, path: &str) -> anyhow::Result<std::path::PathBuf> {
    let resolved = crate::workspace::resolve_in_workspace(Path::new(root), path)
        .map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        resolved == Path::new(path) && path.to_ascii_lowercase().ends_with(".pptx"),
        "COURSEWARE_INVALID: canonical workspace PPTX required"
    );
    Ok(resolved)
}
pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let invalid = |e: serde_json::Error| rpc_err(1002, e.to_string(), "INVALID_PARAMS");
    let state = state.lock().await;
    match method {
        "courseware.nativeSave.prepare" => {
            let p: Prepare = serde_json::from_value(params).map_err(invalid)?;
            let root = workspace(&state, &p.session_id)?;
            canonical(&root, &p.source_path).map_err(error)?;
            let seed = state
                .courseware
                .saved_project_seed(&p.job_id, Path::new(&root))
                .map_err(error)?;
            if p.lineage.project_id != hex::encode(Sha256::digest(root.as_bytes()))
                || seed.project_id != format!("office-{}", p.lineage.document_id)
            {
                return Err(rpc_err(
                    1002,
                    "Save lineage belongs to another document",
                    "COURSEWARE_INVALID",
                ));
            }
            let old_seed = crate::courseware::SavedProjectSeed {
                project_id: seed.project_id.clone(),
                sha256: p.lineage.source_sha256.clone(),
                pages: seed.pages,
                identity: None,
            };
            super::source_adoption::verify_live_path(&root, &p.source_path, &old_seed, None)
                .map_err(error)?;
            state
                .db
                .prepare_native_save_with_classroom(
                    &root,
                    &p.source_path,
                    &seed,
                    &p.lineage,
                    p.classroom_save.as_ref(),
                )
                .map_err(error)
        }
        "courseware.nativeSave.forPath" => {
            let p: ForPath = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            canonical(&root, &p.source_path).map_err(error)?;
            Ok(json!({"save":state.db.native_save_for_path(&root, &p.source_path).map_err(error)?}))
        }
        "courseware.nativeSave.resolve" => {
            let p: Resolve = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            let receipt = state
                .db
                .native_save_receipt(&root, &p.save_id)
                .map_err(error)?;
            let path =
                canonical(&root, receipt["sourcePath"].as_str().unwrap_or("")).map_err(error)?;
            // Only an exact prepared old/new source may resolve the durable save receipt.
            let source = receipt["sourceSha256"].as_str().unwrap_or("");
            let output = receipt["outputSha256"].as_str().unwrap_or("");
            let is_output = crate::courseware::source_candidates::verify_live_source(
                Path::new(&root),
                &path,
                output,
            )
            .is_ok();
            let hash = if is_output {
                output
            } else {
                crate::courseware::source_candidates::verify_live_source(
                    Path::new(&root),
                    &path,
                    source,
                )
                .map_err(error)?;
                source
            };
            state
                .db
                .resolve_native_save(&root, &p.save_id, hash)
                .map_err(error)
        }
        _ => Err(rpc_err(
            1002,
            "Unsupported native save operation",
            "INVALID_PARAMS",
        )),
    }
}
