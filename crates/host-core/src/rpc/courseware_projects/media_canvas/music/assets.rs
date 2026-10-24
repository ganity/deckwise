use super::*;
use crate::courseware::snapshot_assets;
use base64::{engine::general_purpose::STANDARD, Engine};

const MAX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Asset {
    pub task_ref: TaskRef,
    pub sha256: String,
    pub mime_type: String,
    pub byte_length: usize,
}

impl Asset {
    pub(super) fn valid(&self) -> bool {
        hash(&self.sha256)
            && self.mime_type == "audio/mpeg"
            && (4..=MAX_BYTES).contains(&self.byte_length)
    }
    fn matches(&self, bytes: &[u8]) -> bool {
        self.valid()
            && bytes.len() == self.byte_length
            && hex::encode(Sha256::digest(bytes)) == self.sha256
            && (bytes.starts_with(b"ID3") || bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Preview {
    pub candidate_id: String,
    pub asset: Asset,
}

fn selected<'a>(
    intent: &'a Intent,
    candidate: Option<&str>,
) -> Result<Option<&'a Asset>, JsonRpcError> {
    match (&intent.request, candidate) {
        (Request::Music { .. }, Some(candidate))
            if candidate_id(candidate)
                && intent.ready
                && intent
                    .candidates
                    .iter()
                    .any(|c| c.candidate_id == candidate && c.state == "completed") =>
        {
            Ok(intent
                .previews
                .iter()
                .find(|preview| preview.candidate_id == candidate)
                .map(|preview| &preview.asset))
        }
        (Request::Export { .. }, None) => Ok(intent.asset.as_ref()),
        _ => Err(invalid("Invalid music archive selection")),
    }
}

pub(super) fn stage(
    state: &AppState,
    intent: &mut Intent,
    candidate: Option<&str>,
    asset: Asset,
    bytes_base64: &str,
    restore: bool,
) -> Result<(), JsonRpcError> {
    if intent.phase != Phase::Submitted
        || intent.task_ref.as_ref() != Some(&asset.task_ref)
        || !asset.valid()
        || bytes_base64.len() > MAX_BYTES.div_ceil(3) * 4
    {
        return Err(invalid("Invalid music task or archive metadata"));
    }
    let previous = selected(intent, candidate)?;
    if previous.is_some_and(|previous| previous != &asset) {
        return Err(conflict());
    }
    if restore && previous.is_none() {
        return Err(invalid("Only an archived music asset can be restored"));
    }
    let bytes = STANDARD
        .decode(bytes_base64)
        .map_err(|_| invalid("Invalid music bytes"))?;
    if !asset.matches(&bytes) {
        return Err(invalid("Music format, hash or size differs"));
    }
    if restore {
        snapshot_assets::restore_bytes(&state.data_dir, &asset.sha256, &bytes).map_err(error)?;
    } else {
        snapshot_assets::archive_bytes(&state.data_dir, &asset.sha256, &bytes).map_err(error)?;
    }
    if let Some(candidate) = candidate {
        if previous.is_none() {
            intent.previews.push(Preview {
                candidate_id: candidate.into(),
                asset,
            });
        }
    } else {
        intent.asset = Some(asset);
    }
    intent.validate()
}

pub(super) fn files(
    state: &AppState,
    intent: &Intent,
    canvas: Option<&Stored>,
    candidate: Option<&str>,
) -> Result<Value, JsonRpcError> {
    let asset =
        selected(intent, candidate)?.ok_or_else(|| invalid("Music asset is not archived"))?;
    let (path, length) = snapshot_assets::verify(&state.data_dir, &asset.sha256).map_err(error)?;
    if length != asset.byte_length as u64 {
        return Err(invalid("Archived music length differs"));
    }
    let mut view = intent.view(canvas);
    view["path"] = json!(path);
    Ok(view)
}
