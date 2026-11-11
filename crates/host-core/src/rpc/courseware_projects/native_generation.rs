use super::*;
use crate::db::courseware_projects::{CoursewareProject, scene_teaching::Teaching};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Presentation {
    path: String,
    source_sha256: String,
    pages: Vec<presentation::Page>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attach {
    session_id: String,
    job_id: String,
    path: String,
    project: CoursewareProject,
    identity: Value,
    scene_proof: Option<scene_images::GenerationProof>,
    scene_mapping: Option<crate::db::courseware_projects::scene_objects::GeneratedSceneMapping>,
    presentation: Option<Presentation>,
}

// Generation attaches a verified source, never an editable database teaching mirror.
pub(super) async fn handle(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let p: Attach = serde_json::from_value(params).map_err(|e| invalid(e.to_string()))?;
    p.project.validate().map_err(error)?;
    let state = state.lock().await;
    let root = workspace(&state, &p.session_id)?;
    let mut task = state.db.kv_get(TASK_NAMESPACE, &p.session_id).map_err(error)?
        .ok_or_else(|| rpc_err(1002, "Select a generation task first", "COURSEWARE_INVALID"))?;
    let task_type = if p.presentation.is_some() { "plain" } else { "scene" };
    if task["taskType"] != task_type || p.project.task_type != task_type || task.get("importPath").is_some()
        || task.get("canonicalProjectId").is_some()
        || sessions::session_mode(&state.db, &p.session_id).map_err(error)?.as_deref() != Some("agent") {
        return Err(rpc_err(1008, "Native generation owner changed", "COURSEWARE_CONFLICT"));
    }
    if serde_json::to_value(&p.project.education_context).map_err(|e| error(e.into()))? != task.get("educationContext").cloned().unwrap_or(Value::Null) {
        return Err(rpc_err(1008, "Native generation education requirements changed", "COURSEWARE_CONFLICT"));
    }
    let allowed = std::fs::canonicalize(Path::new(&root).join(".deckwise-ppt/generated")).map_err(|e| error(e.into()))?;
    let path = std::fs::canonicalize(&p.path).map_err(|e| error(e.into()))?;
    let expected_name = format!("{}.pptx", p.project.source.sha256);
    if !allowed.starts_with(Path::new(&root)) || path.parent() != Some(allowed.as_path()) || !path.is_file()
        || path.file_name().and_then(|n| n.to_str()) != Some(&expected_name)
        || !(1..=50 * 1024 * 1024).contains(&std::fs::metadata(&path).map_err(|e| error(e.into()))?.len())
        || hex::encode(Sha256::digest(std::fs::read(&path).map_err(|e| error(e.into()))?)) != p.project.source.sha256 {
        return Err(rpc_err(1008, "Native generated source changed", "COURSEWARE_CONFLICT"));
    }
    let seed = state.courseware.saved_project_seed(&p.job_id, Path::new(&root)).map_err(error)?;
    if seed.sha256 != p.project.source.sha256 || seed.pages != p.project.pages.len() {
        return Err(rpc_err(1008, "Native generated parser identity changed", "COURSEWARE_CONFLICT"));
    }
    verify_identity(&p.project, &p.identity, seed.identity.as_ref().map(|v| v.value())).map_err(error)?;
    // An uncertain reply may be replayed even after approval has left the generation state.
    if let Some(existing) = task.get("generatedPath") {
        if existing != &json!(path.to_string_lossy()) || task["nativeDocumentId"] != p.project.project_id {
            return Err(rpc_err(1008, "Generation already adopted another source", "COURSEWARE_CONFLICT"));
        }
        return Ok(json!({"task":task}));
    }
    if let Some(original) = &p.presentation {
        if p.scene_proof.is_some() || p.scene_mapping.is_some() || original.pages.len() != seed.pages {
            return Err(rpc_err(1002, "Invalid native presentation proof", "COURSEWARE_INVALID"));
        }
        presentation::verify_export(&root, &original.path, &original.source_sha256, seed.pages).map_err(error)?;
        let body_limit = task["educationContext"]["bodyPageLimit"].as_u64().unwrap_or(100) as usize;
        if original.pages.iter().filter(|v| v.quiz.is_none() && v.teaching.question.is_none()).count() > body_limit {
            return Err(rpc_err(1002, "Presentation exceeds saved body page limit", "COURSEWARE_INVALID"));
        }
        for (index, (page, planned)) in p.project.pages.iter().zip(&original.pages).enumerate() {
            if planned.page_number != index + 1 { return Err(invalid("Presentation page order changed")); }
            verify_teaching(page, Some(&planned.teaching), planned.quiz.as_ref(), None).map_err(error)?;
        }
        task["presentationPlanSha256"] = json!(hex::encode(Sha256::digest(serde_json::to_vec(&original.pages).map_err(|e| error(e.into()))?)));
    } else if let Some(proof) = &p.scene_proof {
        let plan = scene_images::verify_generation(&state, &root, &p.session_id, proof)?;
        let mapping = p.scene_mapping.as_ref().ok_or_else(|| invalid("Generated scene mapping missing"))?;
        if plan.title != p.project.title || plan.pages.len() != seed.pages || mapping.pages.len() != seed.pages {
            return Err(rpc_err(1008, "Generated scene plan changed", "COURSEWARE_CONFLICT"));
        }
        for (index, ((page, planned), mapped)) in p.project.pages.iter().zip(&plan.pages).zip(&mapping.pages).enumerate() {
            if mapped.slide_id != format!("scene-{:03}", index + 1) || mapped.source_hash != planned.source_hash()? {
                return Err(rpc_err(1008, "Generated scene object mapping changed", "COURSEWARE_CONFLICT"));
            }
            verify_teaching(page, planned.teaching.as_ref(), planned.quiz.as_ref(), Some(&planned.narration)).map_err(error)?;
        }
        mapping.validate_source(seed.identity.as_ref().ok_or_else(|| invalid("Parsed scene identity missing"))?).map_err(error)?;
    } else if scene_plan::has_approval(&state, &root, &p.session_id)? {
        return Err(rpc_err(1008, "Reviewed scene inputs are required", "COURSEWARE_CONFLICT"));
    }
    task["generatedPath"] = json!(path.to_string_lossy());
    task["nativeDocumentId"] = json!(p.project.project_id);
    state.db.kv_set(TASK_NAMESPACE, &p.session_id, &task).map_err(error)?;
    Ok(json!({"task":task}))
}

fn invalid(message: impl Into<String>) -> JsonRpcError { rpc_err(1002, message, "COURSEWARE_INVALID") }

fn verify_identity(project: &CoursewareProject, identity: &Value, parsed: Option<&Value>) -> anyhow::Result<()> {
    let native = identity["pages"].as_array().ok_or_else(|| anyhow::anyhow!("Native identities missing"))?;
    let parsed = parsed.and_then(|v| v["pages"].as_array()).ok_or_else(|| anyhow::anyhow!("Parsed identities missing"))?;
    anyhow::ensure!(native.len() == project.pages.len() && parsed.len() == native.len(), "Native page count changed");
    let mut ids = HashSet::new();
    for ((page, native), parsed) in project.pages.iter().zip(native).zip(parsed) {
        anyhow::ensure!(native["pageId"] == page.page_id, "Native page identity changed");
        let objects = native["objects"].as_array().ok_or_else(|| anyhow::anyhow!("Native objects missing"))?;
        for object in objects {
            let id = object["logicalId"].as_str().unwrap_or_default();
            anyhow::ensure!(!id.is_empty() && ids.insert(id), "Duplicate native identity");
        }
        for source in parsed["objects"].as_array().ok_or_else(|| anyhow::anyhow!("Parsed objects missing"))? {
            anyhow::ensure!(objects.iter().filter(|o| o["sourceShapeId"] == source["sourceShapeId"]).count() == 1, "Generated object binding differs from source");
        }
    }
    Ok(())
}

fn verify_teaching(page: &crate::db::courseware_projects::CoursewarePage, teaching: Option<&Teaching>, quiz: Option<&Value>, narration: Option<&str>) -> anyhow::Result<()> {
    anyhow::ensure!(teaching.is_none_or(|t| t.valid()), "Invalid generated requirements");
    let checkpoints: Vec<_> = page.actions.iter().filter(|a| a["type"] == "interaction_checkpoint").collect();
    let speeches: Vec<_> = page.actions.iter().filter(|a| a["type"] == "speech").collect();
    for (kind, planned) in [
        ("music_slot", teaching.and_then(|t| t.music.as_ref())),
        ("video_slot", teaching.and_then(|t| t.video.as_ref())),
    ] {
        let slots: Vec<_> = page.actions.iter().filter(|a| a["type"] == kind).collect();
        anyhow::ensure!(slots.len() == usize::from(planned.is_some()), "Generated media requirement differs from plan");
        if let Some(planned) = planned {
            anyhow::ensure!(slots[0]["prompt"] == planned.prompt && (kind != "music_slot" || slots[0]["title"] == planned.purpose), "Generated media prompt differs from plan");
        }
    }
    if let Some(quiz) = quiz {
        let questions = quiz["questions"].as_array().ok_or_else(|| anyhow::anyhow!("Quiz questions missing"))?;
        anyhow::ensure!(questions.len() == 1 && checkpoints.len() == 1 && speeches.len() == 1, "Quiz page is incomplete");
        let q = &questions[0];
        let options = q["options"].as_array().cloned().unwrap_or_default();
        let answers = q["answer"].as_array().cloned().unwrap_or_default();
        let indices: Vec<_> = options.iter().enumerate().filter(|(_, o)| answers.contains(&o["value"])).map(|(i, _)| i).collect();
        anyhow::ensure!(checkpoints[0]["question"] == q["question"] && checkpoints[0]["response"]["kind"] == q["type"]
            && checkpoints[0]["response"]["options"] == json!(options.iter().map(|o| &o["label"]).collect::<Vec<_>>())
            && checkpoints[0]["response"]["answerIndices"] == json!(indices), "Quiz answer differs from plan");
        let summary = q["referenceAnswer"].as_str().map(str::to_owned).or_else(|| {
            if q["type"] == "short_answer" { Some(answers.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("；")) }
            else { q["analysis"].as_str().map(str::to_owned) }
        }).unwrap_or_default();
        anyhow::ensure!(checkpoints[0]["referenceAnswer"] == json!({"summary":summary,"keyPoints":q.get("keyPoints").cloned().unwrap_or(json!([]))}), "Quiz reference answer differs from plan");
    } else if let Some(question) = teaching.and_then(|t| t.question.as_ref()) {
        anyhow::ensure!(checkpoints.len() == 1 && checkpoints[0]["question"] == question.text
            && checkpoints[0]["response"] == serde_json::to_value(&question.response)?
            && speeches.len() == 1 && speeches[0]["text"] == question.text, "Interaction differs from plan");
        let reference = question.reference_answer.as_ref().map(serde_json::to_value).transpose()?.unwrap_or(json!({"summary":"","keyPoints":[]}));
        let context = [teaching.map(|t| t.objective.as_str()).unwrap_or_default(), question.constraint_prompt.as_deref().unwrap_or_default()]
            .into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n");
        anyhow::ensure!(checkpoints[0]["referenceAnswer"] == reference && checkpoints[0]["context"]["chapterSummary"] == context, "Interaction guidance differs from plan");
    } else if let Some(narration) = narration {
        // A body-page planning draft remains generation evidence until detailed narration is authored.
        anyhow::ensure!(checkpoints.is_empty() && (speeches.is_empty()
            || speeches.len() == 1 && speeches[0]["text"] == narration.trim()), "Generated narration differs from plan");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::courseware_projects::CoursewarePage;

    fn page(actions: Value) -> CoursewarePage {
        serde_json::from_value(json!({"pageId":"page-1","actions":actions,"locked":false,"reviewState":"review"})).unwrap()
    }

    #[test]
    fn scene_planning_narration_does_not_require_completed_speech() {
        let planned = "Look at the circle. A circle is round.";
        assert!(verify_teaching(&page(json!([])), None, None, Some(planned)).is_ok());
        assert!(verify_teaching(&page(json!([{"type":"speech","text":planned}])), None, None, Some(planned)).is_ok());
        assert!(verify_teaching(&page(json!([{"type":"speech","text":"An unrelated square."}])), None, None, Some(planned)).is_err());
        assert!(verify_teaching(&page(json!([{"type":"interaction_checkpoint"}])), None, None, Some(planned)).is_err());
    }

    #[test]
    fn generated_media_requirements_and_interaction_guidance_are_preserved() {
        let teaching: Teaching = serde_json::from_value(json!({
            "pageType":"interactive","phase":"practice","objective":"Greet a partner","durationSeconds":30,"requiredObjects":[],
            "question":{"text":"Say Hello","response":{"kind":"discussion","options":[],"answerIndices":[]},
                "referenceAnswer":{"summary":"Use Hello","keyPoints":["Hello"]},"constraintPrompt":"Wait for the teacher"},
            "music":{"purpose":"Opening","prompt":"Quiet instrumental"},"video":{"purpose":"Wave","prompt":"A friendly wave"}
        })).unwrap();
        let actions = json!([
            {"type":"speech","text":"Say Hello"},
            {"type":"interaction_checkpoint","question":"Say Hello","response":{"kind":"discussion","options":[],"answerIndices":[]},
                "referenceAnswer":{"summary":"Use Hello","keyPoints":["Hello"]},
                "context":{"chapterSummary":"Greet a partner\nWait for the teacher"}},
            {"type":"music_slot","title":"Opening","prompt":"Quiet instrumental"},
            {"type":"video_slot","prompt":"A friendly wave"}
        ]);
        assert!(verify_teaching(&page(actions.clone()), Some(&teaching), None, None).is_ok());
        for path in ["/1/referenceAnswer/summary", "/1/context/chapterSummary", "/2/prompt", "/3/prompt"] {
            let mut changed = actions.clone();
            *changed.pointer_mut(path).unwrap() = json!("changed");
            assert!(verify_teaching(&page(changed), Some(&teaching), None, None).is_err(), "{path}");
        }
        let mut missing = actions;
        missing.as_array_mut().unwrap().pop();
        assert!(verify_teaching(&page(missing), Some(&teaching), None, None).is_err());
    }

    #[test]
    fn generated_quiz_grading_and_body_narration_cannot_drift() {
        let quiz = json!({"questions":[{"type":"single","question":"Greeting?","options":[{"value":"A","label":"Bye"},{"value":"B","label":"Hello"}],"answer":["B"],"analysis":"Hello greets","keyPoints":["Hello"]}]});
        let actions = json!([
            {"type":"speech","text":"Greeting?\nA. Bye\nB. Hello"},
            {"type":"interaction_checkpoint","question":"Greeting?","response":{"kind":"single","options":["Bye","Hello"],"answerIndices":[1]},"referenceAnswer":{"summary":"Hello greets","keyPoints":["Hello"]}}
        ]);
        assert!(verify_teaching(&page(actions.clone()), None, Some(&quiz), None).is_ok());
        for (path, value) in [("/1/response/answerIndices", json!([0])), ("/1/referenceAnswer/keyPoints", json!([]))] {
            let mut changed = actions.clone(); *changed.pointer_mut(path).unwrap() = value;
            assert!(verify_teaching(&page(changed), None, Some(&quiz), None).is_err());
        }
        assert!(verify_teaching(&page(json!([{ "type":"speech","text":"Original" }])), None, None, Some("Original")).is_ok());
        assert!(verify_teaching(&page(json!([{ "type":"speech","text":"Changed" }])), None, None, Some("Original")).is_err());
    }
}
