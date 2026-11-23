use super::*;
use crate::db::courseware_projects::scene_teaching::Teaching;
use sha2::{Digest, Sha256};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Page {
    pub(super) page_number: usize,
    pub(super) teaching: Teaching,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) quiz: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Adopt {
    session_id: String,
    job_id: String,
    path: String,
    project_id: String,
    source_sha256: String,
    pages: Vec<Page>,
    classroom: Value,
}

pub(super) fn verify_export(
    root: &str,
    source: &str,
    sha256: &str,
    pages: usize,
) -> anyhow::Result<std::path::PathBuf> {
    let workspace = std::fs::canonicalize(root)?;
    let projects = std::fs::canonicalize(workspace.join(".deckwise-ppt/projects"))?;
    anyhow::ensure!(
        projects.starts_with(&workspace),
        "COURSEWARE_INVALID: project directory escapes workspace"
    );
    let path = std::fs::canonicalize(source)?;
    let exports = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("COURSEWARE_INVALID: export directory missing"))?;
    let project = exports
        .parent()
        .ok_or_else(|| anyhow::anyhow!("COURSEWARE_INVALID: project directory missing"))?;
    anyhow::ensure!(
        project.parent() == Some(projects.as_path())
            && exports.file_name().is_some_and(|n| n == "exports")
            && path.extension().is_some_and(|e| e == "pptx"),
        "COURSEWARE_INVALID: expected an official workspace presentation export"
    );
    anyhow::ensure!(
        (1..=50 * 1024 * 1024).contains(&std::fs::metadata(&path)?.len()),
        "COURSEWARE_INVALID: invalid presentation size"
    );
    let bytes = std::fs::read(&path)?;
    anyhow::ensure!(
        hex::encode(Sha256::digest(&bytes)) == sha256,
        "COURSEWARE_CONFLICT: presentation export bytes changed"
    );
    let mut files = vec![
        project.join("design_spec.md"),
        project.join("spec_lock.md"),
        project.join("notes/total.md"),
    ];
    let saved_plan = project.join("presentation-plan.json");
    if saved_plan.exists() {
        files.push(saved_plan);
    }
    let animations = project.join("animations.json");
    if animations.exists() {
        files.push(animations);
    }
    let mut svg_count = 0;
    for entry in std::fs::read_dir(project.join("svg_output"))? {
        let entry = entry?;
        if entry.path().extension().is_some_and(|e| e == "svg") {
            files.push(entry.path());
            svg_count += 1;
        }
    }
    anyhow::ensure!(
        svg_count == pages,
        "COURSEWARE_INVALID: SVG and exported teaching page counts differ"
    );
    let report_path = std::fs::canonicalize(project.join("validation/svg_quality_report.json"))?;
    anyhow::ensure!(
        report_path.starts_with(project)
            && std::fs::metadata(&report_path)?.len() <= 10 * 1024 * 1024,
        "COURSEWARE_INVALID: invalid presentation quality report"
    );
    let report: Value = serde_json::from_slice(&std::fs::read(&report_path)?)?;
    anyhow::ensure!(
        report["stage"] == "final" && report["summary"]["errors"] == 0,
        "COURSEWARE_INVALID: final presentation quality validation has not passed"
    );
    let report_time = std::fs::metadata(&report_path)?.modified()?;
    let export_time = std::fs::metadata(&path)?.modified()?;
    for file in files {
        let real = std::fs::canonicalize(&file)?;
        let metadata = std::fs::metadata(&real)?;
        anyhow::ensure!(
            real.starts_with(project) && metadata.is_file() && metadata.len() > 0,
            "COURSEWARE_INVALID: invalid presentation input"
        );
        let modified = metadata.modified()?;
        anyhow::ensure!(
            modified <= export_time,
            "COURSEWARE_CONFLICT: {} changed after export; run final validation and re-export",
            file.strip_prefix(project)?.display()
        );
        anyhow::ensure!(modified <= report_time, "COURSEWARE_CONFLICT: {} changed after validation; refresh the final SVG quality report and retry adoption", file.strip_prefix(project)?.display()
        );
    }
    Ok(path)
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let p: Adopt = serde_json::from_value(params)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    let state = state.lock().await;
    let root = workspace(&state, &p.session_id)?;
    let mut task = state
        .db
        .kv_get(TASK_NAMESPACE, &p.session_id)
        .map_err(error)?
        .ok_or_else(|| rpc_err(1002, "Select an ordinary task first", "COURSEWARE_INVALID"))?;
    if task["taskType"] != "plain"
        || task.get("importPath").is_some()
        || task.get("canonicalProjectId").is_some()
        || sessions::session_mode(&state.db, &p.session_id)
            .map_err(error)?
            .as_deref()
            != Some("agent")
    {
        return Err(rpc_err(
            1008,
            "Presentation adoption requires an ordinary Agent task",
            "COURSEWARE_CONFLICT",
        ));
    }
    let path = verify_export(&root, &p.path, &p.source_sha256, p.pages.len()).map_err(error)?;
    let path = path.to_string_lossy().to_string();
    let seed = state
        .courseware
        .saved_project_seed(&p.job_id, Path::new(&root))
        .map_err(error)?;
    if seed.project_id != p.project_id
        || seed.sha256 != p.source_sha256
        || seed.pages != p.pages.len()
        || !(1..=100).contains(&seed.pages)
    {
        return Err(rpc_err(
            1008,
            "Presentation parser identity changed",
            "COURSEWARE_CONFLICT",
        ));
    }
    let project = state
        .db
        .get_courseware_project(&root, &p.project_id)
        .map_err(error)?
        .ok_or_else(|| {
            rpc_err(
                1007,
                "Presentation project not found",
                "COURSEWARE_NOT_FOUND",
            )
        })?;
    let plan_hash = hex::encode(Sha256::digest(
        serde_json::to_vec(&p.pages).map_err(|e| error(e.into()))?,
    ));
    if let Some(existing) = task.get("generatedPath") {
        if existing != &json!(path)
            || task["presentationPlanSha256"] != plan_hash
            || project.source.sha256 != p.source_sha256
        {
            return Err(rpc_err(
                1008,
                "Presentation already adopted; resume its saved teaching",
                "COURSEWARE_CONFLICT",
            ));
        }
        return Ok(
            json!({"generated":true,"path":path,"projectId":p.project_id,"sourceSha256":project.source.sha256}),
        );
    }
    if project.task_type != "plain"
        || project.source.sha256 != p.source_sha256
        || project.pages.iter().any(|p| p.locked)
    {
        return Err(rpc_err(
            1008,
            "Presentation source or locks changed",
            "COURSEWARE_CONFLICT",
        ));
    }
    let scenes = p.classroom["scenes"].as_array().ok_or_else(|| {
        rpc_err(
            1002,
            "Presentation scenes are missing",
            "COURSEWARE_INVALID",
        )
    })?;
    let body_limit = task["educationContext"]["bodyPageLimit"]
        .as_u64()
        .unwrap_or(100) as usize;
    let body_count = p
        .pages
        .iter()
        .filter(|page| page.quiz.is_none() && page.teaching.question.is_none())
        .count();
    if scenes.len() != seed.pages
        || body_count > body_limit
        || p.pages.iter().enumerate().any(|(i, page)| {
            let scene = &scenes[i];
            let assessment = page.quiz.is_some() || page.teaching.question.is_some();
            page.page_number != i + 1
                || !page.teaching.valid()
                || scene["metadata"]["nativePageId"] != project.pages[i].page_id
                || scene["metadata"]["teachingRequirements"]
                    != serde_json::to_value(&page.teaching).unwrap_or(Value::Null)
                || (page.teaching.page_type == "quiz") != page.quiz.is_some()
                || (page.quiz.is_none() && scene["type"] != "slide")
                || assessment
                    && (page.teaching.music.is_some()
                        || page.teaching.video.is_some()
                        || !page.teaching.required_objects.is_empty()
                        || page
                            .teaching
                            .required_effects
                            .as_ref()
                            .is_some_and(|e| !e.is_empty()))
                || page.teaching.question.as_ref().is_some_and(|question| {
                    page.quiz.is_some()
                        || page.teaching.page_type == "slide"
                        || matches!(
                            question.response.kind.as_str(),
                            "single" | "multiple" | "judge"
                        )
                        || scene["actions"].as_array().is_none_or(|actions| {
                            actions
                                .iter()
                                .filter(|a| {
                                    a["type"] == "interaction_checkpoint"
                                        && a["question"] == question.text
                                        && a["context"]["sourceSceneIds"]
                                            == json!([project.pages[i].page_id])
                                })
                                .count()
                                != 1
                        })
                })
                || page.quiz.as_ref().is_some_and(|quiz| {
                    scene["type"] != "quiz"
                        || quiz["questions"] != scene["content"]["questions"]
                        || quiz["questions"]
                            .as_array()
                            .is_none_or(|questions| questions.len() != 1)
                })
        })
    {
        return Err(rpc_err(
            1002,
            "Presentation teaching differs from its physical pages or saved page budget",
            "COURSEWARE_INVALID",
        ));
    }
    let current = state
        .db
        .courseware_classroom(&root, &p.project_id, None)
        .map_err(error)?;
    if !current["classroom"].is_null() && current["classroom"] != p.classroom {
        return Err(rpc_err(
            1008,
            "Presentation classroom was edited; preserve it and resume saved teaching",
            "COURSEWARE_CONFLICT",
        ));
    }
    state
        .db
        .write_courseware_classroom(
            &root,
            &p.project_id,
            current["revision"].as_str(),
            &project.source.revision,
            &p.classroom,
        )
        .map_err(error)?;
    // The single Host lock prevents concurrent adoption; replay reuses the same document after an uncertain reply.
    task["generatedPath"] = json!(path);
    task["presentationPlanSha256"] = json!(plan_hash);
    state
        .db
        .kv_set(TASK_NAMESPACE, &p.session_id, &task)
        .map_err(error)?;
    Ok(
        json!({"generated":true,"path":path,"projectId":p.project_id,"sourceSha256":project.source.sha256}),
    )
}
