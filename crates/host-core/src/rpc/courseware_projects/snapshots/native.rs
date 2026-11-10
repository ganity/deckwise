use super::*;
use crate::db::courseware_projects::CoursewareProject;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixedAsset { asset: Asset, path: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Import {
    session_id: String, job_id: String, snapshot_id: String,
    project: CoursewareProject, identity: Value, assets: Vec<FixedAsset>,
}

// An immutable export snapshot never becomes a second editable teaching project.
pub(super) async fn handle(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let p: Import = serde_json::from_value(params).map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    if p.assets.len() > 1000 || p.assets.iter().any(|a| a.path.len() > 4096) {
        return Err(rpc_err(1002, "Invalid native snapshot assets", "COURSEWARE_INVALID"));
    }
    let state = state.lock().await;
    let root = workspace(&state, &p.session_id)?;
    let parsed = state.courseware.archive_candidate(&p.job_id, Path::new(&root), &state.data_dir, &p.project.source.sha256).map_err(error)?;
    let parsed_pages = parsed.identity.as_ref().and_then(|v| v["pages"].as_array()).ok_or_else(|| rpc_err(1002, "Missing parsed native identity", "COURSEWARE_INVALID"))?;
    let native_pages = p.identity["pages"].as_array().ok_or_else(|| rpc_err(1002, "Missing native identity", "COURSEWARE_INVALID"))?;
    if native_pages.len() != parsed_pages.len() || native_pages.len() != p.project.pages.len() { return Err(rpc_err(1002, "Native page identity changed", "COURSEWARE_CONFLICT")); }
    let mut pages = Vec::new();
    for ((source, native), page) in parsed_pages.iter().zip(native_pages).zip(&p.project.pages) {
        let objects = source["objects"].as_array().ok_or_else(|| rpc_err(1002, "Missing parsed objects", "COURSEWARE_INVALID"))?;
        let bound = native["objects"].as_array().ok_or_else(|| rpc_err(1002, "Missing native objects", "COURSEWARE_INVALID"))?;
        if native["pageId"] != page.page_id { return Err(rpc_err(1002, "Native objects changed", "COURSEWARE_CONFLICT")); }
        let mut mapped = Vec::new();
        for object in objects {
            let matches: Vec<_> = bound.iter().filter(|o| o["sourceShapeId"].is_string() && o["sourceShapeId"] == object["sourceShapeId"]).collect();
            if matches.len() != 1 { return Err(rpc_err(1002, "Ambiguous native shape identity", "COURSEWARE_CONFLICT")); }
            mapped.push(json!({"objectId": matches[0]["logicalId"], "importElementId": object["importElementId"]}));
        }
        // A parsed leaf carries its source group ancestry. Preserve group aliases separately;
        // the fixed builder verifies membership against these exact source bytes and derives bounds.
        let groups: Vec<_> = bound.iter().filter(|o| !objects.iter().any(|leaf| leaf["sourceShapeId"] == o["sourceShapeId"]))
            .map(|o| json!({"objectId": o["logicalId"], "sourceShapeId": o["sourceShapeId"]})).collect();
        pages.push(json!({"pageId": page.page_id, "importPageId": source["importPageId"], "objects": mapped, "groups": groups}));
    }
    let mapping = json!({"revision": uuid::Uuid::new_v4().to_string(), "sourceRevision": p.project.source.revision,
        "sourceSha256": parsed.sha256, "pages": pages});
    let mut total = 0u64;
    for input in &p.assets {
        total += snapshot_assets::archive(&state.data_dir, Path::new(&root), Path::new(&input.path), &input.asset.sha256).map_err(error)?;
        if total > snapshot_assets::MAX_TOTAL_BYTES { return Err(rpc_err(1002, "Native snapshot exceeds media budget", "COURSEWARE_INVALID")); }
    }
    let record = state.db.import_native_courseware_snapshot(&root, &parsed, &p.snapshot_id, p.project, &mapping,
        p.assets.into_iter().map(|a| a.asset).collect()).map_err(error)?;
    files(&state.data_dir, record).map_err(error)
}
