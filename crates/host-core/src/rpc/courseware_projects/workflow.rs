use super::*;
use crate::db::courseware_projects::workflow::Checkpoint;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    session_id: String,
    project_id: String,
    #[serde(default)]
    turn_id: Option<String>,
    #[serde(default)]
    expected_revision: Option<u64>,
    #[serde(default)]
    checkpoint: Option<Checkpoint>,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let p: Params = serde_json::from_value(params)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    let state = state.lock().await;
    let root = project_workspace(&state, &p.session_id)?;
    let project = state
        .db
        .get_courseware_project(&root, &p.project_id)
        .map_err(error)?
        .ok_or_else(|| rpc_err(1007, "Workflow project missing", "COURSEWARE_NOT_FOUND"))?;
    if method == "courseware.workflow.checkpoint" {
        let next = p
            .checkpoint
            .filter(|c| c.project_id == p.project_id)
            .ok_or_else(|| rpc_err(1002, "Workflow checkpoint required", "INVALID_PARAMS"))?;
        let turn_id = p
            .turn_id
            .ok_or_else(|| rpc_err(1002, "Workflow turn required", "INVALID_PARAMS"))?;
        let expected = p
            .expected_revision
            .ok_or_else(|| rpc_err(1002, "Workflow revision required", "INVALID_PARAMS"))?;
        let checkpoint = state
            .db
            .save_courseware_workflow_checkpoint(&root, &p.session_id, &turn_id, expected, &next)
            .map_err(error)?;
        return Ok(json!({"checkpoint":checkpoint}));
    }
    if p.checkpoint.is_some() || p.expected_revision.is_some() || p.turn_id.is_some() {
        return Err(rpc_err(
            1002,
            "Workflow read cannot mutate a checkpoint",
            "INVALID_PARAMS",
        ));
    }
    Ok(
        json!({"checkpoint":state.db.courseware_workflow_checkpoint(&root, &p.session_id, &p.project_id).map_err(error)?,
        "completion":state.db.courseware_completion(&root, &project).map_err(error)?}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn workflow_rpc_keeps_reads_inert_and_fences_checkpoint_writes() {
        let dir = tempfile::tempdir().unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let root = dir
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let session =
            sessions::create_session(&app.db, None, None, None, None, Some(root.clone())).unwrap();
        let identity = crate::courseware::identity::SavedSourceIdentity::parse(include_bytes!(
            "../../courseware/identity/fixtures/identity.json"
        ))
        .unwrap();
        let project = app
            .db
            .open_identified_courseware_project(
                &root,
                &crate::courseware::SavedProjectSeed {
                    project_id: "workflow-rpc".into(),
                    sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
                    pages: 1,
                    identity: Some(identity),
                },
            )
            .unwrap();
        let turn = sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
        let state = Arc::new(Mutex::new(app));
        let (tx, _) = tokio::sync::mpsc::unbounded_channel();
        let args = json!({"sessionId":session.id,"projectId":project.project_id});
        let read = super::super::super::handle_request(
            state.clone(),
            "courseware.workflow.get",
            args.clone(),
            tx.clone(),
        )
        .await
        .unwrap();
        assert!(read["checkpoint"].is_null());
        assert_eq!(read["completion"]["ready"], false);
        let checkpoint = json!({"revision":1,"projectId":project.project_id,"sourceSha256":project.source.sha256,
            "status":"running","repairAttempts":{},"lastResume":null});
        let mut write = args.clone();
        write["checkpoint"] = checkpoint.clone();
        write["expectedRevision"] = json!(0);
        write["turnId"] = json!(turn);
        let saved = super::super::super::handle_request(
            state.clone(),
            "courseware.workflow.checkpoint",
            write.clone(),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(saved["checkpoint"], checkpoint);
        assert!(super::super::super::handle_request(
            state.clone(),
            "courseware.workflow.checkpoint",
            write.clone(),
            tx.clone()
        )
        .await
        .is_err());
        assert!(super::super::super::handle_request(
            state.clone(),
            "courseware.workflow.get",
            write,
            tx.clone()
        )
        .await
        .is_err());
        let mut forged = args.clone();
        forged["workspace"] = json!("/foreign");
        assert!(super::super::super::handle_request(
            state.clone(),
            "courseware.workflow.get",
            forged,
            tx.clone()
        )
        .await
        .is_err());
        state
            .lock()
            .await
            .db
            .conn
            .execute("UPDATE turns SET status='aborted' WHERE id=?1", [&turn])
            .unwrap();
        let mut late = args;
        late["checkpoint"] = checkpoint;
        late["checkpoint"]["revision"] = json!(2);
        late["expectedRevision"] = json!(1);
        late["turnId"] = json!(turn);
        assert!(super::super::super::handle_request(
            state.clone(),
            "courseware.workflow.checkpoint",
            late,
            tx
        )
        .await
        .is_err());
    }
}
