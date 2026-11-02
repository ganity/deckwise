use super::*;
use crate::courseware::snapshot_assets;
use crate::db::courseware_projects::{music::Selection, snapshots::Asset};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotAssets {
    session_id: String,
    principal_key: String,
    project_id: String,
    expected_source_revision: String,
    expected_teaching_revision: String,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let state = state.lock().await;
    if method == "courseware.mediaCanvas.music.adopt" {
        let p: Selection = serde_json::from_value(params)
            .map_err(|_| invalid("Invalid music adoption parameters"))?;
        if !id(&p.session_id)
            || !hash(&p.principal_key)
            || !id(&p.intent_id)
            || !id(&p.project_id)
            || !id(&p.page_id)
            || !id(&p.expected_source_revision)
            || !id(&p.expected_teaching_revision)
            || !(1..=86_400_000).contains(&p.duration_ms)
        {
            return Err(invalid("Invalid decoded music target"));
        }
        if crate::sessions::session_mode(&state.db, &p.session_id)
            .map_err(error)?
            .as_deref()
            != Some("agent")
        {
            return Err(rpc_err(
                1003,
                "Music adoption requires Agent mode",
                "PERMISSION_DENIED",
            ));
        }
        let root = std::fs::canonicalize(workspace(&state, &p.session_id)?)
            .map_err(|e| error(e.into()))?;
        let key = serde_json::to_string(&(&root, &p.session_id, &p.principal_key))
            .map_err(|e| error(e.into()))?;
        let intents = load(&state, &key)?;
        let intent = intents
            .iter()
            .find(|intent| intent.intent_id == p.intent_id)
            .ok_or_else(|| {
                rpc_err(
                    1007,
                    "Music export intent not found",
                    "COURSEWARE_NOT_FOUND",
                )
            })?;
        let asset = intent
            .asset
            .as_ref()
            .filter(|_| {
                matches!(intent.request, Request::Export { .. }) && intent.phase == Phase::Submitted
            })
            .ok_or_else(|| invalid("Only an archived exported MP3 can be adopted"))?;
        if let Some(target) = &intent.target {
            let project = state
                .db
                .get_courseware_project(
                    root.to_str().ok_or_else(|| invalid("Invalid workspace"))?,
                    &p.project_id,
                )
                .map_err(error)?
                .ok_or_else(|| invalid("Music project missing"))?;
            if target.project_id != p.project_id
                || target.page_id != p.page_id
                || p.slot_id.as_deref() != Some(&target.action_id)
                || target.source != project.source
                || !project.pages.iter().any(|page| {
                    page.page_id == target.page_id
                        && page.actions.iter().any(|a| {
                            a["id"] == target.action_id
                                && (a["type"] == "music_slot" && a["prompt"] == target.prompt
                                    || a["type"] == "audio_clip"
                                        && a["audioAssetId"] == format!("music-{}", asset.sha256))
                        })
                })
            {
                return Err(conflict());
            }
        }
        let scope = intent
            .submission_scope
            .clone()
            .ok_or_else(|| invalid("Music export scope is missing"))?;
        let current_scope = state
            .db
            .courseware_media_submission_scope(&p.session_id)
            .map_err(error)?;
        if serde_json::to_value(&scope).ok() != serde_json::to_value(&current_scope).ok() {
            return Err(conflict());
        }
        let (_, bytes) = snapshot_assets::verify(&state.data_dir, &asset.sha256).map_err(error)?;
        if bytes != asset.byte_length as u64 {
            return Err(invalid("Archived music length differs"));
        }
        let (project, adopted) = state
            .db
            .adopt_courseware_music(
                root.to_str()
                    .ok_or_else(|| invalid("Invalid music workspace"))?,
                p,
                Asset {
                    id: format!("music-{}", asset.sha256),
                    sha256: asset.sha256.clone(),
                    mime_type: asset.mime_type.clone(),
                },
                asset.byte_length,
                asset.task_ref.clone(),
                scope,
            )
            .map_err(error)?;
        return Ok(json!({"project":project,"adoption":adopted.view()}));
    }
    let p: SnapshotAssets =
        serde_json::from_value(params).map_err(|_| invalid("Invalid music snapshot parameters"))?;
    if !id(&p.session_id)
        || !hash(&p.principal_key)
        || !id(&p.project_id)
        || !id(&p.expected_source_revision)
        || !id(&p.expected_teaching_revision)
    {
        return Err(invalid("Invalid music snapshot scope"));
    }
    let root =
        std::fs::canonicalize(workspace(&state, &p.session_id)?).map_err(|e| error(e.into()))?;
    let root = root
        .to_str()
        .ok_or_else(|| invalid("Invalid music workspace"))?;
    let project = state
        .db
        .get_courseware_project(root, &p.project_id)
        .map_err(error)?
        .ok_or_else(|| rpc_err(1007, "Courseware project not found", "COURSEWARE_NOT_FOUND"))?;
    if project.source.revision != p.expected_source_revision
        || project.teaching_revision != p.expected_teaching_revision
    {
        return Err(conflict());
    }
    let records = state
        .db
        .courseware_music_adoptions(root, &p.project_id)
        .map_err(error)?;
    let mut assets = std::collections::BTreeMap::new();
    for page in &project.pages {
        for action in &page.actions {
            if action["type"] == "audio_clip" {
                let record = records
                    .iter()
                    .find(|record| {
                        record.selection.session_id == p.session_id
                            && record.selection.principal_key == p.principal_key
                            && record.selection.page_id == page.page_id
                            && record.action_id == action["id"]
                            && record.asset.id == action["audioAssetId"]
                    })
                    .ok_or_else(|| invalid("Current music has no matching adoption receipt"))?;
                state
                    .db
                    .courseware_music_snapshot_asset(
                        root,
                        &project,
                        &p.session_id,
                        &p.principal_key,
                        &record.selection.intent_id,
                        &record.asset,
                    )
                    .map_err(error)?;
                let (_, size) = snapshot_assets::verify(&state.data_dir, &record.asset.sha256)
                    .map_err(error)?;
                if size != record.byte_length as u64 {
                    return Err(invalid("Archived music length differs"));
                }
                assets.insert(
                    record.asset.id.clone(),
                    json!({"asset":record.asset,
            "music":{"principalKey":p.principal_key,"intentId":record.selection.intent_id}}),
                );
            }
        }
    }
    Ok(json!({"assets":assets.into_values().collect::<Vec<_>>()}))
}

#[cfg(test)]
mod tests;
