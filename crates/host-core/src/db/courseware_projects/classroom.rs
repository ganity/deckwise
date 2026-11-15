//! Canonical MAIC content is independent of native PPT page cardinality.
use super::*;
use serde_json::json;
use std::collections::HashSet;
mod validation;

const ANCHORS: &str = "coursewareClassroomProjects.v1";
pub(super) const DOCUMENTS: &str = "coursewareClassrooms.v1";
pub(super) const REVISIONS: &str = "coursewareClassroomRevisions.v1";
const MAX_CLASSROOM_BYTES: usize = 16 * 1024 * 1024;

fn invalid(condition: bool, message: &str) -> Result<()> {
    anyhow::ensure!(condition, "COURSEWARE_INVALID: {message}");
    Ok(())
}

fn text(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|s| !s.trim().is_empty() && s.len() <= 128_000)
}

/// Validate relationships and discriminants while preserving all MAIC optional metadata.
pub fn validate_classroom(value: &Value) -> Result<()> {
    invalid(
        serde_json::to_vec(value)?.len() <= MAX_CLASSROOM_BYTES,
        "classroom exceeds size limit",
    )?;
    invalid(
        value.is_object() && text(&value["id"]),
        "missing classroom identity",
    )?;
    let stage = &value["stage"];
    invalid(
        stage.is_object()
            && text(&stage["id"])
            && stage["name"].is_string()
            && stage["createdAt"].is_number()
            && stage["updatedAt"].is_number()
            && value["createdAt"].is_string(),
        "invalid MAIC stage",
    )?;
    let scenes = value["scenes"]
        .as_array()
        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: scenes must be an array"))?;
    invalid(scenes.len() <= 1000, "too many scenes")?;
    let mut ids = HashSet::new();
    for scene in scenes {
        if let Some(teaching) = scene["metadata"].get("teachingRequirements") {
            let teaching: scene_teaching::Teaching = serde_json::from_value(teaching.clone())?;
            invalid(teaching.valid(), "invalid retained teaching requirements")?;
        }
        invalid(
            text(&scene["id"])
                && ids.insert(scene["id"].as_str().unwrap())
                && scene["stageId"] == stage["id"],
            "invalid scene identity or stage binding",
        )?;
        invalid(
            scene["title"].is_string() && scene["order"].as_u64().is_some(),
            "invalid scene title/order",
        )?;
        let kind = scene["type"].as_str().unwrap_or("");
        invalid(
            matches!(kind, "slide" | "quiz" | "interactive" | "pbl")
                && scene["content"]["type"] == kind,
            "scene/content types differ",
        )?;
        if kind == "slide" {
            invalid(
                validation::valid_canvas(&scene["content"]["canvas"]),
                "slide canvas is required",
            )?;
        }
        if kind == "interactive" {
            invalid(
                scene["content"]["url"].is_string(),
                "interactive URL is required",
            )?;
        }
        if kind == "quiz" {
            let content = &scene["content"];
            invalid(
                content.get("interactionMode").is_none_or(|m| {
                    matches!(
                        m.as_str(),
                        Some("assessment_review" | "classroom_instant_feedback")
                    )
                }),
                "invalid Quiz interaction mode",
            )?;
            if let Some(config) = content.get("playbackConfig") {
                invalid(
                    config["introSpeechMode"] == "page_enter_only"
                        && config["attemptPolicy"] == "until_correct"
                        && config["successSpeechText"].is_string()
                        && config["failureSpeechText"].is_string()
                        && config["cueUserOnEnter"].is_boolean()
                        && config["cueUserOnRetry"].is_boolean(),
                    "invalid Quiz playback configuration",
                )?;
            }
            let questions = scene["content"]["questions"]
                .as_array()
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: quiz questions must be an array"))?;
            invalid(questions.len() <= 1000, "too many questions")?;
            invalid(
                content["interactionMode"] != "classroom_instant_feedback" || questions.len() <= 1,
                "Instant Quiz accepts one question; use assessment_review for multiple questions",
            )?;
            let mut question_ids = HashSet::new();
            for question in questions {
                invalid(
                    text(&question["id"])
                        && question_ids.insert(question["id"].as_str().unwrap())
                        && question["question"].is_string(),
                    "invalid question identity/text",
                )?;
                invalid(
                    ["analysis", "commentPrompt", "referenceAnswer"]
                        .iter()
                        .all(|field| question.get(field).is_none_or(Value::is_string))
                        && question.get("keyPoints").is_none_or(|a| {
                            a.as_array().is_some_and(|a| a.iter().all(Value::is_string))
                        })
                        && question.get("hasAnswer").is_none_or(Value::is_boolean)
                        && question.get("points").is_none_or(Value::is_number),
                    "invalid Quiz grading metadata",
                )?;
                let ty = question["type"].as_str().unwrap_or("");
                invalid(
                    matches!(ty, "single" | "multiple" | "judge" | "short_answer"),
                    "invalid quiz type",
                )?;
                let mut option_ids = HashSet::new();
                if let Some(options) = question.get("options") {
                    for option in options.as_array().ok_or_else(|| {
                        anyhow!("COURSEWARE_INVALID: quiz options must be an array")
                    })? {
                        invalid(
                            text(&option["value"])
                                && option_ids.insert(option["value"].as_str().unwrap())
                                && option["label"].is_string(),
                            "options require unique stable values and labels",
                        )?;
                        validate_image(option.get("image"))?;
                    }
                }
                if ty == "judge" {
                    invalid(option_ids.len() == 2, "judge requires two options")?;
                }
                validate_image(question.get("image"))?;
                if let Some(answer) = question.get("answer") {
                    let answers = answer
                        .as_array()
                        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: answers must be an array"))?;
                    let mut used = HashSet::new();
                    for answer in answers {
                        invalid(
                            answer.as_str().is_some_and(|a| {
                                (ty == "short_answer" || option_ids.contains(a)) && used.insert(a)
                            }),
                            "answer refers to a missing or duplicate option",
                        )?;
                    }
                    if ty == "single" || ty == "judge" {
                        invalid(answers.len() <= 1, "single/judge has more than one answer")?;
                    }
                }
                invalid(
                    question.get("response").is_none() && question.get("answerIndices").is_none(),
                    "DeckWise response extensions are not MAIC Quiz fields",
                )?;
            }
        }
        let mut action_ids = HashSet::new();
        if let Some(actions) = scene.get("actions") {
            for action in actions
                .as_array()
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: actions must be an array"))?
            {
                invalid(
                    text(&action["id"]) && action_ids.insert(action["id"].as_str().unwrap()),
                    "duplicate or missing action ID",
                )?;
                let ty = action["type"].as_str().unwrap_or("");
                invalid(
                    matches!(
                        ty,
                        "spotlight"
                            | "laser"
                            | "play_video"
                            | "play_audio"
                            | "element_animation"
                            | "speech"
                            | "wb_open"
                            | "wb_draw_text"
                            | "wb_draw_shape"
                            | "wb_draw_chart"
                            | "wb_draw_latex"
                            | "wb_draw_table"
                            | "wb_draw_line"
                            | "wb_clear"
                            | "wb_delete"
                            | "wb_close"
                            | "discussion"
                            | "interaction_checkpoint"
                    ),
                    "unsupported MAIC action",
                )?;
                validation::validate_action(action, scene, scenes)?;
                if ty == "interaction_checkpoint" {
                    invalid(
                        action.get("response").is_none(),
                        "Quiz response cannot be an interaction checkpoint",
                    )?;
                    match action["checkpointKind"].as_str() {
                        Some("chapter_summary") => {
                            invalid(
                                kind == "slide"
                                    && action["question"].is_string()
                                    && text(&action["checkpointId"])
                                    && text(&action["chapterId"])
                                    && action["chapterTitle"].is_string(),
                                "invalid chapter checkpoint",
                            )?;
                            invalid(
                                action["referenceAnswer"]["summary"].is_string()
                                    && action["referenceAnswer"]["keyPoints"]
                                        .as_array()
                                        .is_some_and(|a| a.iter().all(Value::is_string)),
                                "invalid reference answer",
                            )?;
                            invalid(
                                action["context"]["chapterSummary"].is_string()
                                    && action["context"]["sourceSceneIds"]
                                        .as_array()
                                        .is_some_and(|a| a.iter().all(Value::is_string)),
                                "invalid checkpoint context",
                            )?;
                            invalid(
                                action.get("constraintPrompt").is_none_or(Value::is_string),
                                "invalid constraint prompt",
                            )?;
                        }
                        Some("media_playback") => {
                            invalid(
                                text(&action["elementId"])
                                    && matches!(
                                        action["mediaType"].as_str(),
                                        Some("video" | "audio")
                                    )
                                    && action["startMode"] == "teacher_triggered"
                                    && action["waitForCompletion"].is_boolean(),
                                "invalid media checkpoint",
                            )?;
                        }
                        _ => invalid(false, "unsupported checkpoint kind")?,
                    }
                }
            }
        }
    }
    validation::validate_manifests(value)?;
    Ok(())
}
fn validate_image(value: Option<&Value>) -> Result<()> {
    if let Some(image) = value {
        invalid(
            image.is_object()
                && validation::safe_source(&image["src"])
                && image["src"]
                    .as_str()
                    .is_some_and(|src| src.len() <= 7 * 1024 * 1024)
                && image.get("assetId").is_none_or(Value::is_string)
                && image.get("mimeType").is_none_or(Value::is_string),
            "invalid Quiz image",
        )?;
    }
    Ok(())
}

