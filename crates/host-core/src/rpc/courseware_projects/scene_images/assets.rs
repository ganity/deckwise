use super::*;
use crate::courseware::snapshot_assets;
use base64::{engine::general_purpose::STANDARD, Engine};

const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::rpc::courseware_projects) struct ImageAsset {
    pub task_ref: TaskRef,
    pub(in crate::rpc::courseware_projects) sha256: String,
    pub(in crate::rpc::courseware_projects) mime_type: String,
    pub(in crate::rpc::courseware_projects) byte_length: usize,
    width: u32,
    height: u32,
}

impl ImageAsset {
    pub(in crate::rpc::courseware_projects) fn valid(&self) -> bool {
        valid_hash(&self.sha256)
            && matches!(
                self.mime_type.as_str(),
                "image/png" | "image/jpeg" | "image/webp"
            )
            && (1..=MAX_BYTES).contains(&self.byte_length)
            && (1..=4096).contains(&self.width)
            && (1..=4096).contains(&self.height)
    }

    pub(in crate::rpc::courseware_projects) fn matches(&self, bytes: &[u8]) -> bool {
        if bytes.len() != self.byte_length {
            return false;
        }
        match self.mime_type.as_str() {
            "image/png" => {
                bytes.len() >= 33
                    && bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                    && bytes[8..16] == *b"\0\0\0\rIHDR"
                    && bytes[16..20] == self.width.to_be_bytes()
                    && bytes[20..24] == self.height.to_be_bytes()
            }
            "image/jpeg" => bytes.starts_with(b"\xff\xd8\xff") && bytes.ends_with(b"\xff\xd9"),
            "image/webp" => {
                bytes.len() >= 20
                    && &bytes[..4] == b"RIFF"
                    && &bytes[8..12] == b"WEBP"
                    && u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize + 8
                        == bytes.len()
            }
            _ => false,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stage {
    session_id: String,
    principal_key: String,
    intent_id: String,
    asset: ImageAsset,
    bytes_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Adopt {
    session_id: String,
    principal_key: String,
    intent_id: String,
    expected_selected_intent_id: Option<String>,
}

fn files(state: &AppState, intent: &Intent, current: Option<&str>) -> Result<Value, JsonRpcError> {
    let asset = intent
        .asset
        .as_ref()
        .ok_or_else(|| invalid("Scene image is not archived"))?;
    let (path, length) = snapshot_assets::verify(&state.data_dir, &asset.sha256).map_err(error)?;
    if length != asset.byte_length as u64 {
        return Err(conflict("Archived scene image length differs"));
    }
    let mut result = intent.view(current);
    result["path"] = json!(path);
    Ok(result)
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let decode = |e: serde_json::Error| rpc_err(1002, e.to_string(), "INVALID_PARAMS");
    let (scope, intent_id, stage, adopt) = match method {
        "courseware.sceneImage.asset.stage" => {
            let p: Stage = serde_json::from_value(params).map_err(decode)?;
            (
                Scope {
                    session_id: p.session_id.clone(),
                    principal_key: p.principal_key.clone(),
                },
                p.intent_id.clone(),
                Some(p),
                None,
            )
        }
        "courseware.sceneImage.asset.adopt" => {
            let p: Adopt = serde_json::from_value(params).map_err(decode)?;
            (
                Scope {
                    session_id: p.session_id.clone(),
                    principal_key: p.principal_key.clone(),
                },
                p.intent_id.clone(),
                None,
                Some(p),
            )
        }
        "courseware.sceneImage.asset.get" => {
            let p: Operation = serde_json::from_value(params).map_err(decode)?;
            (
                Scope {
                    session_id: p.session_id,
                    principal_key: p.principal_key,
                },
                p.intent_id,
                None,
                None,
            )
        }
        _ => return Err(rpc_err(-32601, "Method not found", "METHOD_NOT_FOUND")),
    };
    let state = state.lock().await;
    let root = project_workspace(&state, &scope.session_id)?;
    let key = storage_key(&root, &scope)?;
    let mut intents = load(&state, &key)?;
    let current = current_plan(&state, &root, &scope);
    let index = intents
        .iter()
        .position(|i| i.intent_id == intent_id)
        .ok_or_else(|| rpc_err(1007, "Scene image intent not found", "COURSEWARE_NOT_FOUND"))?;
    if let Some(p) = stage {
        if !p.asset.valid()
            || (matches!(intents[index].target, Target::Layer { .. })
                && p.asset.mime_type != "image/png")
            || intents[index].task_ref.as_ref() != Some(&p.asset.task_ref)
            || p.bytes_base64.len() > MAX_BYTES.div_ceil(3) * 4
        {
            return Err(invalid("Invalid scene image task or metadata"));
        }
        if intents[index]
            .asset
            .as_ref()
            .is_some_and(|old| old != &p.asset)
        {
            return Err(conflict("Archived scene image cannot be replaced"));
        }
        let bytes = STANDARD
            .decode(&p.bytes_base64)
            .map_err(|_| invalid("Invalid scene image bytes"))?;
        if !p.asset.matches(&bytes) {
            return Err(invalid("Scene image format or size differs"));
        }
        // Main verifies the authenticated task and native decoding before this private RPC.
        snapshot_assets::archive_bytes(&state.data_dir, &p.asset.sha256, &bytes).map_err(error)?;
        if intents[index].asset.is_none() {
            intents[index].asset = Some(p.asset);
            save(&state, &key, &intents)?;
        }
    } else if let Some(p) = adopt {
        let target = &intents[index];
        if current.as_deref() != Some(&target.plan_sha256) || target.asset.is_none() {
            return Err(conflict("Review the current plan and archived image first"));
        }
        files(&state, target, current.as_deref())?;
        let selected = intents.iter().find(|i| {
            i.selected
                && i.plan_sha256 == target.plan_sha256
                && i.page_id == target.page_id
                && i.target == target.target
        });
        if selected.map(|i| i.intent_id.as_str()) != p.expected_selected_intent_id.as_deref() {
            return Err(conflict("Selected scene image changed; refresh and review"));
        }
        if !target.selected {
            let (sha, page, target) = (
                target.plan_sha256.clone(),
                target.page_id.clone(),
                target.target.clone(),
            );
            for i in &mut intents {
                if i.plan_sha256 == sha && i.page_id == page && i.target == target {
                    i.selected = i.intent_id == intent_id;
                }
            }
            save(&state, &key, &intents)?;
        }
    }
    files(&state, &intents[index], current.as_deref())
}
