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

fn native_object_id(object: &Value, bound: &[Value]) -> Result<Value, JsonRpcError> {
    // Inherited artwork keeps its verified parser identity, never a slide-shape alias.
    if !object["sourceShapeId"].is_string() && object["logicalId"].is_string() &&
        object["importElementId"].as_str().is_some_and(|id| id.starts_with("pptx_fallback_layout_") || id.starts_with("pptx_fallback_master_")) {
        if let Some(id) = object["logicalId"].as_str().and_then(|id| id.strip_prefix("object:")) {
            return Ok(json!(format!("inherited-{id}")));
        }
    }
    let matches: Vec<_> = bound.iter().filter(|o| o["sourceShapeId"].is_string() && o["sourceShapeId"] == object["sourceShapeId"]).collect();
    if matches.len() != 1 { return Err(rpc_err(1002, "Ambiguous native shape identity", "COURSEWARE_CONFLICT")); }
    Ok(matches[0]["logicalId"].clone())
}

// An immutable export snapshot never becomes a second editable teaching project.
pub(super) async fn handle(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let mut p: Import = serde_json::from_value(params).map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    if p.assets.len() > 1000 || p.assets.iter().any(|a| a.path.len() > 4096) {
        return Err(rpc_err(1002, "Invalid native snapshot assets", "COURSEWARE_INVALID"));
    }
    // Native media IDs are document-local. The immutable fixed contract uses content-addressed clip IDs.
    let mut aliases = std::collections::HashMap::new();
    for action in p.project.pages.iter_mut().flat_map(|page| &mut page.actions) {
        let (field, prefix, mime) = match action["type"].as_str() {
            Some("audio_clip") => ("audioAssetId", "music-", "audio/"),
            Some("video_clip") => ("videoAssetId", "video-", "video/"),
            _ => continue,
        };
        let id = action[field].as_str().ok_or_else(|| rpc_err(1002, "Native clip asset missing", "COURSEWARE_INVALID"))?;
        let asset = p.assets.iter().find(|a| a.asset.id == id && a.asset.mime_type.starts_with(mime))
            .ok_or_else(|| rpc_err(1002, "Native clip asset type changed", "COURSEWARE_INVALID"))?;
        aliases.insert(id.to_owned(), format!("{prefix}{}", asset.asset.sha256));
        // Measured duration remains in the verified media payload, not the fixed action envelope.
        action.as_object_mut().unwrap().remove("durationMs");
    }
    for action in p.project.pages.iter_mut().flat_map(|page| &mut page.actions) {
        for field in ["audioAssetId", "videoAssetId"] {
            if let Some(id) = action[field].as_str().and_then(|id| aliases.get(id)) { action[field] = json!(id); }
        }
    }
    for asset in &mut p.assets {
        if let Some(id) = aliases.get(&asset.asset.id) { asset.asset.id = id.clone(); }
    }
    let mut unique = std::collections::HashMap::new();
    for input in &p.assets {
        let value = (input.asset.sha256.clone(), input.asset.mime_type.clone());
        if unique.insert(input.asset.id.clone(), value.clone()).is_some_and(|previous| previous != value) {
            return Err(rpc_err(1002, "Native media aliases conflict", "COURSEWARE_INVALID"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    p.assets.retain(|asset| seen.insert(asset.asset.id.clone()));
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
            mapped.push(json!({"objectId": native_object_id(object, bound)?, "importElementId": object["importElementId"]}));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inherited_artwork_retains_parser_identity_without_binding_to_slide_shapes() {
        let bound = vec![json!({"sourceShapeId":"7", "logicalId":"native-title"})];
        for kind in ["layout", "master"] {
            let object = json!({"importElementId":format!("pptx_fallback_{kind}_shape_7"), "logicalId":"object:parsed"});
            assert_eq!(native_object_id(&object, &bound).unwrap(), json!("inherited-parsed"));
        }
        assert_eq!(native_object_id(&json!({"sourceShapeId":"7"}), &bound).unwrap(), json!("native-title"));
        assert!(native_object_id(&json!({"importElementId":"unidentified_slide_shape", "logicalId":"object:parsed"}), &bound).is_err());
        assert!(native_object_id(&json!({"sourceShapeId":"missing"}), &bound).is_err());
        assert!(native_object_id(&json!({"sourceShapeId":"7"}), &[bound[0].clone(), bound[0].clone()]).is_err());
    }
}
