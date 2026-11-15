use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Read {
    session_id: String,
    project_id: String,
    revision: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Write {
    session_id: String,
    project_id: String,
    expected_revision: Option<String>,
    expected_source_revision: String,
    classroom: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Create {
    session_id: String,
    classroom: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    session_id: String,
    project_id: String,
    job_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Refresh {
    session_id: String,
    project_id: String,
    job_id: String,
    expected_revision: Option<String>,
    expected_source_revision: String,
    classroom: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaScope {
    session_id: String,
    project_id: String,
    expected_revision: String,
    expected_source_revision: String,
}
pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let invalid = |e: serde_json::Error| rpc_err(1002, e.to_string(), "INVALID_PARAMS");
    if method == "courseware.classroom.mediaScope" {
        let p: MediaScope = serde_json::from_value(params).map_err(invalid)?;
        let state = state.lock().await;
        let root = workspace(&state, &p.session_id)?;
        if sessions::session_mode(&state.db, &p.session_id)
            .map_err(error)?
            .as_deref()
            != Some("agent")
        {
            return Err(rpc_err(
                1003,
                "Classroom media submission requires Agent mode",
                "PERMISSION_DENIED",
            ));
        }
        let document = state
            .db
            .courseware_classroom(&root, &p.project_id, None)
            .map_err(error)?;
        if document["revision"] != p.expected_revision
            || document["sourceRevision"] != p.expected_source_revision
            || document["classroom"].is_null()
        {
            return Err(rpc_err(
                1008,
                "Classroom changed before media admission",
                "COURSEWARE_CONFLICT",
            ));
        }
        state
            .db
            .courseware_media_submission_scope(&p.session_id)
            .map(|scope| json!(scope))
            .map_err(error)
    } else if method == "courseware.classroom.refresh" {
        if !params
            .as_object()
            .is_some_and(|p| p.contains_key("expectedRevision"))
        {
            return Err(rpc_err(
                1002,
                "expectedRevision is required",
                "INVALID_PARAMS",
            ));
        }
        let p: Refresh = serde_json::from_value(params).map_err(invalid)?;
        let state = state.lock().await;
        let root = workspace(&state, &p.session_id)?;
        let project = state
            .db
            .get_courseware_project(&root, &p.project_id)
            .map_err(error)?
            .ok_or_else(|| rpc_err(1007, "Native project not found", "COURSEWARE_NOT_FOUND"))?;
        let seed = state
            .courseware
            .saved_project_seed(&p.job_id, Path::new(&root))
            .map_err(error)?;
        if seed.project_id != p.project_id
            || seed.sha256 != project.source.sha256
            || project.source.revision != p.expected_source_revision
        {
            return Err(rpc_err(
                1008,
                "Native source changed",
                "COURSEWARE_CONFLICT",
            ));
        }
        state
            .courseware
            .classroom_source(&p.job_id, Path::new(&root))
            .map_err(error)?;
        state
            .db
            .refresh_courseware_classroom(
                &root,
                &p.project_id,
                p.expected_revision.as_deref(),
                &p.expected_source_revision,
                &p.classroom,
            )
            .map_err(error)
    } else if method == "courseware.classroom.source" {
        let p: Source = serde_json::from_value(params).map_err(invalid)?;
        let state = state.lock().await;
        let root = workspace(&state, &p.session_id)?;
        let project = state
            .db
            .get_courseware_project(&root, &p.project_id)
            .map_err(error)?
            .ok_or_else(|| rpc_err(1007, "Native project not found", "COURSEWARE_NOT_FOUND"))?;
        let seed = state
            .courseware
            .saved_project_seed(&p.job_id, Path::new(&root))
            .map_err(error)?;
        if seed.project_id != p.project_id || seed.sha256 != project.source.sha256 {
            return Err(rpc_err(
                1008,
                "Native source changed",
                "COURSEWARE_CONFLICT",
            ));
        }
        let mut source = state
            .courseware
            .classroom_source(&p.job_id, Path::new(&root))
            .map_err(error)?;
        let stored = state
            .db
            .classroom_source_document(&root, &p.project_id)
            .map_err(error)?;
        let context = state
            .db
            .courseware_project_context(&root, &p.project_id)
            .map_err(error)?;
        for (key, value) in stored.as_object().unwrap() {
            source[key] = value.clone();
        }
        source["currentSourceRevision"] = json!(project.source.revision);
        // The current saved identity owns page order; generation mappings become stale after edits.
        source["mapping"] = context["mapping"].clone();
        if let Some(pages) = source["mapping"]["pages"].as_array_mut() {
            for page in pages {
                if let Some(original) = context["sceneObjects"]["pages"]
                    .as_array()
                    .and_then(|items| items.iter().find(|item| item["pageId"] == page["pageId"]))
                {
                    if original["planPageId"].is_string() {
                        page["planPageId"] = original["planPageId"].clone();
                    }
                }
            }
        }
        source["project"] = json!(project);
        let mut assets = source["assets"].as_array().cloned().unwrap_or_default();
        // Use the same provenance checks as editable-course export, including generated media.
        let media = state
            .db
            .portable_courseware_content(
                &root,
                &seed,
                &project.source.revision,
                &project.teaching_revision,
            )
            .map_err(error)?
            .media;
        for asset in media {
            let (path, size) =
                crate::courseware::snapshot_assets::verify(&state.data_dir, &asset.sha256)
                    .map_err(error)?;
            if size != asset.byte_length {
                return Err(rpc_err(1008, "Native media changed", "COURSEWARE_CONFLICT"));
            }
            assets.push(json!({"id":asset.id,"path":path,"sha256":asset.sha256,
                "mimeType":asset.mime_type,"durationMs":asset.duration_ms}));
        }
        source["assets"] = json!(assets);
        Ok(source)
    } else if method == "courseware.classroom.create" {
        let p: Create = serde_json::from_value(params).map_err(invalid)?;
        let state = state.lock().await;
        let root = workspace(&state, &p.session_id)?;
        state
            .db
            .create_courseware_classroom(&root, &p.session_id, &p.classroom)
            .map_err(error)
    } else if method == "courseware.classroom.write" {
        if !params
            .as_object()
            .is_some_and(|p| p.contains_key("expectedRevision"))
        {
            return Err(rpc_err(
                1002,
                "expectedRevision is required",
                "INVALID_PARAMS",
            ));
        }
        let p: Write = serde_json::from_value(params).map_err(invalid)?;
        let state = state.lock().await;
        let root = workspace(&state, &p.session_id)?;
        state
            .db
            .write_courseware_classroom(
                &root,
                &p.project_id,
                p.expected_revision.as_deref(),
                &p.expected_source_revision,
                &p.classroom,
            )
            .map_err(error)
    } else {
        let p: Read = serde_json::from_value(params).map_err(invalid)?;
        if method == "courseware.classroom.snapshot" && p.revision.is_none() {
            return Err(rpc_err(
                1002,
                "snapshot revision is required",
                "INVALID_PARAMS",
            ));
        }
        let state = state.lock().await;
        let root = workspace(&state, &p.session_id)?;
        state
            .db
            .courseware_classroom(&root, &p.project_id, p.revision.as_deref())
            .map_err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn canonical_rpc_uses_persisted_workspace_strict_params_and_revision_cas() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let app = AppState::open(dir.path()).unwrap();
        let session = sessions::create_session(
            &app.db,
            None,
            None,
            None,
            None,
            Some(workspace.to_string_lossy().into()),
        )
        .unwrap();
        app.db
            .kv_set(TASK_NAMESPACE, &session.id, &json!({"taskType":"scene"}))
            .unwrap();
        let value = json!({"id":"c","createdAt":"2026-11-04","stage":{"id":"s","name":"Quiz","createdAt":1,"updatedAt":1},"scenes":[{"id":"quiz","stageId":"s","title":"Quiz","type":"quiz","order":0,"content":{"type":"quiz","questions":[{"id":"q","type":"short_answer","question":"Question","referenceAnswer":"Reference"}]}}]});
        let create = json!({"sessionId":session.id,"classroom":value});
        let state = Arc::new(Mutex::new(app));
        let (tx, _rx) = mpsc::unbounded_channel();
        assert!(crate::rpc::handle_request(
            state.clone(),
            "courseware.classroom.create",
            create.clone(),
            tx.clone()
        )
        .await
        .is_err());
        state.lock().await.handshook = true;
        let result = crate::rpc::handle_request(
            state.clone(),
            "courseware.classroom.create",
            create,
            tx.clone(),
        )
        .await
        .unwrap();
        let read = json!({"sessionId":session.id,"projectId":result["projectId"]});
        assert_eq!(
            crate::rpc::handle_request(
                state.clone(),
                "courseware.classroom.get",
                read.clone(),
                tx.clone()
            )
            .await
            .unwrap(),
            result
        );
        let mut forged = read.clone();
        forged["workspace"] = json!(workspace);
        assert!(crate::rpc::handle_request(
            state.clone(),
            "courseware.classroom.get",
            forged,
            tx.clone()
        )
        .await
        .is_err());
        let mut missing = read.clone();
        missing["sessionId"] = json!("unknown");
        assert!(crate::rpc::handle_request(
            state.clone(),
            "courseware.classroom.get",
            missing,
            tx.clone()
        )
        .await
        .is_err());
        let mut write = json!({"sessionId":session.id,"projectId":result["projectId"],"expectedSourceRevision":result["sourceRevision"],"classroom":value});
        assert!(crate::rpc::handle_request(
            state.clone(),
            "courseware.classroom.write",
            write.clone(),
            tx.clone()
        )
        .await
        .is_err());
        write["expectedRevision"] = result["revision"].clone();
        write["classroom"]["scenes"][0]["content"]["questions"][0]["question"] =
            json!("Updated question");
        let saved = crate::rpc::handle_request(
            state.clone(),
            "courseware.classroom.write",
            write.clone(),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_ne!(saved["revision"], result["revision"]);
        let scope = json!({"sessionId":session.id,"projectId":saved["projectId"],"expectedRevision":saved["revision"],"expectedSourceRevision":saved["sourceRevision"]});
        assert_eq!(
            crate::rpc::handle_request(
                state.clone(),
                "courseware.classroom.mediaScope",
                scope.clone(),
                tx.clone()
            )
            .await
            .unwrap(),
            json!({"sessionId":session.id,"teamProjectId":null})
        );
        let mut stale_scope = scope.clone();
        stale_scope["expectedRevision"] = result["revision"].clone();
        assert!(crate::rpc::handle_request(
            state.clone(),
            "courseware.classroom.mediaScope",
            stale_scope,
            tx.clone()
        )
        .await
        .is_err());
        state
            .lock()
            .await
            .db
            .conn
            .execute("UPDATE sessions SET mode='plan' WHERE id=?1", [&session.id])
            .unwrap();
        assert_eq!(
            crate::rpc::handle_request(
                state.clone(),
                "courseware.classroom.mediaScope",
                scope,
                tx.clone()
            )
            .await
            .unwrap_err()
            .code,
            1003
        );

        assert!(crate::rpc::handle_request(
            state.clone(),
            "courseware.classroom.write",
            write,
            tx.clone()
        )
        .await
        .is_err());
        assert!(crate::rpc::handle_request(
            state.clone(),
            "courseware.task.set",
            json!({"sessionId":session.id,"taskType":"plain"}),
            tx
        )
        .await
        .is_err());
    }
}
