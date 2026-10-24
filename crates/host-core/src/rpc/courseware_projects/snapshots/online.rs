use super::*;
use crate::db::courseware_projects::CoursewareProject;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixedAsset {
    asset: Asset,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Import {
    session_id: String,
    job_id: String,
    snapshot_id: String,
    source_byte_length: u64,
    project: CoursewareProject,
    mapping: Value,
    assets: Vec<FixedAsset>,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let p: Import = serde_json::from_value(params)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    if p.assets.len() > 1000
        || p.assets.iter().any(|asset| {
            asset.path.len() > 4096
                || asset.asset.id.starts_with("music-")
                || asset.asset.id.starts_with("tts-")
        })
    {
        return Err(rpc_err(
            1002,
            "Unsupported online snapshot asset provenance",
            "COURSEWARE_INVALID",
        ));
    }
    let state = state.lock().await;
    let root = workspace(&state, &p.session_id)?;
    let parsed = state
        .courseware
        .archive_online_snapshot(
            &p.job_id,
            Path::new(&root),
            &state.data_dir,
            &p.project.source.sha256,
            p.source_byte_length,
        )
        .map_err(error)?;
    let mut total = 0u64;
    for input in &p.assets {
        total += snapshot_assets::archive(
            &state.data_dir,
            Path::new(&root),
            Path::new(&input.path),
            &input.asset.sha256,
        )
        .map_err(error)?;
        if total > snapshot_assets::MAX_TOTAL_BYTES {
            return Err(rpc_err(
                1002,
                "Snapshot audio exceeds size limit",
                "COURSEWARE_INVALID",
            ));
        }
    }
    let record = state
        .db
        .import_online_courseware_snapshot(
            &root,
            &parsed,
            &p.snapshot_id,
            p.project,
            &p.mapping,
            p.assets.into_iter().map(|input| input.asset).collect(),
        )
        .map_err(error)?;
    files(&state.data_dir, record).map_err(error)
}

#[cfg(test)]
mod tests;
