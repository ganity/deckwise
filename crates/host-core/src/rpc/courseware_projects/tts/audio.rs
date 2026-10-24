use super::*;
use crate::courseware::snapshot_assets;
use crate::db::courseware_projects::tts::audio::{Audio, Record, MAX_AUDIO_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stage {
    session_id: String,
    project_id: String,
    principal_key: String,
    intent_id: String,
    audio: Audio,
    bytes_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Adopt {
    session_id: String,
    project_id: String,
    principal_key: String,
    intent_id: String,
    expected_teaching_revision: String,
    expected_audio_asset_id: Option<String>,
}

fn files(data_dir: &Path, record: Record) -> anyhow::Result<Value> {
    let (path, length) = snapshot_assets::verify(data_dir, &record.audio.sha256)?;
    anyhow::ensure!(
        length == record.audio.byte_length,
        "COURSEWARE_CONFLICT: archived TTS audio length differs"
    );
    Ok(
        json!({"asset":record.audio.asset(), "path":path,"audio":record.audio,
        "adoptedTeachingRevision":record.adopted_teaching_revision,"boundSource":record.bound_source,"audioReady":false}),
    )
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let invalid = |error: serde_json::Error| rpc_err(1002, error.to_string(), "INVALID_PARAMS");
    let state = state.lock().await;
    match method {
        "courseware.tts.audio.stage" => {
            let p: Stage = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            p.audio.validate().map_err(error)?;
            // Only authenticated Main may supply decoder metadata; no renderer/model route exists.
            let intent = state
                .db
                .get_courseware_tts(&root, &p.project_id, &p.principal_key, &p.intent_id)
                .map_err(error)?;
            if intent["intent"]["taskRef"]
                != serde_json::to_value(&p.audio.task_ref).map_err(invalid)?
                || p.bytes_base64.len() as u64 > MAX_AUDIO_BYTES.div_ceil(3) * 4
            {
                return Err(rpc_err(
                    1002,
                    "Invalid TTS audio task or size",
                    "COURSEWARE_INVALID",
                ));
            }
            let bytes = STANDARD
                .decode(&p.bytes_base64)
                .map_err(|_| rpc_err(1002, "Invalid TTS audio bytes", "COURSEWARE_INVALID"))?;
            let format_matches = match p.audio.mime_type.as_str() {
                "audio/wav" => {
                    bytes.len() >= 44 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE"
                }
                "audio/mpeg" => {
                    bytes.len() >= 4
                        && (&bytes[..3] == b"ID3" || (bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0))
                }
                _ => false,
            };
            if bytes.len() as u64 != p.audio.byte_length || !format_matches {
                return Err(rpc_err(
                    1002,
                    "TTS audio length or format differs",
                    "COURSEWARE_INVALID",
                ));
            }
            snapshot_assets::archive_bytes(&state.data_dir, &p.audio.sha256, &bytes)
                .map_err(error)?;
            let record = state
                .db
                .stage_courseware_tts_audio(
                    &root,
                    &p.project_id,
                    &p.principal_key,
                    &p.intent_id,
                    p.audio,
                )
                .map_err(error)?;
            files(&state.data_dir, record).map_err(error)
        }
        "courseware.tts.audio.get" => {
            let p: Get = serde_json::from_value(params).map_err(invalid)?;
            let root = project_workspace(&state, &p.session_id)?;
            let record = state
                .db
                .get_courseware_tts_audio(&root, &p.project_id, &p.principal_key, &p.intent_id)
                .map_err(error)?;
            files(&state.data_dir, record).map_err(error)
        }
        "courseware.tts.audio.adopt" => {
            let p: Adopt = serde_json::from_value(params).map_err(invalid)?;
            let root = workspace(&state, &p.session_id)?;
            let record = state
                .db
                .get_courseware_tts_audio(&root, &p.project_id, &p.principal_key, &p.intent_id)
                .map_err(error)?;
            files(&state.data_dir, record).map_err(error)?;
            let project = state
                .db
                .adopt_courseware_tts_audio(
                    &root,
                    &p.project_id,
                    &p.principal_key,
                    &p.intent_id,
                    &p.expected_teaching_revision,
                    p.expected_audio_asset_id.as_deref(),
                )
                .map_err(error)?;
            Ok(json!({"project":project,"audioReady":false}))
        }
        _ => Err(rpc_err(-32601, "Method not found", "METHOD_NOT_FOUND")),
    }
}

#[cfg(test)]
mod tests;