fn validate_document(document: &Value, project_id: &str) -> Result<()> {
    invalid(
        document["projectId"] == project_id
            && document["revision"].as_str().is_some_and(valid_id)
            && text(&document["sourceRevision"]),
        "invalid stored classroom revision",
    )?;
    validate_classroom(&document["classroom"])
}

impl Database {
    /// Called inside the native-save transaction, before source bytes are replaced.
    pub(super) fn prepare_native_classroom(
        &self,
        workspace: &str,
        baseline: &CoursewareProject,
        next: &CoursewareProject,
        expected_revision: &str,
        value: &Value,
    ) -> Result<Value> {
        let current = self.courseware_classroom(workspace, &baseline.project_id, None)?;
        anyhow::ensure!(
            current["revision"] == expected_revision,
            "COURSEWARE_CONFLICT: classroom changed; reopen before saving"
        );
        let scenes = value["scenes"]
            .as_array()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: scenes missing"))?;
        invalid(
            scenes.len() == next.pages.len(),
            "every scene requires its own native page",
        )?;
        for page in baseline.pages.iter().filter(|page| page.locked) {
            let find = |doc: &Value| {
                doc["scenes"]
                    .as_array()
                    .and_then(|scenes| {
                        scenes
                            .iter()
                            .find(|scene| scene["metadata"]["nativePageId"] == page.page_id)
                    })
                    .cloned()
            };
            anyhow::ensure!(
                find(&current["classroom"]) == find(value),
                "COURSEWARE_LOCKED: canonical scene is locked"
            );
        }
        let mut classroom = value.clone();
        validation::invalidate_edited_audio(&current["classroom"], &mut classroom);
        for (scene, page) in classroom["scenes"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .zip(&next.pages)
        {
            if !scene["metadata"].is_object() {
                scene["metadata"] = json!({});
            }
            scene["metadata"]["nativePageId"] = json!(page.page_id);
            scene["metadata"]
                .as_object_mut()
                .unwrap()
                .remove("copiedFromNativePageId");
            let question = scene["actions"]
                .as_array()
                .and_then(|actions| {
                    actions.iter().find(|a| {
                        a["type"] == "interaction_checkpoint"
                            && a["checkpointKind"] == "chapter_summary"
                    })
                })
                .map(|a| a["question"].clone());
            if let Some(question) = question {
                scene["metadata"]["nativeQuestionText"] = question;
            }
            scene["metadata"]["nativeNarrationText"] = json!(scene["actions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|a| a["type"] == "speech")
                .filter(|a| !scene["metadata"]["assessmentSpeechIds"]
                    .as_object()
                    .is_some_and(|ids| ids.values().any(|id| *id == a["id"])))
                .filter_map(|a| a["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n"));
        }
        validate_classroom(&classroom)?;
        validation::validate_workspace_assets(workspace, &classroom)?;
        Ok(
            json!({"projectId":next.project_id,"revision":uuid::Uuid::new_v4().to_string(),
            "sourceRevision":next.source.revision,"classroom":classroom}),
        )
    }

    fn classroom_project(
        &self,
        workspace: &str,
        project_id: &str,
    ) -> Result<(String, Option<CoursewareProject>)> {
        if let Some(project) = self.get_courseware_project(workspace, project_id)? {
            return Ok((project.source.revision.clone(), Some(project)));
        }
        let key = storage_key(workspace, project_id)?;
        let anchor = self
            .kv_get(ANCHORS, &key)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project is missing"))?;
        Ok((
            anchor["sourceRevision"]
                .as_str()
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: invalid classroom anchor"))?
                .to_owned(),
            None,
        ))
    }

    /// A native-file-free anchor for an independent Quiz-only course.
    pub fn create_courseware_classroom(
        &self,
        workspace: &str,
        session_id: &str,
        classroom: &Value,
    ) -> Result<Value> {
        validate_classroom(classroom)?;
        validation::validate_workspace_assets(workspace, classroom)?;
        invalid(
            classroom["scenes"].as_array().is_some_and(|scenes| {
                !scenes.is_empty() && scenes.iter().all(|s| s["type"] == "quiz")
            }),
            "native-free classrooms require Quiz scenes",
        )?;
        self.ensure_no_source_adoption(workspace)?;
        let mut task = self
            .kv_get("coursewareTask.v1", session_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: generation task is missing"))?;
        invalid(
            matches!(task["taskType"].as_str(), Some("scene" | "plain")),
            "classroom requires a generation task",
        )?;
        anyhow::ensure!(
            task.get("canonicalProjectId").is_none(),
            "COURSEWARE_CONFLICT: classroom already generated for session"
        );
        let project_id = uuid::Uuid::new_v4().to_string();
        let key = storage_key(workspace, &project_id)?;
        use sha2::Digest;
        let source_revision = format!(
            "sha256:{}",
            hex::encode(sha2::Sha256::digest(serde_json::to_vec(classroom)?))
        );
        let revision = uuid::Uuid::new_v4().to_string();
        let document = json!({"projectId":project_id,"revision":revision,"sourceRevision":source_revision,"classroom":classroom});
        task["canonicalProjectId"] = json!(project_id);
        let tx = self.conn.unchecked_transaction()?;
        self.kv_set(ANCHORS, &key, &json!({"projectId":project_id,"sourceRevision":source_revision,"sessionId":session_id}))?;
        self.kv_set(DOCUMENTS, &key, &document)?;
        self.kv_set(
            REVISIONS,
            &serde_json::to_string(&(&key, &revision))?,
            &document,
        )?;
        self.kv_set("coursewareTask.v1", session_id, &task)?;
        anyhow::ensure!(
            self.kv_get(ANCHORS, &key)?.is_some_and(
                |a| a["projectId"] == project_id && a["sourceRevision"] == source_revision
            ) && self.kv_get(DOCUMENTS, &key)?.as_ref() == Some(&document)
                && self
                    .kv_get(REVISIONS, &serde_json::to_string(&(&key, &revision))?)?
                    .as_ref()
                    == Some(&document)
                && self.kv_get("coursewareTask.v1", session_id)?.as_ref() == Some(&task),
            "COURSEWARE_CONFLICT: classroom initialization was not persisted"
        );
        tx.commit()?;
        Ok(document)
    }

    pub fn classroom_source_document(&self, workspace: &str, project_id: &str) -> Result<Value> {
        let (source_revision, _) = self.classroom_project(workspace, project_id)?;
        let key = storage_key(workspace, project_id)?;
        let stored = self.kv_get(DOCUMENTS, &key)?;
        if let Some(document) = &stored {
            validate_document(document, project_id)?;
        }
        Ok(stored.unwrap_or_else(|| json!({"projectId":project_id,"revision":null,"sourceRevision":source_revision,"classroom":null})))
    }

    pub fn courseware_classroom(
        &self,
        workspace: &str,
        project_id: &str,
        revision: Option<&str>,
    ) -> Result<Value> {
        let key = storage_key(workspace, project_id)?;
        let (source_revision, _) = self.classroom_project(workspace, project_id)?;
        let stored = if let Some(revision) = revision {
            invalid(valid_id(revision), "invalid revision")?;
            self.kv_get(REVISIONS, &serde_json::to_string(&(&key, revision))?)?
        } else {
            self.kv_get(DOCUMENTS, &key)?
        };
        if let Some(document) = &stored {
            validate_document(document, project_id)?;
        }
        if revision.is_some() {
            anyhow::ensure!(
                stored.is_some(),
                "COURSEWARE_NOT_FOUND: classroom revision is missing"
            );
        }
        if revision.is_none() {
            anyhow::ensure!(
                stored
                    .as_ref()
                    .is_none_or(|d| d["sourceRevision"] == source_revision),
                "COURSEWARE_CONFLICT: native source changed; regenerate classroom"
            );
        }
        Ok(stored.unwrap_or_else(|| json!({"projectId":project_id,"revision":null,"sourceRevision":source_revision,"classroom":null})))
    }

    /// Assessment identity comes from the current canonical scene, never the page ordinal.
    pub(crate) fn courseware_assessment_page_ids(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<std::collections::HashSet<String>> {
        // Stable page bindings survive native saves before the canonical canvas is refreshed.
        let document = self.classroom_source_document(workspace, &project.project_id)?;
        Ok(document["classroom"]["scenes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|scene| scene["metadata"]["nativeEmbeddedAssessments"] != true)
            .filter(|scene| {
                scene["type"] == "quiz"
                    || scene["actions"].as_array().is_some_and(|actions| {
                        actions.iter().any(|a| {
                            a["type"] == "interaction_checkpoint"
                                && a["checkpointKind"] == "chapter_summary"
                        })
                    })
            })
            .filter_map(|scene| scene["metadata"]["nativePageId"].as_str())
            .filter(|id| project.pages.iter().any(|page| page.page_id == *id))
            .map(str::to_owned)
            .collect())
    }

    pub(super) fn courseware_teaching_requirements(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<Option<Value>> {
        if project.task_type != "plain" {
            return self.courseware_scene_objects(workspace, project);
        }
        let document = self.classroom_source_document(workspace, &project.project_id)?;
        let mut pages = Vec::new();
        for page in &project.pages {
            let Some(scene) = document["classroom"]["scenes"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|scene| scene["metadata"]["nativePageId"] == page.page_id)
            else {
                continue;
            };
            let Some(teaching) = scene["metadata"].get("teachingRequirements") else {
                continue;
            };
            let parsed: scene_teaching::Teaching = serde_json::from_value(teaching.clone())?;
            anyhow::ensure!(
                parsed.valid(),
                "COURSEWARE_INVALID: invalid presentation teaching requirements"
            );
            pages.push(json!({"pageId":page.page_id,"teaching":teaching}));
        }
        Ok((!pages.is_empty()).then(|| json!({"pages":pages})))
    }

    pub fn write_courseware_classroom(
        &self,
        workspace: &str,
        project_id: &str,
        expected_revision: Option<&str>,
        expected_source_revision: &str,
        classroom: &Value,
    ) -> Result<Value> {
        self.write_classroom_document(
            workspace,
            project_id,
            expected_revision,
            expected_source_revision,
            classroom,
            false,
        )
    }

    /// Caller must verify the current saved parser job before authorizing a native rebind.
    pub(crate) fn refresh_courseware_classroom(
        &self,
        workspace: &str,
        project_id: &str,
        expected_revision: Option<&str>,
        expected_source_revision: &str,
        classroom: &Value,
    ) -> Result<Value> {
        self.write_classroom_document(
            workspace,
            project_id,
            expected_revision,
            expected_source_revision,
            classroom,
            true,
        )
    }

    fn write_classroom_document(
        &self,
        workspace: &str,
        project_id: &str,
        expected_revision: Option<&str>,
        expected_source_revision: &str,
        classroom: &Value,
        allow_source_refresh: bool,
    ) -> Result<Value> {
        self.ensure_no_source_adoption(workspace)?;
        self.ensure_no_native_save(workspace)?;
        let tx = self.conn.unchecked_transaction()?;
        let key = storage_key(workspace, project_id)?;
        let (source_revision, project) = self.classroom_project(workspace, project_id)?;
        anyhow::ensure!(
            source_revision == expected_source_revision,
            "COURSEWARE_CONFLICT: native source changed; reopen classroom"
        );
        let current = self.kv_get(DOCUMENTS, &key)?;
        if let Some(document) = &current {
            validate_document(document, project_id)?;
        }
        anyhow::ensure!(
            current.as_ref().and_then(|c| c["revision"].as_str()) == expected_revision,
            "COURSEWARE_CONFLICT: classroom changed; reload before saving"
        );
        anyhow::ensure!(
            allow_source_refresh
                || current
                    .as_ref()
                    .is_none_or(|d| d["sourceRevision"] == expected_source_revision),
            "COURSEWARE_CONFLICT: native source changed; explicit refresh is required"
        );
        if current.is_none() {
            anyhow::ensure!(
                project
                    .as_ref()
                    .is_none_or(|p| p.pages.iter().all(|p| !p.locked)),
                "COURSEWARE_LOCKED: unlock native pages before initializing classroom"
            );
        }
        if let (Some(current), Some(project)) = (&current, &project) {
            // Existing native page locks also protect their canonical scene content.
            let mapping = self.courseware_scene_objects(workspace, project)?;
            for page in project.pages.iter().filter(|p| p.locked) {
                let planned_id = mapping
                    .as_ref()
                    .and_then(|m| m["pages"].as_array())
                    .and_then(|pages| pages.iter().find(|p| p["pageId"] == page.page_id))
                    .and_then(|p| p["planPageId"].as_str())
                    .unwrap_or(&page.page_id);
                let find = |content: &Value| {
                    content["scenes"]
                        .as_array()
                        .and_then(|s| s.iter().find(|s| s["id"] == planned_id))
                        .cloned()
                };
                anyhow::ensure!(
                    find(&current["classroom"]) == find(classroom),
                    "COURSEWARE_LOCKED: canonical scene is locked"
                );
            }
        }
        let mut classroom = classroom.clone();
        if let Some(current) = &current {
            validation::invalidate_edited_audio(&current["classroom"], &mut classroom);
        }
        validate_classroom(&classroom)?;
        validation::validate_workspace_assets(workspace, &classroom)?;
        if let Some(current) = current {
            if current["sourceRevision"] == expected_source_revision
                && current["classroom"] == classroom
            {
                tx.commit()?;
                return Ok(current);
            }
        }
        let revision = uuid::Uuid::new_v4().to_string();
        let document = json!({"projectId":project_id,"revision":revision,"sourceRevision":expected_source_revision,"classroom":classroom});
        let encoded = serde_json::to_string(&document)?;
        let updated = tx.execute("INSERT INTO kv (ns,key,value_json,updated_at) VALUES (?1,?2,?3,?4) ON CONFLICT(ns,key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at", params![DOCUMENTS,key,encoded,now_ms()])?;
        let snapshotted = tx.execute(
            "INSERT INTO kv (ns,key,value_json,updated_at) VALUES (?1,?2,?3,?4)",
            params![
                REVISIONS,
                serde_json::to_string(&(&key, &revision))?,
                encoded,
                now_ms()
            ],
        )?;
        anyhow::ensure!(
            updated == 1 && snapshotted == 1,
            "COURSEWARE_CONFLICT: classroom revision was not persisted"
        );
        tx.commit()?;
        Ok(document)
    }
}

#[cfg(test)]
mod tests;
