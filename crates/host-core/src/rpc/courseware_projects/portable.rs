//! Portable copy/restore use saved parser proofs and persisted session workspaces.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Copy {
    session_id: String,
    job_id: String,
    expected_source_revision: String,
    expected_teaching_revision: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Restore {
    session_id: String,
    job_id: String,
    source_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalMedia {
    session_id: String,
    project_id: String,
    page_id: String,
    action_id: String,
    expected_source_revision: String,
    expected_teaching_revision: String,
}

fn has_portable_files(path: &Path) -> Result<bool, JsonRpcError> {
    if path.file_name().is_none_or(|name| name != "lesson.pptx") {
        return Ok(false);
    }
    let parent = path.parent().unwrap();
    for marker in [
        "lesson.teaching.json",
        ".deckwise/current.json",
        ".deckwise/pending.json",
    ] {
        match std::fs::symlink_metadata(parent.join(marker)) {
            Ok(_) => return Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(error(e.into())),
        }
    }
    Ok(false)
}

pub(super) async fn local_media(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let p: LocalMedia = serde_json::from_value(params)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    let state = state.lock().await;
    let root = workspace(&state, &p.session_id)?;
    let project = state
        .db
        .get_courseware_project(&root, &p.project_id)
        .map_err(error)?
        .ok_or_else(|| rpc_err(1002, "Project is missing", "COURSEWARE_NOT_FOUND"))?;
    if project.source.revision != p.expected_source_revision
        || project.teaching_revision != p.expected_teaching_revision
    {
        return Err(rpc_err(
            1002,
            "Local media view changed",
            "COURSEWARE_CONFLICT",
        ));
    }
    let Some(asset) = state
        .db
        .portable_courseware_media(&root, &p.project_id, &p.page_id, &p.action_id)
        .map_err(error)?
    else {
        return Ok(json!({"media":null}));
    };
    let (path, length) = crate::courseware::snapshot_assets::verify(&state.data_dir, &asset.sha256)
        .map_err(error)?;
    if length != asset.byte_length {
        return Err(rpc_err(
            1002,
            "Local media length differs",
            "COURSEWARE_CONFLICT",
        ));
    }
    Ok(
        json!({"media":{"asset":{"id":asset.id,"sha256":asset.sha256,"mimeType":asset.mime_type},
        "path":path,"byteLength":length,"durationMs":asset.duration_ms}}),
    )
}

pub(super) async fn restore(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    restore_inner(state, params, false).await
}

pub(super) async fn attach(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    restore_inner(state, params, true).await
}

async fn restore_inner(
    state: Arc<Mutex<AppState>>,
    params: Value,
    attach: bool,
) -> Result<Value, JsonRpcError> {
    let p: Restore = serde_json::from_value(params)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    #[cfg(not(target_os = "linux"))]
    {
        let state = state.lock().await;
        let root = workspace(&state, &p.session_id)?;
        state
            .courseware
            .saved_project_seed(&p.job_id, Path::new(&root))
            .map_err(error)?;
        let path = crate::workspace::resolve_in_workspace(Path::new(&root), &p.source_path)
            .map_err(|message| rpc_err(1002, message, "COURSEWARE_INVALID"))?;
        if attach && !has_portable_files(&path)? {
            return Ok(json!({"attached":false}));
        }
        Err(rpc_err(
            1002,
            "Portable project restore is currently supported on Linux",
            "COURSEWARE_UNSUPPORTED",
        ))
    }
    #[cfg(target_os = "linux")]
    {
        use crate::courseware::{project_commit::ProjectCommitStore, snapshot_assets};
        use crate::db::courseware_projects::portable::Teaching;
        let mut state = state.lock().await;
        let root = workspace(&state, &p.session_id)?;
        let seed = state
            .courseware
            .saved_project_seed(&p.job_id, Path::new(&root))
            .map_err(error)?;
        let path = crate::workspace::resolve_in_workspace(Path::new(&root), &p.source_path)
            .map_err(|message| rpc_err(1002, message, "COURSEWARE_INVALID"))?;
        // Retained commit metadata prevents a removed sidecar from silently opening as a plain PPTX.
        if attach && !has_portable_files(&path)? {
            return Ok(json!({"attached":false}));
        }
        if path.file_name().is_none_or(|name| name != "lesson.pptx") {
            return Err(rpc_err(
                1002,
                "A portable lesson.pptx is required",
                "COURSEWARE_INVALID",
            ));
        }
        let mut store =
            ProjectCommitStore::open_in_workspace(Path::new(&root), path.parent().unwrap())
                .map_err(error)?;
        if attach {
            let content = store.attachment_baseline(&seed.sha256).map_err(error)?;
            if state
                .db
                .imported_portable_courseware(&root, &content)
                .map_err(error)?
                .is_some()
            {
                state
                    .courseware
                    .bind_restored_project(&p.job_id, Path::new(&root), content.project_uuid, &path)
                    .map_err(error)?;
                return Ok(json!({"attached":true}));
            }
        }
        let files = store.current().map_err(error)?.ok_or_else(|| {
            rpc_err(
                1002,
                "Portable project commit is missing",
                "COURSEWARE_INVALID",
            )
        })?;
        drop(files.source);
        let content = Teaching::parse(&files.teaching, files.revision.commit_id, &seed.sha256)
            .map_err(error)?;
        if seed.project_id.starts_with("portable-")
            && seed.project_id != format!("portable-{}", content.project_uuid)
        {
            return Err(rpc_err(
                1002,
                "Parser belongs to another portable project",
                "COURSEWARE_CONFLICT",
            ));
        }
        // Immutable archives may be retained on failure; no teaching becomes visible until all files verify.
        for asset in &content.media {
            let bytes = store.read_media(asset).map_err(error)?;
            snapshot_assets::archive_bytes(&state.data_dir, &asset.sha256, &bytes)
                .map_err(error)?;
        }
        let project = state
            .db
            .restore_portable_courseware_content(&root, &seed, &content)
            .map_err(error)?;
        state
            .courseware
            .bind_restored_project(&p.job_id, Path::new(&root), content.project_uuid, &path)
            .map_err(error)?;
        if attach {
            return Ok(json!({"attached":true}));
        }
        Ok(
            json!({"project":project, "projectUuid":content.project_uuid, "mediaCount":content.media.len()}),
        )
    }
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let p: Copy = serde_json::from_value(params)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (state, p);
        Err(rpc_err(
            1002,
            "Portable project copies are currently supported on Linux",
            "COURSEWARE_UNSUPPORTED",
        ))
    }
    #[cfg(target_os = "linux")]
    {
        use crate::courseware::{
            project_commit::ProjectCommitStore, snapshot_assets, source_candidates,
        };
        let state = state.lock().await;
        let root = workspace(&state, &p.session_id)?;
        let seed = state
            .courseware
            .saved_project_seed(&p.job_id, Path::new(&root))
            .map_err(error)?;
        let content = state
            .db
            .portable_courseware_content(
                &root,
                &seed,
                &p.expected_source_revision,
                &p.expected_teaching_revision,
            )
            .map_err(error)?;
        state
            .courseware
            .archive_candidate(&p.job_id, Path::new(&root), &state.data_dir, &seed.sha256)
            .map_err(error)?;
        let source =
            source_candidates::read_archive(&state.data_dir, &seed.sha256).map_err(error)?;
        let path = ProjectCommitStore::create_copy(Path::new(&root), &content, &source, |asset| {
            snapshot_assets::read(&state.data_dir, &asset.sha256)
        })
        .map_err(error)?;
        Ok(
            json!({"path":path, "projectUuid":content.project_uuid, "sourceSha256":seed.sha256,
            "teachingRevision":content.project.teaching_revision, "mediaCount":content.media.len()}),
        )
    }
}

#[cfg(test)]
mod tests;
