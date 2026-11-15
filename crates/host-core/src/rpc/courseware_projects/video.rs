use super::*;
use crate::courseware::snapshot_assets;
use crate::db::courseware_projects::{tts::TaskRef, video::VideoAsset};
use base64::{engine::general_purpose::STANDARD, Engine};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    session_id: String,
    project_id: String,
    principal_key: String,
    intent_id: Option<String>,
    page_id: Option<String>,
    action_id: Option<String>,
    expected_source_revision: Option<String>,
    slot_id: Option<String>,
    model: Option<String>,
    task_ref: Option<TaskRef>,
    asset: Option<VideoAsset>,
    bytes_base64: Option<String>,
    expected_teaching_revision: Option<String>,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let extra: &[&str] = match method {
        "courseware.video.list" => &[],
        "courseware.video.prepare" => &["pageId", "slotId", "model"],
        "courseware.video.get"
        | "courseware.video.asset.get"
        | "courseware.video.begin"
        | "courseware.video.retry" => &["intentId"],
        "courseware.video.bind" => &["intentId", "taskRef"],
        "courseware.video.stage" => &["intentId", "taskRef", "asset", "bytesBase64"],
        "courseware.video.reuse" => &[
            "intentId",
            "pageId",
            "actionId",
            "expectedSourceRevision",
            "expectedTeachingRevision",
        ],
        "courseware.video.adopt" => &["intentId", "expectedTeachingRevision"],
        _ => return Err(rpc_err(-32601, "Method not found", "METHOD_NOT_FOUND")),
    };
    let keys = ["sessionId", "projectId", "principalKey"]
        .into_iter()
        .chain(extra.iter().copied())
        .collect::<Vec<_>>();
    if !params
        .as_object()
        .is_some_and(|v| v.len() == keys.len() && keys.iter().all(|k| v.contains_key(*k)))
    {
        return Err(rpc_err(1002, "Invalid video fields", "INVALID_PARAMS"));
    }
    let p: Request = serde_json::from_value(params)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    let state = state.lock().await;
    let root = project_workspace(&state, &p.session_id)?;
    let required = |value: Option<String>| {
        value.ok_or_else(|| rpc_err(1002, "Missing video field", "INVALID_PARAMS"))
    };
    let result = match method {
        "courseware.video.list" => {
            return state
                .db
                .list_courseware_videos(&root, &p.project_id, &p.principal_key)
                .map(|intents| json!({"intents":intents}))
                .map_err(error)
        }
        "courseware.video.prepare" => state.db.prepare_courseware_video(
            &root,
            &p.project_id,
            &p.principal_key,
            &required(p.page_id)?,
            &required(p.slot_id)?,
            &required(p.model)?,
        ),
        "courseware.video.retry" => state.db.retry_courseware_video(
            &root,
            &p.project_id,
            &p.principal_key,
            &required(p.intent_id)?,
        ),
        _ => {
            let intent_id = required(p.intent_id)?;
            match method {
                "courseware.video.reuse" => {
                    let project = state
                        .db
                        .get_courseware_project(&root, &p.project_id)
                        .map_err(error)?
                        .ok_or_else(|| rpc_err(1002, "Missing project", "COURSEWARE_NOT_FOUND"))?;
                    let asset = state
                        .db
                        .current_courseware_video_asset(
                            &root,
                            &project,
                            &p.principal_key,
                            &intent_id,
                            &p.session_id,
                        )
                        .map_err(error)?;
                    let (_, length) =
                        snapshot_assets::verify(&state.data_dir, &asset.sha256).map_err(error)?;
                    if length != asset.byte_length {
                        return Err(rpc_err(
                            1002,
                            "Wrong video archive length",
                            "COURSEWARE_CONFLICT",
                        ));
                    }
                    let write = TeachingWrite {
                        project_id: p.project_id,
                        page_id: required(p.page_id)?,
                        expected_source_revision: required(p.expected_source_revision)?,
                        expected_teaching_revision: required(p.expected_teaching_revision)?,
                        actions: Vec::new(),
                    };
                    return state
                        .db
                        .reuse_courseware_video(
                            &root,
                            &write,
                            &p.principal_key,
                            &intent_id,
                            &p.session_id,
                            &required(p.action_id)?,
                        )
                        .map(|project| json!({"project":project}))
                        .map_err(error);
                }
                "courseware.video.asset.get" => {
                    let project = state
                        .db
                        .get_courseware_project(&root, &p.project_id)
                        .map_err(error)?
                        .ok_or_else(|| rpc_err(1002, "Missing project", "COURSEWARE_NOT_FOUND"))?;
                    let asset = state
                        .db
                        .current_courseware_video_asset(
                            &root,
                            &project,
                            &p.principal_key,
                            &intent_id,
                            &p.session_id,
                        )
                        .map_err(error)?;
                    let (path, length) =
                        snapshot_assets::verify(&state.data_dir, &asset.sha256).map_err(error)?;
                    if length != asset.byte_length {
                        return Err(rpc_err(
                            1002,
                            "Wrong video archive length",
                            "COURSEWARE_CONFLICT",
                        ));
                    }
                    return Ok(json!({"asset":asset,"path":path}));
                }
                "courseware.video.get" => state.db.get_courseware_video(
                    &root,
                    &p.project_id,
                    &p.principal_key,
                    &intent_id,
                ),
                "courseware.video.begin" => state.db.begin_courseware_video(
                    &root,
                    &p.project_id,
                    &p.principal_key,
                    &intent_id,
                    &p.session_id,
                ),
                "courseware.video.bind" => state.db.bind_courseware_video(
                    &root,
                    &p.project_id,
                    &p.principal_key,
                    &intent_id,
                    p.task_ref
                        .ok_or_else(|| rpc_err(1002, "Missing video task", "INVALID_PARAMS"))?,
                ),
                "courseware.video.stage" => {
                    let asset = p
                        .asset
                        .ok_or_else(|| rpc_err(1002, "Missing video asset", "INVALID_PARAMS"))?;
                    asset.validate().map_err(error)?;
                    let encoded = required(p.bytes_base64)?;
                    if encoded.len() as u64 != asset.byte_length.div_ceil(3) * 4 {
                        return Err(rpc_err(1002, "Invalid video size", "COURSEWARE_INVALID"));
                    }
                    let bytes = STANDARD
                        .decode(&encoded)
                        .map_err(|_| rpc_err(1002, "Invalid video bytes", "COURSEWARE_INVALID"))?;
                    if bytes.len() as u64 != asset.byte_length
                        || bytes.len() < 12
                        || &bytes[4..8] != b"ftyp"
                        || STANDARD.encode(&bytes) != encoded
                    {
                        return Err(rpc_err(1002, "Invalid video format", "COURSEWARE_INVALID"));
                    }
                    let task = p
                        .task_ref
                        .ok_or_else(|| rpc_err(1002, "Missing video task", "INVALID_PARAMS"))?;
                    let saved = state
                        .db
                        .get_courseware_video(&root, &p.project_id, &p.principal_key, &intent_id)
                        .map_err(error)?;
                    if saved.task_ref.as_ref() != Some(&task) {
                        return Err(rpc_err(1002, "Wrong video task", "COURSEWARE_CONFLICT"));
                    }
                    snapshot_assets::archive_bytes(&state.data_dir, &asset.sha256, &bytes)
                        .map_err(error)?;
                    state.db.stage_courseware_video(
                        &root,
                        &p.project_id,
                        &p.principal_key,
                        &intent_id,
                        &task,
                        asset,
                    )
                }
                "courseware.video.adopt" => {
                    let saved = state
                        .db
                        .get_courseware_video(&root, &p.project_id, &p.principal_key, &intent_id)
                        .map_err(error)?;
                    let asset = saved.asset.ok_or_else(|| {
                        rpc_err(1002, "Video is not archived", "COURSEWARE_CONFLICT")
                    })?;
                    let (_, length) =
                        snapshot_assets::verify(&state.data_dir, &asset.sha256).map_err(error)?;
                    if length != asset.byte_length {
                        return Err(rpc_err(
                            1002,
                            "Wrong video archive length",
                            "COURSEWARE_CONFLICT",
                        ));
                    }
                    return state
                        .db
                        .adopt_courseware_video(
                            &root,
                            &p.project_id,
                            &p.principal_key,
                            &intent_id,
                            &required(p.expected_teaching_revision)?,
                        )
                        .map(|project| json!({"project":project}))
                        .map_err(error);
                }
                _ => unreachable!(),
            }
        }
    }
    .map_err(error)?;
    Ok(json!({"intent":result}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    async fn read(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
        let (tx, _) = mpsc::unbounded_channel();
        handle_request(state, "courseware.video.asset.get", params, tx).await
    }

    #[tokio::test]
    async fn adopted_video_local_read_checks_scope_attachment_and_archive() {
        let dir = tempfile::tempdir().unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let session = sessions::create_session(
            &app.db,
            None,
            None,
            None,
            None,
            Some(dir.path().to_string_lossy().into()),
        )
        .unwrap();
        let root = dir.path().to_str().unwrap();
        let raw: Value = serde_json::from_slice(include_bytes!(
            "../../../../../packages/shared/src/courseware-contract.fixtures/accepted.json"
        ))
        .unwrap();
        let mut project: crate::db::courseware_projects::CoursewareProject =
            serde_json::from_value(raw["project"].clone()).unwrap();
        project.pages[0]
            .actions
            .push(json!({"id":"clip","type":"video_slot","prompt":"A silent square."}));
        app.db.create_courseware_project(root, &project).unwrap();
        let principal = "a".repeat(64);
        let intent = app
            .db
            .prepare_courseware_video(
                root,
                &project.project_id,
                &principal,
                &project.pages[0].page_id,
                "clip",
                "model",
            )
            .unwrap();
        app.db
            .begin_courseware_video(
                root,
                &project.project_id,
                &principal,
                &intent.intent_id,
                &session.id,
            )
            .unwrap();
        let task = TaskRef {
            task_id: "task".into(),
            idempotency_key: intent.idempotency_key,
            request_hash: intent.request_hash,
        };
        app.db
            .bind_courseware_video(
                root,
                &project.project_id,
                &principal,
                &intent.intent_id,
                task.clone(),
            )
            .unwrap();
        let bytes = b"\x00\x00\x00\x18ftypmp42-fake-local-video";
        let asset = VideoAsset {
            sha256: hex::encode(Sha256::digest(bytes)),
            byte_length: bytes.len() as u64,
            duration_ms: 1000,
            width: 320,
            height: 180,
        };
        snapshot_assets::archive_bytes(&app.data_dir, &asset.sha256, bytes).unwrap();
        app.db
            .stage_courseware_video(
                root,
                &project.project_id,
                &principal,
                &intent.intent_id,
                &task,
                asset.clone(),
            )
            .unwrap();
        let state = Arc::new(Mutex::new(app));
        let scope = json!({"sessionId":session.id,"projectId":project.project_id,"principalKey":principal,"intentId":intent.intent_id});
        assert!(read(state.clone(), scope.clone()).await.is_err());
        state
            .lock()
            .await
            .db
            .adopt_courseware_video(
                root,
                &project.project_id,
                &principal,
                &intent.intent_id,
                &project.teaching_revision,
            )
            .unwrap();
        let result = read(state.clone(), scope.clone()).await.unwrap();
        assert_eq!(result["asset"]["sha256"], asset.sha256);
        assert_eq!(
            std::fs::read(result["path"].as_str().unwrap()).unwrap(),
            bytes
        );
        let mut foreign = scope.clone();
        foreign["principalKey"] = json!("b".repeat(64));
        assert!(read(state.clone(), foreign).await.is_err());
        let mut injected = scope.clone();
        injected["path"] = json!("/tmp/file");
        assert!(read(state.clone(), injected).await.is_err());
        let current = state
            .lock()
            .await
            .db
            .get_courseware_project(root, &project.project_id)
            .unwrap()
            .unwrap();
        let mut reuse = scope.clone();
        reuse["pageId"] = json!(current.pages[0].page_id);
        reuse["actionId"] = json!("repeat-video");
        reuse["expectedSourceRevision"] = json!(current.source.revision);
        reuse["expectedTeachingRevision"] = json!(current.teaching_revision);
        let (tx, _) = mpsc::unbounded_channel();
        let repeated = handle_request(state.clone(), "courseware.video.reuse", reuse.clone(), tx)
            .await
            .unwrap();
        assert_eq!(
            repeated["project"]["pages"][0]["actions"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["id"],
            "repeat-video"
        );
        let (tx, _) = mpsc::unbounded_channel();
        assert_eq!(
            handle_request(state.clone(), "courseware.video.reuse", reuse, tx)
                .await
                .unwrap(),
            repeated
        );
        std::fs::write(result["path"].as_str().unwrap(), b"corrupt").unwrap();
        assert!(read(state, scope).await.is_err());
    }
}
