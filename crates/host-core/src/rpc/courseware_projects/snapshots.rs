use super::*;
use crate::courseware::{snapshot_assets, source_candidates};
use crate::db::courseware_projects::snapshots::{Asset, SnapshotRecord};

mod online;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TtsAsset {
    principal_key: String,
    intent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InputAsset {
    asset: Asset,
    path: Option<String>,
    tts: Option<TtsAsset>,
    music: Option<TtsAsset>,
    video: Option<TtsAsset>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Capture {
    session_id: String,
    job_id: String,
    snapshot_id: String,
    expected_source_revision: String,
    expected_teaching_revision: String,
    assets: Vec<InputAsset>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Get {
    session_id: String,
    project_id: String,
    snapshot_id: String,
}

fn files(data_dir: &Path, record: SnapshotRecord) -> anyhow::Result<Value> {
    source_candidates::verify_archive(data_dir, &record.snapshot.source.sha256)?;
    let source_path = source_candidates::archive_path(data_dir, &record.snapshot.source.sha256)?;
    let mut total = 0u64;
    let mut assets = Vec::new();
    for asset in &record.assets {
        let (path, size) = snapshot_assets::verify(data_dir, &asset.sha256)?;
        total += size;
        anyhow::ensure!(
            total <= snapshot_assets::MAX_TOTAL_BYTES,
            "COURSEWARE_INVALID: snapshot audio exceeds size limit"
        );
        assets.push(
            json!({"id":asset.id,"sha256":asset.sha256,"mimeType":asset.mime_type,"path":path}),
        );
    }
    Ok(
        json!({"snapshot":record.snapshot,"project":record.project,"mapping":record.mapping(),
        "sourcePath":source_path,"assets":assets}),
    )
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    if method == "courseware.snapshot.importOnline" {
        return online::handle(state, params).await;
    }
    let invalid = |error: serde_json::Error| rpc_err(1002, error.to_string(), "INVALID_PARAMS");
    if method == "courseware.snapshot.get" || method == "courseware.snapshot.onlineOrigin" {
        let p: Get = serde_json::from_value(params).map_err(invalid)?;
        let state = state.lock().await;
        let root = workspace(&state, &p.session_id)?;
        if method == "courseware.snapshot.onlineOrigin" {
            let online = state
                .db
                .is_online_courseware_snapshot(&root, &p.project_id, &p.snapshot_id)
                .map_err(error)?;
            return Ok(json!({ "teamProjectId": if online { Some(p.project_id) } else { None } }));
        }
        let record = state
            .db
            .get_courseware_snapshot(&root, &p.project_id, &p.snapshot_id)
            .map_err(error)?;
        return files(&state.data_dir, record).map_err(error);
    }
    let p: Capture = serde_json::from_value(params).map_err(invalid)?;
    let state = state.lock().await;
    let root = workspace(&state, &p.session_id)?;
    if p.assets.len() > 1000
        || p.assets.iter().any(|asset| {
            asset.path.as_ref().is_some_and(|path| path.len() > 4096)
                || [
                    asset.path.is_some(),
                    asset.tts.is_some(),
                    asset.music.is_some(),
                    asset.video.is_some(),
                ]
                .into_iter()
                .filter(|present| *present)
                .count()
                    != 1
                || asset.asset.id.starts_with("music-") && asset.music.is_none()
                || asset.asset.id.starts_with("video-") && asset.video.is_none()
        })
    {
        return Err(rpc_err(
            1002,
            "Invalid snapshot assets",
            "COURSEWARE_INVALID",
        ));
    }
    let seed = state
        .courseware
        .saved_project_seed(&p.job_id, Path::new(&root))
        .map_err(error)?;
    state
        .courseware
        .archive_candidate(&p.job_id, Path::new(&root), &state.data_dir, &seed.sha256)
        .map_err(error)?;
    let mut total = 0u64;
    for input in &p.assets {
        if let Some(path) = &input.path {
            total += snapshot_assets::archive(
                &state.data_dir,
                Path::new(&root),
                Path::new(path),
                &input.asset.sha256,
            )
            .map_err(error)?;
        } else if let Some(tts) = input.tts.as_ref() {
            let intent = state
                .db
                .get_courseware_tts(&root, &seed.project_id, &tts.principal_key, &tts.intent_id)
                .map_err(error)?;
            let record = state
                .db
                .get_courseware_tts_audio(
                    &root,
                    &seed.project_id,
                    &tts.principal_key,
                    &tts.intent_id,
                )
                .map_err(error)?;
            let saved_intent = serde_json::from_value(intent["intent"].clone())
                .map_err(|error| rpc_err(1002, error.to_string(), "COURSEWARE_INVALID"))?;
            let page_id = intent["intent"]["selection"]["pageId"].as_str();
            let action_id = intent["intent"]["selection"]["actionId"].as_str();
            let text = intent["intent"]["request"]["input"].as_str();
            let current = state
                .db
                .get_courseware_project(&root, &seed.project_id)
                .map_err(error)?
                .ok_or_else(|| {
                    rpc_err(1002, "Courseware project not found", "COURSEWARE_NOT_FOUND")
                })?;
            let action_matches = current
                .pages
                .iter()
                .find(|page| Some(page.page_id.as_str()) == page_id)
                .is_some_and(|page| {
                    page.actions.iter().any(|action| {
                        action["id"].as_str() == action_id
                            && action["type"] == "speech"
                            && action["text"].as_str() == text
                            && action["audioAssetId"] == input.asset.id
                    })
                });
            let audio_asset = record.audio.asset();
            if record.adopted_teaching_revision.is_none()
                || !record.matches_source(&saved_intent, &current.source)
                || current.source.sha256 != seed.sha256
                || !action_matches
                || audio_asset.id != input.asset.id
                || audio_asset.sha256 != input.asset.sha256
                || audio_asset.mime_type != input.asset.mime_type
            {
                return Err(rpc_err(
                    1002,
                    "TTS snapshot asset is not attached to current teaching",
                    "COURSEWARE_CONFLICT",
                ));
            }
            total += snapshot_assets::verify(&state.data_dir, &input.asset.sha256)
                .map_err(error)?
                .1;
        }
        if let Some(music) = &input.music {
            let project = state
                .db
                .get_courseware_project(&root, &seed.project_id)
                .map_err(error)?
                .ok_or_else(|| {
                    rpc_err(1007, "Courseware project not found", "COURSEWARE_NOT_FOUND")
                })?;
            let record = state
                .db
                .courseware_music_snapshot_asset(
                    &root,
                    &project,
                    &p.session_id,
                    &music.principal_key,
                    &music.intent_id,
                    &input.asset,
                )
                .map_err(error)?;
            let (_, size) =
                snapshot_assets::verify(&state.data_dir, &input.asset.sha256).map_err(error)?;
            if size != record.byte_length as u64 {
                return Err(rpc_err(
                    1002,
                    "Archived music length differs",
                    "COURSEWARE_INVALID",
                ));
            }
            total += size;
        }
        if let Some(video) = &input.video {
            let project = state
                .db
                .get_courseware_project(&root, &seed.project_id)
                .map_err(error)?
                .ok_or_else(|| rpc_err(1002, "Missing project", "COURSEWARE_NOT_FOUND"))?;
            let intent = state
                .db
                .get_courseware_video(
                    &root,
                    &seed.project_id,
                    &video.principal_key,
                    &video.intent_id,
                )
                .map_err(error)?;
            let asset = intent
                .asset
                .as_ref()
                .ok_or_else(|| rpc_err(1002, "Missing video archive", "COURSEWARE_CONFLICT"))?;
            let scope = intent
                .submission_scope
                .as_ref()
                .ok_or_else(|| rpc_err(1002, "Missing video scope", "COURSEWARE_CONFLICT"))?;
            if intent.phase != "adopted"
                || !intent.matches(&project)
                || scope.session_id != p.session_id
                || project.source.sha256 != seed.sha256
                || input.asset.id != asset.asset().id
                || input.asset.sha256 != asset.sha256
                || input.asset.mime_type != "video/mp4"
            {
                return Err(rpc_err(
                    1002,
                    "Video is not attached to current teaching",
                    "COURSEWARE_CONFLICT",
                ));
            }
            let (_, length) =
                snapshot_assets::verify(&state.data_dir, &asset.sha256).map_err(error)?;
            if length != asset.byte_length {
                return Err(rpc_err(
                    1002,
                    "Wrong video archive length",
                    "COURSEWARE_CONFLICT",
                ));
            }
            total += length;
        }
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
        .capture_courseware_snapshot(
            &root,
            &seed,
            &p.snapshot_id,
            &p.expected_source_revision,
            &p.expected_teaching_revision,
            p.assets.into_iter().map(|input| input.asset).collect(),
        )
        .map_err(error)?;
    files(&state.data_dir, record).map_err(error)
}
