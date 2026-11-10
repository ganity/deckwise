use super::*;
use crate::db::courseware_projects::TeachingWrite;

mod asset_locks;
mod candidates;
mod classroom;
mod drafts;
mod media_canvas;
mod media_relay;
mod native_save;
mod online_source_review;
mod portable;
mod presentation;
mod scene_images;
mod scene_plan;
pub(super) mod story;
mod snapshots;
mod source_adoption;
mod source_candidates;
mod teaching_history;
mod tts;
mod video;
mod workflow;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageTextParams {
    session_id: String,
    job_id: String,
    page_number: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetParams {
    session_id: String,
    project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskSetParams {
    session_id: String,
    task_type: String,
    #[serde(default)]
    story_first: bool,
    #[serde(default)]
    education_context: Option<crate::db::courseware_projects::CoursewareEducationContext>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskGetParams {
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskEducationParams {
    session_id: String,
    expected_education_context: crate::db::courseware_projects::CoursewareEducationContext,
    education_context: crate::db::courseware_projects::CoursewareEducationContext,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskBindTeamParams {
    session_id: String,
    team_project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskAttachImportParams {
    session_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskAttachGeneratedParams {
    session_id: String,
    path: String,
    project_id: String,
    source_sha256: String,
    #[serde(default)]
    scene_proof: Option<scene_images::GenerationProof>,
}

const TASK_NAMESPACE: &str = "coursewareTask.v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenSavedParams {
    session_id: String,
    job_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InitializeGeneratedParams {
    session_id: String,
    job_id: String,
    source_sha256: String,
    title: String,
    narrations: Vec<String>,
    #[serde(default)]
    scene_proof: Option<scene_images::GenerationProof>,
    #[serde(default)]
    scene_mapping: Option<crate::db::courseware_projects::scene_objects::GeneratedSceneMapping>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdoptReviewParams {
    session_id: String,
    job_id: String,
    review_id: String,
    bindings: Vec<Option<String>>,
    #[serde(default)]
    effect_bindings: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteParams {
    session_id: String,
    write: TeachingWrite,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LockParams {
    session_id: String,
    project_id: String,
    page_id: String,
    expected_source_revision: String,
    expected_teaching_revision: String,
    locked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConfirmParams {
    session_id: String,
    project_id: String,
    page_id: String,
    expected_source_revision: String,
    expected_teaching_revision: String,
    #[serde(default)]
    resolution: Option<crate::db::courseware_projects::chat_changes::ResolutionRequest>,
}

fn error(error: anyhow::Error) -> JsonRpcError {
    let message = error.to_string();
    let kind = message.split(':').next().unwrap_or("INTERNAL");
    let code = match kind {
        "COURSEWARE_CONFLICT" | "COURSEWARE_LOCKED" => 1008,
        "COURSEWARE_NOT_FOUND" | "COURSEWARE_PAGE_NOT_FOUND" => 1007,
        "COURSEWARE_INVALID" | "COURSEWARE_NOTES_EMPTY" => 1002,
        _ => return rpc_err(1000, message, "INTERNAL"),
    };
    rpc_err(code, message.clone(), kind)
}

fn project_workspace(state: &AppState, session_id: &str) -> Result<String, JsonRpcError> {
    resolve_persisted_project_workspace(state, session_id)?.ok_or_else(|| {
        rpc_err(
            1002,
            "A persisted project session is required",
            "COURSEWARE_INVALID",
        )
    })
}

fn workspace(state: &AppState, session_id: &str) -> Result<String, JsonRpcError> {
    let root = project_workspace(state, session_id)?;
    state.db.ensure_no_source_adoption(&root).map_err(error)?;
    Ok(root)
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let invalid = |error: serde_json::Error| rpc_err(1002, error.to_string(), "INVALID_PARAMS");
    match method {
        "courseware.story.get" | "courseware.story.begin" | "courseware.story.save" | "courseware.story.decide" => story::handle(state, method, params).await,
        "courseware.classroom.mediaScope" | "courseware.classroom.refresh" | "courseware.classroom.source" | "courseware.classroom.create" | "courseware.classroom.get" | "courseware.classroom.write" | "courseware.classroom.snapshot" => classroom::handle(state, method, params).await,
        "courseware.workflow.get" | "courseware.workflow.checkpoint" => {
            workflow::handle(state, method, params).await
        }
        "courseware.onlineSource.baseline"
        | "courseware.onlineSource.review"
        | "courseware.onlineSource.resolve"
        | "courseware.onlineSource.clear" => {
            online_source_review::handle(state, method, params).await
        }
        "courseware.teachingHistory.list" => teaching_history::handle(state, params).await,
        "courseware.scenePlan.get" | "courseware.scenePlan.approve" => {
            scene_plan::handle(state, method, params).await
        }
        "courseware.sceneImage.prepare"
        | "courseware.sceneImage.retry"
        | "courseware.sceneImage.list"
        | "courseware.sceneImage.rebindModel"
        | "courseware.sceneImage.get"
        | "courseware.sceneImage.begin"
        | "courseware.sceneImage.bind"
        | "courseware.sceneImage.reject"
        | "courseware.sceneImage.asset.stage"
        | "courseware.sceneImage.bundle.stage"
        | "courseware.sceneImage.asset.get"
        | "courseware.sceneImage.reference.get"
        | "courseware.sceneImage.asset.adopt" => scene_images::handle(state, method, params).await,
        "courseware.teachingDraft.get" | "courseware.teachingDraft.set" => {
            drafts::handle(state, method, params).await
        }
        "courseware.mediaCanvas.get"
        | "courseware.mediaCanvas.set"
        | "courseware.mediaCanvas.editDraft"
        | "courseware.mediaCanvas.music.prepare"
        | "courseware.mediaCanvas.music.export.prepare"
        | "courseware.mediaCanvas.music.list"
        | "courseware.mediaCanvas.music.get"
        | "courseware.mediaCanvas.music.begin"
        | "courseware.mediaCanvas.music.bind"
        | "courseware.mediaCanvas.music.reject"
        | "courseware.mediaCanvas.music.candidates.record"
        | "courseware.mediaCanvas.music.asset.stage"
        | "courseware.mediaCanvas.music.asset.restore"
        | "courseware.mediaCanvas.music.asset.get"
        | "courseware.mediaCanvas.music.adopt"
        | "courseware.mediaCanvas.music.snapshotAssets"
        | "courseware.mediaCanvas.image.prepare"
        | "courseware.mediaCanvas.image.list"
        | "courseware.mediaCanvas.image.get"
        | "courseware.mediaCanvas.image.begin"
        | "courseware.mediaCanvas.image.bind"
        | "courseware.mediaCanvas.image.reject"
        | "courseware.mediaCanvas.image.reference"
        | "courseware.mediaCanvas.image.asset.stage"
        | "courseware.mediaCanvas.image.asset.restore"
        | "courseware.mediaCanvas.image.asset.get" => {
            media_canvas::handle(state, method, params).await
        }
        "courseware.task.set" => {
            let p: TaskSetParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = project_workspace(&state, &p.session_id)?;
            if !matches!(p.task_type.as_str(), "plain" | "scene" | "import") {
                return Err(rpc_err(
                    1002,
                    "Invalid courseware task type",
                    "COURSEWARE_INVALID",
                ));
            }
            let mut task =
                json!({ "taskType": p.task_type, "educationContext": p.education_context });
            if serde_json::to_vec(&task)
                .map_err(|e| error(e.into()))?
                .len()
                > 4096
                || p.education_context.as_ref().is_some_and(|context| {
                    [
                        &context.school_stage,
                        &context.grade,
                        &context.subject,
                        &context.custom_subject_name,
                        &context.textbook_version,
                        &context.chapter,
                        &context.lesson_type,
                        &context.visual_style,
                    ]
                    .iter()
                    .any(|value| {
                        value
                            .as_ref()
                            .is_some_and(|text| text.encode_utf16().count() > 500)
                    })
                })
            {
                return Err(rpc_err(
                    1002,
                    "Invalid education context",
                    "COURSEWARE_INVALID",
                ));
            }
            if p.story_first {
                if p.task_type == "import" { return Err(rpc_err(1002,"Import does not support story creation","COURSEWARE_INVALID")); }
                task["storyFirst"] = json!(true);
            }
            let session = crate::sessions::get_session(&state.db, &p.session_id)
                .map_err(error)?
                .ok_or_else(|| rpc_err(1007, "session not found", "SESSION_NOT_FOUND"))?;
            let current = state
                .db
                .kv_get(TASK_NAMESPACE, &p.session_id)
                .map_err(error)?;
            if let Some(team) = current.as_ref().and_then(|task| task.get("teamProjectId")) {
                task["teamProjectId"] = team.clone();
            }
            if current
                .as_ref()
                .is_some_and(|value| value["taskType"] == "scene")
                && scene_plan::has_approval(&state, &root, &p.session_id)?
                && current.as_ref() != Some(&task)
            {
                return Err(rpc_err(
                    1008,
                    "Approved scene task cannot change type or education context",
                    "COURSEWARE_CONFLICT",
                ));
            }
            if current.as_ref().is_some_and(|value| {
                value.get("importPath").is_some() || value.get("generatedPath").is_some() || value.get("canonicalProjectId").is_some()
            }) {
                return Err(rpc_err(
                    1008,
                    "Courseware source is already attached",
                    "COURSEWARE_CONFLICT",
                ));
            }
            if session.summary.message_count > 0 && current.as_ref() != Some(&task) {
                return Err(rpc_err(
                    1008,
                    "Started task cannot change type or education context",
                    "COURSEWARE_CONFLICT",
                ));
            }
            state
                .db
                .kv_set(TASK_NAMESPACE, &p.session_id, &task)
                .map_err(error)?;
            Ok(json!({ "task": task }))
        }
        "courseware.task.updateEducation" => {
            let p: TaskEducationParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = project_workspace(&state, &p.session_id)?;
            let mut task = state
                .db
                .kv_get(TASK_NAMESPACE, &p.session_id)
                .map_err(error)?
                .ok_or_else(|| {
                    rpc_err(1002, "Select a courseware task first", "COURSEWARE_INVALID")
                })?;
            if task.get("importPath").is_some()
                || task.get("generatedPath").is_some()
                || task.get("canonicalProjectId").is_some()
                || scene_plan::has_approval(&state, &root, &p.session_id)?
            {
                return Err(rpc_err(
                    1008,
                    "Approved or attached courseware requires a reviewed teaching revision",
                    "COURSEWARE_CONFLICT",
                ));
            }
            if task["storyFirst"] == true && story::read(&state,&p.session_id)?.is_some_and(|story| story["bound"] == true) {
                return Err(rpc_err(1008,"Story-bound courseware requires a new task for requirement changes","COURSEWARE_CONFLICT"));
            }
            let current: crate::db::courseware_projects::CoursewareEducationContext = match task
                .get("educationContext")
                .filter(|value| !value.is_null())
            {
                Some(value) => serde_json::from_value(value.clone()).map_err(invalid)?,
                None => serde_json::from_value(json!({})).map_err(invalid)?,
            };
            if serde_json::to_value(&current).map_err(invalid)?
                != serde_json::to_value(p.expected_education_context).map_err(invalid)?
            {
                return Err(rpc_err(
                    1008,
                    "Teaching requirements changed; read the task again",
                    "COURSEWARE_CONFLICT",
                ));
            }
            if current.body_page_limit.is_some() && p.education_context.body_page_limit.is_none() {
                return Err(rpc_err(
                    1002,
                    "Preserve the saved bodyPageLimit when updating other teaching requirements",
                    "COURSEWARE_INVALID",
                ));
            }
            if [
                &p.education_context.school_stage,
                &p.education_context.grade,
                &p.education_context.subject,
                &p.education_context.custom_subject_name,
                &p.education_context.textbook_version,
                &p.education_context.chapter,
                &p.education_context.lesson_type,
                &p.education_context.visual_style,
            ]
            .iter()
            .any(|value| {
                value
                    .as_ref()
                    .is_some_and(|text| text.encode_utf16().count() > 500)
            }) {
                return Err(rpc_err(
                    1002,
                    "Invalid teaching requirements",
                    "COURSEWARE_INVALID",
                ));
            }
            task["educationContext"] =
                serde_json::to_value(p.education_context).map_err(invalid)?;
            if serde_json::to_vec(&task).map_err(invalid)?.len() > 4096 {
                return Err(rpc_err(
                    1002,
                    "Teaching requirements exceed limits",
                    "COURSEWARE_INVALID",
                ));
            }
            state
                .db
                .kv_set(TASK_NAMESPACE, &p.session_id, &task)
                .map_err(error)?;
            Ok(json!({ "task": task }))
        }
        "courseware.task.get" => {
            let p: TaskGetParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            project_workspace(&state, &p.session_id)?;
            let task = state
                .db
                .kv_get(TASK_NAMESPACE, &p.session_id)
                .map_err(error)?;
            Ok(json!({ "task": task }))
        }
        "courseware.task.bindTeam" => {
            let p: TaskBindTeamParams = serde_json::from_value(params).map_err(invalid)?;
            if uuid::Uuid::parse_str(&p.team_project_id).is_err() {
                return Err(rpc_err(
                    1002,
                    "Invalid team project id",
                    "COURSEWARE_INVALID",
                ));
            }
            let state = state.lock().await;
            project_workspace(&state, &p.session_id)?;
            let mut task = state
                .db
                .kv_get(TASK_NAMESPACE, &p.session_id)
                .map_err(error)?
                .ok_or_else(|| {
                    rpc_err(1002, "Select a courseware task first", "COURSEWARE_INVALID")
                })?;
            if let Some(existing) = task.get("teamProjectId") {
                if existing != &json!(p.team_project_id) {
                    return Err(rpc_err(
                        1008,
                        "Courseware task is already bound to another team project",
                        "COURSEWARE_CONFLICT",
                    ));
                }
                return Ok(json!({ "task": task }));
            }
            task["teamProjectId"] = json!(p.team_project_id);
            state
                .db
                .kv_set(TASK_NAMESPACE, &p.session_id, &task)
                .map_err(error)?;
            Ok(json!({ "task": task }))
        }
        "courseware.task.attachImport" => {
            let p: TaskAttachImportParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = project_workspace(&state, &p.session_id)?;
            let mut task = state
                .db
                .kv_get(TASK_NAMESPACE, &p.session_id)
                .map_err(error)?
                .ok_or_else(|| rpc_err(1002, "Select import task first", "COURSEWARE_INVALID"))?;
            if task["taskType"] != "import" || task.get("importPath").is_some() {
                return Err(rpc_err(
                    1008,
                    "Import task already has a source",
                    "COURSEWARE_CONFLICT",
                ));
            }
            let allowed =
                std::fs::canonicalize(std::path::Path::new(&root).join(".deckwise-ppt/imports"))
                    .map_err(|e| error(e.into()))?;
            let path = std::fs::canonicalize(&p.path).map_err(|e| error(e.into()))?;
            if !path.starts_with(&allowed)
                || !path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("pptx"))
                || !path.is_file()
            {
                return Err(rpc_err(
                    1002,
                    "Imported PPTX must be inside the current workspace",
                    "COURSEWARE_INVALID",
                ));
            }
            task["importPath"] = json!(path.to_string_lossy().to_string());
            state
                .db
                .kv_set(TASK_NAMESPACE, &p.session_id, &task)
                .map_err(error)?;
            Ok(json!({ "task": task }))
        }
        "courseware.task.attachGenerated" => {
            let p: TaskAttachGeneratedParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = project_workspace(&state, &p.session_id)?;
            let mut task = state
                .db
                .kv_get(TASK_NAMESPACE, &p.session_id)
                .map_err(error)?
                .ok_or_else(|| rpc_err(1002, "Select a scene task first", "COURSEWARE_INVALID"))?;
            if task["taskType"] != "scene" || task.get("importPath").is_some() || task.get("canonicalProjectId").is_some() {
                return Err(rpc_err(
                    1008,
                    "Generated source requires a scene task",
                    "COURSEWARE_CONFLICT",
                ));
            }
            if let Some(proof) = &p.scene_proof {
                scene_images::verify_generation(&state, &root, &p.session_id, proof)?;
            } else if scene_plan::has_approval(&state, &root, &p.session_id)? {
                return Err(rpc_err(
                    1008,
                    "Reviewed scene inputs are required",
                    "COURSEWARE_CONFLICT",
                ));
            }
            let allowed =
                std::fs::canonicalize(std::path::Path::new(&root).join(".deckwise-ppt/generated"))
                    .map_err(|e| error(e.into()))?;
            let path = std::fs::canonicalize(&p.path).map_err(|e| error(e.into()))?;
            let expected_name = format!("{}.pptx", p.source_sha256);
            if !path.starts_with(&allowed)
                || !path.is_file()
                || path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str())
            {
                return Err(rpc_err(
                    1002,
                    "Generated PPTX must be the verified workspace file",
                    "COURSEWARE_INVALID",
                ));
            }
            let size = std::fs::metadata(&path).map_err(|e| error(e.into()))?.len();
            if size == 0 || size > 50 * 1024 * 1024 {
                return Err(rpc_err(
                    1002,
                    "Generated PPTX size is invalid",
                    "COURSEWARE_INVALID",
                ));
            }
            use sha2::Digest;
            let actual_sha256 = hex::encode(sha2::Sha256::digest(
                std::fs::read(&path).map_err(|e| error(e.into()))?,
            ));
            if actual_sha256 != p.source_sha256 {
                return Err(rpc_err(
                    1008,
                    "Generated PPTX bytes changed",
                    "COURSEWARE_CONFLICT",
                ));
            }
            let project = state
                .db
                .get_courseware_project(&root, &p.project_id)
                .map_err(error)?
                .ok_or_else(|| {
                    rpc_err(1007, "Generated project not found", "COURSEWARE_NOT_FOUND")
                })?;
            let assessments = state.db.courseware_assessment_page_ids(&root, &project).map_err(error)?;
            if project.task_type != "scene"
                || project.source.sha256 != p.source_sha256
                || project.pages.iter().any(|page| page.actions.is_empty() && !assessments.contains(&page.page_id))
            {
                return Err(rpc_err(
                    1008,
                    "Generated project is not initialized",
                    "COURSEWARE_CONFLICT",
                ));
            }
            let path = path.to_string_lossy().to_string();
            if let Some(existing) = task.get("generatedPath") {
                if existing != &json!(path) {
                    return Err(rpc_err(
                        1008,
                        "Scene task already has a generated source",
                        "COURSEWARE_CONFLICT",
                    ));
                }
                return Ok(json!({ "task": task }));
            }
            task["generatedPath"] = json!(path);
            state
                .db
                .kv_set(TASK_NAMESPACE, &p.session_id, &task)
                .map_err(error)?;
            Ok(json!({ "task": task }))
        }
        "courseware.presentation.adopt" => presentation::handle(state, params).await,
        "courseware.assetLocks.context" | "courseware.assetLocks.set" => {
            asset_locks::handle(state, method, params).await
        }
        "courseware.video.prepare"
        | "courseware.video.retry"
        | "courseware.video.get"
        | "courseware.video.asset.get"
        | "courseware.video.reuse"
        | "courseware.video.list"
        | "courseware.video.begin"
        | "courseware.video.bind"
        | "courseware.video.stage"
        | "courseware.video.adopt" => video::handle(state, method, params).await,
        "courseware.mediaRelay.scope" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct ScopeParams { session_id: String }
            let p: ScopeParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            workspace(&state, &p.session_id)?;
            serde_json::to_value(state.db.courseware_media_submission_scope(&p.session_id).map_err(error)?).map_err(|e| error(e.into()))
        }
        "courseware.mediaRelay.read" | "courseware.mediaRelay.write" => {
            media_relay::handle(state, method, params).await
        }
        "courseware.tts.prepare"
        | "courseware.tts.get"
        | "courseware.tts.list"
        | "courseware.tts.begin"
        | "courseware.tts.bind"
        | "courseware.tts.reject"
        | "courseware.tts.audio.stage"
        | "courseware.tts.audio.get"
        | "courseware.tts.audio.adopt" => tts::handle(state, method, params).await,
        "courseware.nativeSave.prepare" | "courseware.nativeSave.resolve" | "courseware.nativeSave.forPath" => native_save::handle(state, method, params).await,
        "courseware.project.copy" => portable::handle(state, params).await,
        "courseware.project.restore" => portable::restore(state, params).await,
        "courseware.project.attach" => portable::attach(state, params).await,
        "courseware.project.localMedia" => portable::local_media(state, params).await,
        "courseware.snapshot.capture"
        | "courseware.snapshot.get"
        | "courseware.snapshot.onlineOrigin"
        | "courseware.snapshot.importNative"
        | "courseware.snapshot.importOnline" => snapshots::handle(state, method, params).await,
        "courseware.sourceAdoption.prepare"
        | "courseware.sourceAdoption.get"
        | "courseware.sourceAdoption.forPath"
        | "courseware.sourceAdoption.commit"
        | "courseware.sourceAdoption.cancel" => {
            source_adoption::handle(state, method, params).await
        }
        "courseware.sourceCandidate.prepare"
        | "courseware.sourceCandidate.stage"
        | "courseware.sourceCandidate.get"
        | "courseware.sourceCandidate.context"
        | "courseware.sourceCandidate.preview"
        | "courseware.sourceCandidate.reject" => {
            source_candidates::handle(state, method, params).await
        }
        "courseware.narration.save"
        | "courseware.narrationCandidate.stage"
        | "courseware.narrationCandidate.get"
        | "courseware.narrationCandidate.reject"
        | "courseware.narrationCandidate.adopt" => candidates::handle(state, method, params).await,
        "courseware.pageEvidence" => {
            let p: PageTextParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            state
                .courseware
                .narration_page_evidence(&p.job_id, Path::new(&root), p.page_number)
                .map_err(error)
        }
        "courseware.pageText" => {
            let p: PageTextParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let text = state
                .courseware
                .narration_page_text(&p.job_id, Path::new(&root), p.page_number)
                .map_err(error)?;
            Ok(json!({ "text": text }))
        }
        "courseware.pageNotes" => {
            let p: PageTextParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let text = state
                .courseware
                .narration_page_notes(&p.job_id, Path::new(&root), p.page_number)
                .map_err(error)?;
            Ok(json!({ "text": text }))
        }
        "courseware.review.prepare" => {
            let p: OpenSavedParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let seed = state
                .courseware
                .saved_project_seed(&p.job_id, Path::new(&root))
                .map_err(error)?;
            state
                .db
                .prepare_courseware_review(&root, &seed)
                .map_err(error)
        }
        "courseware.review.adopt" => {
            let p: AdoptReviewParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let seed = state
                .courseware
                .saved_project_seed(&p.job_id, Path::new(&root))
                .map_err(error)?;
            let project = state
                .db
                .adopt_courseware_review_with_effects(
                    &root,
                    &seed,
                    &p.review_id,
                    &p.bindings,
                    &p.effect_bindings,
                )
                .map_err(error)?;
            Ok(json!({ "project": project }))
        }
        "courseware.project.openSaved" => {
            let p: OpenSavedParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let task = state
                .db
                .kv_get(TASK_NAMESPACE, &p.session_id)
                .map_err(error)?;
            let task_type = task
                .as_ref()
                .and_then(|value| value.get("taskType"))
                .and_then(Value::as_str)
                .unwrap_or("import");
            if !matches!(task_type, "plain" | "scene" | "import") {
                return Err(rpc_err(
                    1002,
                    "Invalid saved courseware task type",
                    "COURSEWARE_INVALID",
                ));
            }
            let education_context = task
                .as_ref()
                .and_then(|value| value.get("educationContext"))
                .filter(|value| !value.is_null())
                .map(|value| serde_json::from_value(value.clone()).map_err(invalid))
                .transpose()?;
            let seed = state
                .courseware
                .saved_project_seed(&p.job_id, Path::new(&root))
                .map_err(error)?;
            let project = state
                .db
                .open_identified_courseware_project_with_metadata(
                    &root,
                    &seed,
                    task_type,
                    education_context,
                )
                .map_err(error)?;
            Ok(json!({ "project": project }))
        }
        "courseware.project.initializeGenerated" => {
            let p: InitializeGeneratedParams = serde_json::from_value(params).map_err(invalid)?;
            if p.scene_mapping.is_some() && p.scene_proof.is_none() {
                return Err(rpc_err(
                    1002,
                    "Scene mapping requires reviewed generation inputs",
                    "COURSEWARE_INVALID",
                ));
            }
            if p.title.trim().is_empty()
                || p.title.encode_utf16().count() > 500
                || p.narrations.is_empty()
                || p.narrations.len() > 100
                || p.narrations
                    .iter()
                    .any(|text| p.scene_proof.is_none() && text.trim().is_empty() || text.encode_utf16().count() > 2500)
            {
                return Err(rpc_err(
                    1002,
                    "Invalid generated narration",
                    "COURSEWARE_INVALID",
                ));
            }
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let task = state
                .db
                .kv_get(TASK_NAMESPACE, &p.session_id)
                .map_err(error)?;
            let task_type = task
                .as_ref()
                .and_then(|value| value.get("taskType"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if !matches!(task_type, "plain" | "scene") {
                return Err(rpc_err(
                    1002,
                    "Generated project requires a generation task",
                    "COURSEWARE_INVALID",
                ));
            }
            if let Some(proof) = &p.scene_proof {
                let plan = scene_images::verify_generation(&state, &root, &p.session_id, proof)?;
                let mapping = p.scene_mapping.as_ref().ok_or_else(|| {
                    rpc_err(
                        1002,
                        "Generated scene object mapping is required",
                        "COURSEWARE_INVALID",
                    )
                })?;
                let native_pages: Vec<_> = plan.pages.iter().enumerate().collect();
                if task_type != "scene"
                    || plan.title != p.title
                    || native_pages
                        .iter()
                        .map(|(_, page)| &page.narration)
                        .ne(p.narrations.iter())
                    || mapping.pages.len() != native_pages.len()
                {
                    return Err(rpc_err(
                        1008,
                        "Generated teaching differs from the approved scene plan",
                        "COURSEWARE_CONFLICT",
                    ));
                }
                for (mapped, (index, planned)) in mapping.pages.iter().zip(native_pages)
                {
                    if mapped.slide_id != format!("scene-{:03}", index + 1)
                        || mapped.source_hash != planned.source_hash()?
                    {
                        return Err(rpc_err(
                            1008,
                            "Generated objects differ from the approved scene plan",
                            "COURSEWARE_CONFLICT",
                        ));
                    }
                }
            } else if task_type == "scene"
                && scene_plan::has_approval(&state, &root, &p.session_id)?
            {
                return Err(rpc_err(
                    1008,
                    "Reviewed scene inputs are required",
                    "COURSEWARE_CONFLICT",
                ));
            }
            let education_context = task
                .as_ref()
                .and_then(|value| value.get("educationContext"))
                .filter(|value| !value.is_null())
                .map(|value| serde_json::from_value(value.clone()).map_err(invalid))
                .transpose()?;
            let seed = state
                .courseware
                .saved_project_seed(&p.job_id, Path::new(&root))
                .map_err(error)?;
            if seed.sha256 != p.source_sha256 || seed.pages != p.narrations.len() {
                return Err(rpc_err(
                    1002,
                    "Generated PPTX differs from planned pages",
                    "COURSEWARE_INVALID",
                ));
            }
            if let Some(mapping) = &p.scene_mapping {
                if task_type != "scene" {
                    return Err(rpc_err(
                        1002,
                        "Scene mapping requires a scene task",
                        "COURSEWARE_INVALID",
                    ));
                }
                let identity = seed.identity.as_ref().ok_or_else(|| {
                    rpc_err(
                        1002,
                        "Generated scene source identity is required",
                        "COURSEWARE_INVALID",
                    )
                })?;
                mapping.validate_source(identity).map_err(error)?;
            }
            let project = state
                .db
                .open_identified_courseware_project_with_metadata(
                    &root,
                    &seed,
                    task_type,
                    education_context,
                )
                .map_err(error)?;
            let project = state
                .db
                .initialize_generated_narration(
                    &root,
                    &project.project_id,
                    &p.source_sha256,
                    &p.title,
                    &p.narrations,
                )
                .map_err(error)?;
            if let Some(mapping) = &p.scene_mapping {
                state
                    .db
                    .initialize_generated_scene_objects(&root, &project, mapping)
                    .map_err(error)?;
            }
            Ok(json!({ "project": project }))
        }
        "courseware.project.context" => {
            let p: GetParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            state
                .db
                .courseware_project_context(&root, &p.project_id)
                .map_err(error)
        }
        "courseware.project.get" => {
            let p: GetParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let project = state
                .db
                .get_courseware_project(&root, &p.project_id)
                .map_err(error)?;
            Ok(json!({ "project": project }))
        }
        "courseware.teaching.write" => {
            let p: WriteParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let project = state
                .db
                .write_courseware_teaching(&root, &p.write)
                .map_err(error)?;
            Ok(json!({ "project": project }))
        }
        "courseware.teaching.confirm" => {
            let p: ConfirmParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let project = if let Some(resolution) = &p.resolution {
                if sessions::session_has_running_turn(&state.db, &p.session_id).map_err(error)? {
                    return Err(rpc_err(
                        1008,
                        "Stop or finish the owning Chat before reviewing its changes",
                        "COURSEWARE_CONFLICT",
                    ));
                }
                state
                    .db
                    .resolve_courseware_chat_change(
                        &root,
                        &p.session_id,
                        &p.project_id,
                        &p.page_id,
                        &p.expected_source_revision,
                        &p.expected_teaching_revision,
                        resolution,
                    )
                    .map_err(error)?
            } else {
                state
                    .db
                    .review_courseware_page(
                        &root,
                        &p.project_id,
                        &p.page_id,
                        &p.expected_source_revision,
                        &p.expected_teaching_revision,
                    )
                    .map_err(error)?
            };
            Ok(json!({ "project": project }))
        }
        "courseware.teaching.setLock" => {
            let p: LockParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let root = workspace(&state, &p.session_id)?;
            let project = state
                .db
                .set_courseware_page_lock(
                    &root,
                    &p.project_id,
                    &p.page_id,
                    &p.expected_source_revision,
                    &p.expected_teaching_revision,
                    p.locked,
                )
                .map_err(error)?;
            Ok(json!({ "project": project }))
        }
        _ => Err(rpc_err(-32601, "Method not found", "METHOD_NOT_FOUND")),
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod context_tests;
