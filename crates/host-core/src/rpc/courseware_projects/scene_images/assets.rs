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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    normalized_bounding_box: Option<[f64; 4]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_z_index: Option<u32>,
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
            && self
                .source_z_index
                .is_none_or(|z| (1..=1_000_000).contains(&z))
            && self.normalized_bounding_box.is_none_or(|b| {
                b.iter()
                    .all(|n| n.is_finite() && (0.0..=1000.0).contains(n))
                    && b[0] < b[2]
                    && b[1] < b[3]
            })
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
    if method == "courseware.sceneImage.bundle.stage" {
        return stage_bundle(state, params).await;
    }
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
        "courseware.sceneImage.asset.get" | "courseware.sceneImage.reference.get" => {
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
    if method == "courseware.sceneImage.reference.get" {
        verify_reference(&intents, &intents[index])?;
        let reference = intents[index].request.reference_image.as_ref().ok_or_else(|| invalid("Reference required"))?;
        let (path, length) = snapshot_assets::verify(&state.data_dir, &reference.sha256).map_err(error)?;
        if length != reference.byte_length as u64 { return Err(conflict("Archived reference length differs")); }
        let mut result = intents[index].view(current.as_deref());
        result["path"] = json!(path);
        return Ok(result);
    }
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
                if i.plan_sha256 == sha && i.page_id == page {
                    if i.target == target {
                        i.selected = i.intent_id == intent_id;
                    } else if matches!(target, Target::VisualMaster {})
                        || matches!(target, Target::CleanPlate {}) && matches!(i.target, Target::Layer { .. })
                    {
                        // Keep archived assets, but never compile layers from the previous design.
                        i.selected = false;
                    }
                }
            }
            save(&state, &key, &intents)?;
        }
    }
    files(&state, &intents[index], current.as_deref())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bundle {
    session_id: String,
    principal_key: String,
    intent_id: String,
    images: Vec<BundleImage>,
    #[serde(default)]
    stage_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BundleImage {
    target: Target,
    asset: ImageAsset,
    bytes_base64: Option<String>,
}

async fn stage_bundle(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let p: Bundle = serde_json::from_value(params).map_err(|_| invalid("Invalid layer bundle"))?;
    if (if p.stage_only {
        p.images.len() != 1
    } else {
        !(2..=32).contains(&p.images.len())
    }) || p.images.iter().any(|i| !i.asset.valid())
        || p.images
            .iter()
            .filter(|i| i.bytes_base64.is_some())
            .map(|i| i.asset.byte_length)
            .sum::<usize>()
            > 44 * 1024 * 1024
    {
        return Err(invalid("Layer bundle exceeds limits"));
    }
    let state = state.lock().await;
    let scope = Scope {
        session_id: p.session_id,
        principal_key: p.principal_key,
    };
    let root = project_workspace(&state, &scope.session_id)?;
    let key = storage_key(&root, &scope)?;
    let mut intents = load(&state, &key)?;
    let current = current_plan(&state, &root, &scope);
    let parent_index = intents
        .iter()
        .position(|i| i.intent_id == p.intent_id)
        .ok_or_else(|| invalid("Layer intent missing"))?;
    let parent = intents[parent_index].clone();
    if !p.stage_only
        && parent.asset.is_some()
        && intents
            .iter()
            .filter(|i| {
                i.intent_id
                    .starts_with(&format!("{}-layer-", parent.intent_id))
            })
            .count()
            != p.images.len() - 1
    {
        return Err(conflict(
            "Archived decomposition cannot change its image count",
        ));
    }
    if parent.request.kind != "image-layers"
        || parent.phase != Phase::Submitted
        || !matches!(parent.target, Target::CleanPlate {})
    {
        return Err(invalid("Expected submitted decomposition intent"));
    }
    if !p.stage_only
        && (p.images[0].target != (Target::CleanPlate {})
            || p.images[0].asset.normalized_bounding_box.is_some())
    {
        return Err(invalid("Layer base missing"));
    }
    let mut names = std::collections::HashSet::new();
    for (index, image) in p.images.iter().enumerate() {
        if !image.target.valid()
            || image.asset.mime_type != "image/png"
            || image.asset.task_ref != parent.task_ref.clone().unwrap()
            || image
                .bytes_base64
                .as_ref()
                .is_some_and(|s| s.len() > MAX_BYTES.div_ceil(3) * 4)
            || match image.target {
                Target::CleanPlate {} => {
                    image.asset.normalized_bounding_box.is_some() || (!p.stage_only && index != 0)
                }
                Target::Layer { .. } => {
                    image.asset.normalized_bounding_box.is_none() || !names.insert(&image.target)
                }
                _ => true,
            }
        {
            return Err(invalid("Invalid layer image"));
        }
        let bytes = match &image.bytes_base64 {
            Some(encoded) => STANDARD
                .decode(encoded)
                .map_err(|_| invalid("Invalid layer bytes"))?,
            None if !p.stage_only => {
                snapshot_assets::read(&state.data_dir, &image.asset.sha256).map_err(error)?
            }
            None => return Err(invalid("Layer bytes missing")),
        };
        if !image.asset.matches(&bytes) || hex::encode(Sha256::digest(&bytes)) != image.asset.sha256
        {
            return Err(invalid("Layer bytes differ"));
        }
        if image.bytes_base64.is_some() {
            snapshot_assets::archive_bytes(&state.data_dir, &image.asset.sha256, &bytes)
                .map_err(error)?;
        }
    }
    if p.stage_only {
        return Ok(parent.view(current.as_deref()));
    }
    for (index, image) in p.images.into_iter().enumerate() {
        let id = if index == 0 {
            parent.intent_id.clone()
        } else {
            format!("{}-layer-{index}", parent.intent_id)
        };
        let existing = intents.iter().position(|i| i.intent_id == id);
        if let Some(old) = existing {
            if intents[old].target != image.target
                || intents[old].request_hash != parent.request_hash
                || intents[old]
                    .asset
                    .as_ref()
                    .is_some_and(|a| a != &image.asset)
            {
                return Err(conflict("Archived decomposition cannot be replaced"));
            }
        }
        if let Some(old) = existing {
            intents[old].asset = Some(image.asset);
        } else {
            if intents.len() >= MAX_INTENTS {
                return Err(conflict("Scene image journal is full"));
            }
            let mut child = parent.clone();
            child.intent_id = id;
            child.target = image.target;
            child.asset = Some(image.asset);
            child.selected = false;
            child.validate()?;
            intents.push(child);
        }
    }
    save(&state, &key, &intents)?;
    Ok(intents[parent_index].view(current.as_deref()))
}
