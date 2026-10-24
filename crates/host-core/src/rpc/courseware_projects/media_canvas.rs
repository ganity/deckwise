use super::*;

mod tasks;
mod music;

const NAMESPACE: &str = "coursewareMediaCanvas.v1";
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    asset_id: String,
    revision: String,
    label: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Draft {
    id: String,
    revision: u64,
    kind: String,
    title: String,
    prompt: String,
    references: Vec<Reference>,
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Viewport {
    x: f64,
    y: f64,
    zoom: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    version: u8,
    project_id: String,
    revision: u64,
    viewport: Viewport,
    drafts: Vec<Draft>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    revision: String,
    document: Document,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadParams {
    session_id: String,
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetParams {
    session_id: String,
    project_id: String,
    expected_revision: Option<String>,
    document: Document,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Patch {
    title: Option<String>,
    prompt: Option<String>,
    references: Option<Vec<Reference>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditParams {
    session_id: String,
    project_id: String,
    expected_revision: String,
    draft_id: String,
    expected_draft_revision: u64,
    patch: Patch,
}

fn invalid(message: &str) -> JsonRpcError {
    rpc_err(1002, message, "COURSEWARE_INVALID")
}

fn conflict() -> JsonRpcError {
    rpc_err(1008, "Media draft changed; reload before editing", "COURSEWARE_CONFLICT")
}

fn validate(document: &Document, project_id: &str) -> Result<(), JsonRpcError> {
    let text = |value: &str, max: usize| !value.trim().is_empty() && value.encode_utf16().count() <= max;
    let coordinate = |value: f64| value.is_finite() && value.abs() <= 100_000.0;
    let mut ids = std::collections::HashSet::new();
    if document.version != 1
        || document.project_id != project_id
        || !text(project_id, 512)
        || document.revision > MAX_SAFE_INTEGER
        || !coordinate(document.viewport.x)
        || !coordinate(document.viewport.y)
        || !document.viewport.zoom.is_finite()
        || !(0.2..=3.0).contains(&document.viewport.zoom)
        || document.drafts.len() > 100
        || document.drafts.iter().any(|draft| {
            let mut references = std::collections::HashSet::new();
            !text(&draft.id, 160)
                || !ids.insert(&draft.id)
                || draft.revision > MAX_SAFE_INTEGER
                || !["image", "video", "music", "sound"].contains(&draft.kind.as_str())
                || !text(&draft.title, 160)
                || draft.prompt.encode_utf16().count() > 16_000
                || !coordinate(draft.x)
                || !coordinate(draft.y)
                || draft.references.len() > 16
                || draft.references.iter().any(|reference| {
                    !text(&reference.asset_id, 512)
                        || !text(&reference.revision, 512)
                        || !text(&reference.label, 512)
                        || !references.insert(&reference.asset_id)
                })
        })
        || serde_json::to_vec(document).map_err(|_| invalid("Invalid canvas"))?.len() > 2 * 1024 * 1024
    {
        return Err(invalid("Invalid media canvas document"));
    }
    Ok(())
}

fn load(state: &AppState, key: &str, project_id: &str) -> Result<Option<Stored>, JsonRpcError> {
    let stored = state.db.kv_get(NAMESPACE, key).map_err(error)?;
    let stored: Option<Stored> = stored.map(serde_json::from_value).transpose()
        .map_err(|_| invalid("Invalid saved media canvas"))?;
    if let Some(stored) = &stored {
        if stored.revision.trim().is_empty() { return Err(invalid("Invalid stored canvas revision")); }
        validate(&stored.document, project_id)?;
    }
    Ok(stored)
}

pub(super) async fn handle(state: Arc<Mutex<AppState>>, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    if method.starts_with("courseware.mediaCanvas.music.") {
        return music::handle(state, method, params).await;
    }
    if method.starts_with("courseware.mediaCanvas.image.") {
        return tasks::handle(state, method, params).await;
    }
    let parse_error = |e: serde_json::Error| invalid(&e.to_string());
    let (scope, expected, replacement, edit) = match method {
        "courseware.mediaCanvas.get" => (serde_json::from_value::<ReadParams>(params).map_err(parse_error)?, None, None, None),
        "courseware.mediaCanvas.set" => {
            if !params.as_object().is_some_and(|params| params.contains_key("expectedRevision")) {
                return Err(invalid("expectedRevision is required"));
            }
            let p: SetParams = serde_json::from_value(params).map_err(parse_error)?;
            (ReadParams { session_id: p.session_id, project_id: p.project_id }, Some(p.expected_revision), Some(p.document), None)
        }
        "courseware.mediaCanvas.editDraft" => {
            if !params.get("patch").and_then(Value::as_object).is_some_and(|patch| !patch.is_empty() && patch.values().all(|value| !value.is_null())) {
                return Err(invalid("A nonempty draft patch is required"));
            }
            let p: EditParams = serde_json::from_value(params).map_err(parse_error)?;
            (ReadParams { session_id: p.session_id.clone(), project_id: p.project_id.clone() }, Some(Some(p.expected_revision.clone())), None, Some(p))
        }
        _ => return Err(invalid("Unsupported media canvas method")),
    };
    let state = state.lock().await;
    let root = project_workspace(&state, &scope.session_id)?;
    if scope.project_id != format!("canvas:{}", scope.session_id) {
        return Err(invalid("Canvas must belong to its courseware conversation"));
    }
    let task = state.db.kv_get(TASK_NAMESPACE, &scope.session_id).map_err(error)?;
    if !task.as_ref().and_then(|task| task["taskType"].as_str()).is_some_and(|kind| ["plain", "scene", "import"].contains(&kind)) {
        return Err(invalid("Select a courseware task before using the canvas"));
    }
    if expected.is_some() && crate::sessions::session_mode(&state.db, &scope.session_id).map_err(error)?.as_deref() != Some("agent") {
        return Err(rpc_err(1003, "Media canvas edits require Agent mode", "PERMISSION_DENIED"));
    }
    let root = std::fs::canonicalize(root).map_err(|e| error(e.into()))?;
    let key = serde_json::to_string(&(&root, &scope.session_id, &scope.project_id)).map_err(parse_error)?;
    let stored = load(&state, &key, &scope.project_id)?;
    let Some(expected) = expected else {
        return Ok(stored.map_or_else(|| json!({ "revision": null, "document": null }), |stored| json!(stored)));
    };
    if stored.as_ref().map(|stored| &stored.revision) != expected.as_ref() { return Err(conflict()); }
    let document = if let Some(edit) = edit {
        let mut document = stored.as_ref().ok_or_else(conflict)?.document.clone();
        let draft = document.drafts.iter_mut().find(|draft| draft.id == edit.draft_id).ok_or_else(conflict)?;
        if draft.revision != edit.expected_draft_revision { return Err(conflict()); }
        if let Some(title) = edit.patch.title { draft.title = title; }
        if let Some(prompt) = edit.patch.prompt { draft.prompt = prompt; }
        if let Some(references) = edit.patch.references { draft.references = references; }
        draft.revision += 1;
        document.revision += 1;
        document
    } else { replacement.ok_or_else(|| invalid("Canvas document is required"))? };
    validate(&document, &scope.project_id)?;
    let minimum_revision = stored.as_ref().map_or(0, |stored| stored.document.revision + 1);
    if document.revision < minimum_revision { return Err(conflict()); }
    if let Some(stored) = &stored {
        for draft in &document.drafts {
            if let Some(previous) = stored.document.drafts.iter().find(|previous| previous.id == draft.id) {
                let content_changed = previous.kind != draft.kind || previous.title != draft.title || previous.prompt != draft.prompt ||
                    serde_json::to_value(&previous.references).map_err(parse_error)? != serde_json::to_value(&draft.references).map_err(parse_error)?;
                if draft.kind != previous.kind || draft.revision < previous.revision || (content_changed && draft.revision == previous.revision) { return Err(conflict()); }
            }
        }
    }
    let next = json!({ "revision": uuid::Uuid::new_v4().to_string(), "document": document });
    state.db.kv_set(NAMESPACE, &key, &next).map_err(error)?;
    if state.db.kv_get(NAMESPACE, &key).map_err(error)?.as_ref() != Some(&next) {
        return Err(rpc_err(1000, "Media canvas was not stored", "INTERNAL"));
    }
    Ok(next)
}

#[cfg(test)]
mod tests;
