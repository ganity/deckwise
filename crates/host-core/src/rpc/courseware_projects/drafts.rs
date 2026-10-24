use super::*;
use crate::db::courseware_projects::CoursewareProject;

const NAMESPACE: &str = "coursewareTeachingDrafts.v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    session_id: String,
    project_id: String,
    page_id: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Content {
    baseline: CoursewareProject,
    actions: Vec<Value>,
    instruction: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetParams {
    session_id: String,
    project_id: String,
    page_id: String,
    expected_revision: Option<String>,
    draft: Option<Content>,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let invalid = |e: serde_json::Error| rpc_err(1002, e.to_string(), "INVALID_PARAMS");
    let changing = method == "courseware.teachingDraft.set";
    let (p, change) = if changing {
        if !params
            .as_object()
            .is_some_and(|p| p.contains_key("expectedRevision") && p.contains_key("draft"))
        {
            return Err(rpc_err(
                1002,
                "Draft and expectedRevision are required",
                "INVALID_PARAMS",
            ));
        }
        let p: SetParams = serde_json::from_value(params).map_err(invalid)?;
        (
            Params {
                session_id: p.session_id,
                project_id: p.project_id,
                page_id: p.page_id,
            },
            Some((p.expected_revision, p.draft)),
        )
    } else {
        (
            serde_json::from_value::<Params>(params).map_err(invalid)?,
            None,
        )
    };
    let state = state.lock().await;
    let root = project_workspace(&state, &p.session_id)?;
    let project = state
        .db
        .get_courseware_project(&root, &p.project_id)
        .map_err(error)?
        .ok_or_else(|| {
            rpc_err(
                1007,
                "Courseware project is missing",
                "COURSEWARE_NOT_FOUND",
            )
        })?;
    let page = project
        .pages
        .iter()
        .find(|page| page.page_id == p.page_id)
        .ok_or_else(|| {
            rpc_err(
                1007,
                "Courseware page is missing",
                "COURSEWARE_PAGE_NOT_FOUND",
            )
        })?;
    let key = serde_json::to_string(&(&root, &p.session_id, &p.project_id, &p.page_id))
        .map_err(invalid)?;
    let current = state.db.kv_get(NAMESPACE, &key).map_err(error)?;
    let Some((expected, content)) = change else {
        return Ok(json!({ "draft": current }));
    };
    let revision = current
        .as_ref()
        .and_then(|draft| draft.get("revision"))
        .and_then(Value::as_str);
    if current.is_some() && revision.is_none() {
        return Err(rpc_err(
            1002,
            "Invalid stored draft revision",
            "COURSEWARE_INVALID",
        ));
    }
    if revision != expected.as_deref() {
        return Err(rpc_err(
            1008,
            "Local draft changed; reload before replacing it",
            "COURSEWARE_CONFLICT",
        ));
    }
    let Some(content) = content else {
        state.db.kv_delete(NAMESPACE, &key).map_err(error)?;
        if state.db.kv_get(NAMESPACE, &key).map_err(error)?.is_some() {
            return Err(rpc_err(1000, "Local draft was not cleared", "INTERNAL"));
        }
        return Ok(json!({ "draft": null }));
    };
    state.db.ensure_no_source_adoption(&root).map_err(error)?;
    if serde_json::to_value(&content.baseline).map_err(invalid)?
        != serde_json::to_value(&project).map_err(invalid)?
        || page.locked
    {
        return Err(rpc_err(
            1008,
            "Teaching changed; the existing local draft is retained",
            "COURSEWARE_CONFLICT",
        ));
    }
    let mut ids = std::collections::HashSet::new();
    if content.instruction.encode_utf16().count() > 4000
        || content.actions.len() > 1000
        || serde_json::to_vec(&content).map_err(invalid)?.len() > 2 * 1024 * 1024
        || content.actions.iter().any(|action| {
            let id = action.get("id").and_then(Value::as_str).unwrap_or("");
            let kind = action.get("type").and_then(Value::as_str).unwrap_or("");
            let valid_id = |value: &str| {
                !value.is_empty()
                    && value.len() <= 128
                    && value
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            };
            !action.is_object()
                || !valid_id(id)
                || !valid_id(kind)
                || !ids.insert(id)
                || (action["type"] == "speech"
                    && action.get("text").and_then(Value::as_str).is_none())
        })
    {
        return Err(rpc_err(
            1002,
            "Invalid local teaching draft",
            "COURSEWARE_INVALID",
        ));
    }
    let next = json!({ "revision": uuid::Uuid::new_v4().to_string(), "baseline": content.baseline,
        "pageId": p.page_id, "actions": content.actions, "instruction": content.instruction });
    state.db.kv_set(NAMESPACE, &key, &next).map_err(error)?;
    if state.db.kv_get(NAMESPACE, &key).map_err(error)?.as_ref() != Some(&next) {
        return Err(rpc_err(1000, "Local draft was not stored", "INTERNAL"));
    }
    Ok(json!({ "draft": next }))
}
