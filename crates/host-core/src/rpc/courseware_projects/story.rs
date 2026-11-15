use super::*;
use sha2::{Digest, Sha256};

const NAMESPACE: &str = "coursewareStories.v1";
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Character {
    name: String,
    description: String,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Assessment {
    kind: String,
    question: String,
    reference_answer: String,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Beat {
    id: String,
    title: String,
    event: String,
    objective: String,
    activity: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::db::courseware_projects::present_option"
    )]
    assessment: Option<Assessment>,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Story {
    title: String,
    summary: String,
    setting: String,
    objectives: Vec<String>,
    characters: Vec<Character>,
    beats: Vec<Beat>,
    assumptions: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::db::courseware_projects::present_option"
    )]
    duration_minutes: Option<u32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::db::courseware_projects::present_option"
    )]
    body_page_limit: Option<u32>,
}
impl Story {
    fn valid(&self) -> bool {
        fn text(s: &str, max: usize) -> bool {
            !s.trim().is_empty() && s.encode_utf16().count() <= max
        }
        fn strings(v: &[String], min: usize, max: usize, length: usize) -> bool {
            (min..=max).contains(&v.len())
                && v.iter().all(|s| text(s, length))
                && v.iter().collect::<std::collections::HashSet<_>>().len() == v.len()
        }
        text(&self.title, 200)
            && text(&self.summary, 3000)
            && text(&self.setting, 1500)
            && strings(&self.objectives, 1, 20, 500)
            && strings(&self.assumptions, 0, 20, 500)
            && self.characters.len() <= 20
            && self
                .characters
                .iter()
                .all(|c| text(&c.name, 100) && text(&c.description, 1000))
            && (1..=30).contains(&self.beats.len())
            && self
                .beats
                .iter()
                .map(|b| &b.id)
                .collect::<std::collections::HashSet<_>>()
                .len()
                == self.beats.len()
            && self.beats.iter().all(|b| {
                !b.id.is_empty()
                    && b.id.len() <= 64
                    && b.id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
                    && text(&b.title, 200)
                    && text(&b.event, 3000)
                    && text(&b.activity, 2000)
                    && self.objectives.contains(&b.objective)
                    && b.assessment.as_ref().is_none_or(|a| {
                        matches!(a.kind.as_str(), "quiz" | "checkpoint")
                            && text(&a.question, 1000)
                            && text(&a.reference_answer, 2000)
                    })
            })
            && self.duration_minutes.is_none_or(|n| (1..=240).contains(&n))
            && self.body_page_limit.is_none_or(|n| (1..=30).contains(&n))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Save {
    session_id: String,
    expected_revision: u64,
    story: Story,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Decision {
    session_id: String,
    expected_revision: u64,
    sha256: Option<String>,
    action: String,
}
fn conflict(message: &str) -> JsonRpcError {
    rpc_err(1008, message, "COURSEWARE_STORY_CONFLICT")
}
fn store(state: &AppState, namespace: &str, key: &str, value: &Value) -> Result<(), JsonRpcError> {
    state.db.kv_set(namespace, key, value).map_err(error)?;
    if state.db.kv_get(namespace, key).map_err(error)?.as_ref() != Some(value) {
        return Err(rpc_err(1000, "Story state was not stored", "INTERNAL"));
    }
    Ok(())
}
fn authors_files(name: &str) -> bool {
    matches!(name, "Bash" | "Write" | "Edit" | "GenerateImages")
}
fn initial() -> Value {
    json!({"schemaVersion":1,"revision":0,"draft":null,"sha256":null,"approvedSha256":null,"educationContext":null,"bound":false})
}
fn task(state: &AppState, session_id: &str) -> Result<(String, Value), JsonRpcError> {
    let root = project_workspace(state, session_id)?;
    let task = state
        .db
        .kv_get(TASK_NAMESPACE, session_id)
        .map_err(error)?
        .ok_or_else(|| conflict("Select a new courseware task first"))?;
    Ok((root, task))
}
fn attached(task: &Value) -> bool {
    ["generatedPath", "canonicalProjectId", "importPath"]
        .iter()
        .any(|k| task.get(k).is_some())
}
fn same_story_requirements(saved: &Value, current: &Value) -> bool {
    let content_settings = |value: &Value| {
        let mut settings = value.as_object().cloned().unwrap_or_default();
        // Pagination and illustration style belong to later production, not story review.
        settings.remove("bodyPageLimit");
        settings.remove("visualStyle");
        settings
    };
    content_settings(saved) == content_settings(current)
}
pub(super) fn read(state: &AppState, session_id: &str) -> Result<Option<Value>, JsonRpcError> {
    let (root, task) = task(state, session_id)?;
    if task["storyFirst"] != true {
        return Ok(None);
    }
    let mut story = state
        .db
        .kv_get(NAMESPACE, &scene_plan::key(&root, session_id)?)
        .map_err(error)?
        .unwrap_or_else(initial);
    if !same_story_requirements(&story["educationContext"], &task["educationContext"]) {
        story["approvedSha256"] = Value::Null;
    }
    Ok(Some(story))
}
fn ready(story: &Value) -> bool {
    story["sha256"].is_string() && story["sha256"] == story["approvedSha256"]
}
pub(super) fn bind(
    state: &AppState,
    session_id: &str,
    hash: Option<&str>,
) -> Result<(), JsonRpcError> {
    let Some(mut story) = read(state, session_id)? else {
        return if hash.is_some() {
            Err(conflict("Story binding does not belong to this task"))
        } else {
            Ok(())
        };
    };
    let (root, task) = task(state, session_id)?;
    if !ready(&story)
        || !same_story_requirements(&story["educationContext"], &task["educationContext"])
        || hash != story["sha256"].as_str()
    {
        return Err(conflict(
            "Review the current story and regenerate this plan from its approved version",
        ));
    }
    if story["bound"] != true {
        story["bound"] = json!(true);
        store(
            state,
            NAMESPACE,
            &scene_plan::key(&root, session_id)?,
            &story,
        )?;
    }
    Ok(())
}
// Called before any tool side effect, including generic shell and file tools.
pub(crate) fn guard_tool(
    state: &AppState,
    session_id: &str,
    name: &str,
) -> Result<(), JsonRpcError> {
    if !state
        .db
        .kv_get(TASK_NAMESPACE, session_id)
        .map_err(error)?
        .is_some_and(|task| task["storyFirst"] == true)
    {
        return Ok(());
    }
    let Some(story) = read(state, session_id)? else {
        return Ok(());
    };
    if !ready(&story) {
        if !matches!(
            name,
            "ToolSearch"
                | "Read"
                | "Glob"
                | "Grep"
                | "asktool"
                | "AskUserQuestion"
                | "TodoWrite"
                | "courseware_workflow_get"
                | "courseware_story_begin"
                | "courseware_story_save"
                | "courseware_requirements_update"
        ) {
            return Err(conflict("The teaching story awaits user approval; only story planning and reading are available"));
        }
    } else {
        let (_, task) = task(state, session_id)?;
        if !same_story_requirements(&story["educationContext"], &task["educationContext"]) {
            return Err(conflict(
                "Teaching requirements changed; revise and approve the story again",
            ));
        }
    }
    Ok(())
}
// Recheck after permission/capacity waits; denied calls never lock the story.
pub(crate) fn admit_tool(
    state: &AppState,
    session_id: &str,
    name: &str,
) -> Result<(), JsonRpcError> {
    guard_tool(state, session_id, name)?;
    if authors_files(name)
        && state
            .db
            .kv_get(TASK_NAMESPACE, session_id)
            .map_err(error)?
            .is_some_and(|task| task["storyFirst"] == true)
    {
        if let Some(story) = read(state, session_id)? {
            let (_, task) = task(state, session_id)?;
            if task["taskType"] == "plain" {
                bind(state, session_id, story["sha256"].as_str())?;
            }
        }
    }
    Ok(())
}
pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let invalid = |e: serde_json::Error| rpc_err(1002, e.to_string(), "INVALID_PARAMS");
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| conflict("Missing story session"))?
        .to_owned();
    let state = state.lock().await;
    let (root, mut task) = task(&state, &session_id)?;
    let key = scene_plan::key(&root, &session_id)?;
    if method == "courseware.story.get" {
        let _: TaskGetParams = serde_json::from_value(params).map_err(invalid)?;
        return Ok(json!({"story":read(&state,&session_id)?}));
    }
    if !matches!(task["taskType"].as_str(), Some("plain" | "scene")) || attached(&task) {
        return Err(conflict(
            "Stories are available only for new ordinary or scene tasks",
        ));
    }
    if method == "courseware.story.begin" {
        let _: TaskGetParams = serde_json::from_value(params).map_err(invalid)?;
        if task["storyFirst"] == true {
            return Ok(json!({"story":read(&state,&session_id)?}));
        }
        if scene_plan::has_approval(&state, &root, &session_id)? {
            return Err(conflict(
                "A scene plan is already approved; start a new story task",
            ));
        }
        let session = sessions::get_session(&state.db, &session_id)
            .map_err(error)?
            .ok_or_else(|| conflict("Story session no longer exists"))?;
        if session.messages.iter().any(|message| {
            message.role == "tool" && message.tool_name.as_deref().is_some_and(authors_files)
        }) {
            return Err(conflict(
                "Authoring already started; retain it and create a new story task",
            ));
        }
        let tx = state
            .db
            .conn()
            .unchecked_transaction()
            .map_err(|e| error(e.into()))?;
        store(&state, NAMESPACE, &key, &initial())?;
        task["storyFirst"] = json!(true);
        store(&state, TASK_NAMESPACE, &session_id, &task)?;
        tx.commit().map_err(|e| error(e.into()))?;
        return Ok(json!({"story":initial()}));
    }
    let mut current =
        read(&state, &session_id)?.ok_or_else(|| conflict("Enable story planning first"))?;
    if method == "courseware.story.save" {
        let p: Save = serde_json::from_value(params).map_err(invalid)?;
        if p.session_id != session_id
            || !p.story.valid()
            || serde_json::to_vec(&p.story).map_err(invalid)?.len() > 65536
        {
            return Err(conflict("Invalid teaching story"));
        }
        let draft = serde_json::to_value(p.story).map_err(invalid)?;
        // Lost save replies can be retried without advancing the version twice.
        if current["draft"] == draft
            && same_story_requirements(&current["educationContext"], &task["educationContext"])
            && current["revision"].as_u64() == p.expected_revision.checked_add(1)
        {
            return Ok(json!({"story":current}));
        }
        if current["bound"] == true || scene_plan::has_approval(&state, &root, &session_id)? {
            return Err(conflict(
                "Courseware production already started; retain it and create a new story task",
            ));
        }
        if current["revision"].as_u64() != Some(p.expected_revision) {
            return Err(conflict("Story changed; reread before saving"));
        }
        let hash = hex::encode(Sha256::digest(
            serde_json::to_vec(&json!({"draft":draft,"educationContext":task["educationContext"]}))
                .map_err(invalid)?,
        ));
        current = json!({"schemaVersion":1,"revision":p.expected_revision.checked_add(1).ok_or_else(||conflict("Story revision exhausted"))?,
            "draft":draft,"sha256":hash,"approvedSha256":null,"educationContext":task["educationContext"],"bound":false});
    } else if method == "courseware.story.decide" {
        let p: Decision = serde_json::from_value(params).map_err(invalid)?;
        if p.session_id != session_id
            || current["revision"].as_u64() != Some(p.expected_revision)
            || current["sha256"].as_str() != p.sha256.as_deref()
        {
            return Err(conflict("Story changed; review the latest version"));
        }
        match p.action.as_str() {
            "approve"
                if !same_story_requirements(
                    &current["educationContext"],
                    &task["educationContext"],
                ) =>
            {
                return Err(conflict(
                    "Teaching requirements changed; update the saved story in Chat before confirming it",
                ))
            }
            "approve"
                if current["draft"].is_object()
                    && same_story_requirements(
                        &current["educationContext"],
                        &task["educationContext"],
                    ) =>
            {
                current["approvedSha256"] = current["sha256"].clone()
            }
            "disable"
                if current["bound"] != true
                    && !scene_plan::has_approval(&state, &root, &session_id)? =>
            {
                task.as_object_mut()
                    .ok_or_else(|| conflict("Invalid task"))?
                    .remove("storyFirst");
                store(&state, TASK_NAMESPACE, &session_id, &task)?;
                return Ok(json!({"story":null}));
            }
            _ => {
                return Err(conflict(
                    "Story cannot be confirmed or disabled at this stage",
                ))
            }
        }
    } else {
        return Err(conflict("Unknown story operation"));
    }
    store(&state, NAMESPACE, &key, &current)?;
    Ok(json!({"story":current}))
}

#[cfg(test)]
mod tests;
