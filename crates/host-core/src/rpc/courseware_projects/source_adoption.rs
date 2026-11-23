use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    session_id: String,
    job_id: String,
    candidate_id: String,
    source_path: Option<String>,
    #[serde(default)]
    effect_bindings: Vec<Value>,
}

pub(super) fn verify_live_path(
    root: &str,
    path: &str,
    seed: &crate::courseware::SavedProjectSeed,
    portable_path: Option<&Path>,
) -> anyhow::Result<String> {
    use sha2::{Digest, Sha256};
    let root = Path::new(root).canonicalize()?;
    let resolved =
        crate::workspace::resolve_in_workspace(&root, path).map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        resolved == Path::new(path)
            && resolved
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("pptx")),
        "COURSEWARE_INVALID: live PPTX path must be canonical and in workspace"
    );
    let relative = resolved
        .strip_prefix(&root)?
        .to_string_lossy()
        .replace('\\', "/");
    let stem = resolved
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("");
    let mut name = String::new();
    for character in stem.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
            name.push(character);
        } else if !name.ends_with('-') {
            name.push('-');
        }
    }
    let name = name.trim_matches('-');
    let name = if name.is_empty() {
        "presentation"
    } else {
        &name[..name.len().min(40)]
    };
    let digest = hex::encode(Sha256::digest(relative.as_bytes()));
    let matches_project = match portable_path {
        Some(attached) => seed.project_id.starts_with("portable-") && attached == resolved,
        None => seed.project_id == format!("office-{name}-{}", &digest[..12]),
    };
    anyhow::ensure!(
        matches_project,
        "COURSEWARE_INVALID: live source path belongs to another editor document"
    );
    crate::courseware::source_candidates::verify_live_source(&root, &resolved, &seed.sha256)?;
    Ok(path.into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resolve {
    session_id: String,
    job_id: String,
    adoption_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForPath {
    session_id: String,
    source_path: String,
}

fn archives(state: &AppState, receipt: &Value) -> Result<std::path::PathBuf, JsonRpcError> {
    for name in ["sourceSha256", "outputSha256"] {
        let hash = receipt[name]
            .as_str()
            .ok_or_else(|| rpc_err(1002, "Missing adoption hash", "COURSEWARE_INVALID"))?;
        crate::courseware::source_candidates::verify_archive(&state.data_dir, hash)
            .map_err(error)?;
    }
    crate::courseware::source_candidates::archive_path(
        &state.data_dir,
        receipt["outputSha256"].as_str().unwrap_or(""),
    )
    .map_err(error)
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let invalid = |error: serde_json::Error| rpc_err(1002, error.to_string(), "INVALID_PARAMS");
    match method {
        "courseware.sourceAdoption.forPath" => {
            let p: ForPath = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = project_workspace(&state, &p.session_id)?;
            let path = crate::workspace::resolve_in_workspace(Path::new(&root), &p.source_path)
                .map_err(|message| rpc_err(1002, message, "COURSEWARE_INVALID"))?;
            if path != Path::new(&p.source_path)
                || path.extension().and_then(|ext| ext.to_str()) != Some("pptx")
            {
                return Err(rpc_err(
                    1002,
                    "Canonical workspace PPTX path is required",
                    "COURSEWARE_INVALID",
                ));
            }
            let adoption = state
                .db
                .source_adoption_for_path(&root, &p.source_path)
                .map_err(error)?;
            state.db.source_adoption_barrier().map_err(error)?;
            Ok(json!({"adoption":adoption}))
        }
        "courseware.sourceAdoption.get" => {
            let p: GetParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = project_workspace(&state, &p.session_id)?;
            let receipt = state
                .db
                .get_source_adoption(&root, &p.project_id)
                .map_err(error)?;
            state.db.source_adoption_barrier().map_err(error)?;
            // Recovery metadata must remain readable even when an archive is missing/corrupt.
            match archives(&state, &receipt) {
                Ok(path) => Ok(json!({ "adoption": receipt, "path": path, "archiveError": null })),
                Err(error) => {
                    Ok(json!({ "adoption": receipt, "path": null, "archiveError": error.message }))
                }
            }
        }
        "courseware.sourceAdoption.prepare" => {
            let p: Prepare = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = project_workspace(&state, &p.session_id)?;
            let seed = state
                .courseware
                .saved_project_seed(&p.job_id, Path::new(&root))
                .map_err(error)?;
            let candidate = state
                .db
                .get_source_candidate(&root, &seed.project_id, &p.candidate_id)
                .map_err(error)?;
            let current = state
                .db
                .get_courseware_project(&root, &seed.project_id)
                .map_err(error)?
                .ok_or_else(|| {
                    rpc_err(1007, "Courseware project not found", "COURSEWARE_NOT_FOUND")
                })?;
            if candidate["request"]["kind"] != "page-fade" && super::has_saved_narration(&current) {
                return Err(rpc_err(
                    1008,
                    "COURSEWARE_STAGE_LOCKED: visual source adoption is closed after narration is saved; repair narration, audio or effects instead",
                    "COURSEWARE_STAGE_LOCKED",
                ));
            }
            let hashes = json!({ "sourceSha256": candidate["source"]["sha256"], "outputSha256": candidate["outputSha256"] });
            let path = archives(&state, &hashes)?;
            let source_path = p
                .source_path
                .as_deref()
                .map(|path| {
                    verify_live_path(
                        &root,
                        path,
                        &seed,
                        state
                            .courseware
                            .restored_source_path(&p.job_id, Path::new(&root))?,
                    )
                })
                .transpose()
                .map_err(error)?;
            let receipt = state
                .db
                .prepare_source_adoption_with_path(
                    &root,
                    &seed,
                    &p.candidate_id,
                    source_path,
                    &p.effect_bindings,
                )
                .map_err(error)?;
            state.db.source_adoption_barrier().map_err(error)?;
            Ok(json!({ "adoption": receipt, "path": path }))
        }
        "courseware.sourceAdoption.commit" | "courseware.sourceAdoption.cancel" => {
            let p: Resolve = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = project_workspace(&state, &p.session_id)?;
            let seed = state
                .courseware
                .saved_project_seed(&p.job_id, Path::new(&root))
                .map_err(error)?;
            let receipt = state
                .db
                .get_source_adoption(&root, &seed.project_id)
                .map_err(error)?;
            if method == "courseware.sourceAdoption.commit" {
                archives(&state, &receipt)?;
            }
            if let Some(path) = receipt["sourcePath"].as_str() {
                verify_live_path(
                    &root,
                    path,
                    &seed,
                    state
                        .courseware
                        .restored_source_path(&p.job_id, Path::new(&root))
                        .map_err(error)?,
                )
                .map_err(error)?;
            }
            let result = state
                .db
                .resolve_source_adoption(
                    &root,
                    &seed,
                    &p.adoption_id,
                    method == "courseware.sourceAdoption.commit",
                )
                .map_err(error)?;
            state.db.source_adoption_barrier().map_err(error)?;
            Ok(result)
        }
        _ => Err(rpc_err(-32601, "Method not found", "METHOD_NOT_FOUND")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn source_path_requires_exact_editor_identity_saved_hash_and_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let path = dir.path().join("lesson.pptx");
        std::fs::write(&path, b"saved source").unwrap();
        let digest = hex::encode(Sha256::digest(b"lesson.pptx"));
        let mut seed = crate::courseware::SavedProjectSeed {
            project_id: format!("office-lesson-{}", &digest[..12]),
            sha256: hex::encode(Sha256::digest(b"saved source")),
            pages: 1,
            identity: None,
        };
        assert_eq!(
            verify_live_path(root, path.to_str().unwrap(), &seed, None).unwrap(),
            path.to_str().unwrap()
        );
        assert!(verify_live_path(root, "lesson.pptx", &seed, None).is_err());
        seed.project_id = "office-wrong".into();
        assert!(verify_live_path(root, path.to_str().unwrap(), &seed, None).is_err());
        seed.project_id = "portable-b219f446-0cbc-4d35-97cb-fb8bb1a3e365".into();
        assert!(verify_live_path(root, path.to_str().unwrap(), &seed, None).is_err());
        assert!(verify_live_path(root, path.to_str().unwrap(), &seed, Some(&path)).is_ok());
        assert!(verify_live_path(
            root,
            path.to_str().unwrap(),
            &seed,
            Some(&dir.path().join("other.pptx"))
        )
        .is_err());
        seed.project_id = format!("office-lesson-{}", &digest[..12]);
        std::fs::write(&path, b"external edit").unwrap();
        assert!(verify_live_path(root, path.to_str().unwrap(), &seed, None).is_err());
        let outside = tempfile::tempdir().unwrap();
        assert!(verify_live_path(
            outside.path().to_str().unwrap(),
            path.to_str().unwrap(),
            &seed,
            None
        )
        .is_err());
    }
}
