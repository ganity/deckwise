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
        "courseware.video.get" | "courseware.video.begin" => &["intentId"],
        "courseware.video.bind" => &["intentId", "taskRef"],
        "courseware.video.stage" => &["intentId", "taskRef", "asset", "bytesBase64"],
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
        _ => {
            let intent_id = required(p.intent_id)?;
            match method {
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
