use super::*;
use crate::courseware::snapshot_assets;
use base64::{engine::general_purpose::STANDARD, Engine};

const MAX_BYTES: usize = 8 * 1024 * 1024;

pub(super) fn stage(
    state: &AppState,
    intent: &mut Intent,
    asset: ImageAsset,
    bytes_base64: &str,
    restore: bool,
) -> Result<(), JsonRpcError> {
    if !asset.valid()
        || intent.phase != Phase::Submitted
        || intent.task_ref.as_ref() != Some(&asset.task_ref)
        || bytes_base64.len() > MAX_BYTES.div_ceil(3) * 4
    {
        return Err(invalid("Invalid canvas image task or metadata"));
    }
    if intent.asset.as_ref().is_some_and(|old| old != &asset) {
        return Err(conflict());
    }
    if restore && intent.asset.is_none() {
        return Err(invalid("Only an archived canvas image can be restored"));
    }
    let bytes = STANDARD
        .decode(bytes_base64)
        .map_err(|_| invalid("Invalid canvas image bytes"))?;
    if !asset.matches(&bytes) {
        return Err(invalid("Canvas image format or size differs"));
    }
    // Main verifies the authenticated task and native decoding before this private RPC.
    if restore {
        snapshot_assets::restore_bytes(&state.data_dir, &asset.sha256, &bytes).map_err(error)?;
    } else {
        snapshot_assets::archive_bytes(&state.data_dir, &asset.sha256, &bytes).map_err(error)?;
    }
    intent.asset = Some(asset);
    intent.validate()
}

fn verified<'a>(
    state: &AppState,
    intent: &'a Intent,
) -> Result<(std::path::PathBuf, &'a ImageAsset), JsonRpcError> {
    let asset = intent
        .asset
        .as_ref()
        .ok_or_else(|| invalid("Canvas image is not archived"))?;
    let (path, length) = snapshot_assets::verify(&state.data_dir, &asset.sha256).map_err(error)?;
    if length != asset.byte_length as u64 {
        return Err(invalid("Archived canvas image length differs"));
    }
    Ok((path, asset))
}

pub(super) fn files(
    state: &AppState,
    intent: &Intent,
    canvas: Option<&Stored>,
) -> Result<Value, JsonRpcError> {
    let (path, _) = verified(state, intent)?;
    let mut view = intent.view(canvas);
    view["path"] = json!(path);
    Ok(view)
}

pub(super) fn reference(
    state: &AppState,
    intent: &Intent,
    sha256: &str,
) -> Result<(ReferenceImage, std::path::PathBuf, Value), JsonRpcError> {
    let (path, asset) = verified(state, intent)?;
    if asset.sha256 != sha256 || !matches!(asset.mime_type.as_str(), "image/png" | "image/jpeg") {
        return Err(invalid(
            "Canvas reference must be an owned archived PNG or JPEG",
        ));
    }
    Ok((
        ReferenceImage {
            sha256: asset.sha256.clone(),
            mime_type: asset.mime_type.clone(),
            byte_length: asset.byte_length,
        },
        path,
        serde_json::to_value(asset).map_err(|e| error(e.into()))?,
    ))
}
