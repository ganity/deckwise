use super::*;
use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};

#[tokio::test]
async fn chat_resolution_rpc_refuses_running_owner_and_forged_workspace_and_records_new_revision() {
    use crate::db::courseware_projects::chat_changes::{OperationRequest, Plan, PlanItem};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    let seed = SavedProjectSeed {
        project_id: "resolve-rpc".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    };
    let p = app
        .db
        .open_identified_courseware_project(root, &seed)
        .unwrap();
    let owner =
        sessions::create_session(&app.db, None, None, None, None, Some(root.into())).unwrap();
    app.db
        .declare_courseware_chat_plan(
            root,
            &p.project_id,
            OperationRequest {
                session_id: &owner.id,
                turn_id: "recorded-turn",
                tool_call_id: "plan",
                tool_name: "ppt_record_change_plan",
                args: &json!({}),
            },
            &Plan {
                tool_call_id: "plan".into(),
                page_id: p.pages[0].page_id.clone(),
                page_number: 1,
                edit_generation: 1,
                items: vec![PlanItem {
                    tool_name: "ppt_propose_page_narration".into(),
                    label: "Rewrite".into(),
                }],
            },
            &p.source.revision,
            &p.teaching_revision,
        )
        .unwrap();
    let context = app
        .db
        .courseware_project_context(root, &p.project_id)
        .unwrap();
    let c = &context["chatChanges"][0];
    let request = json!({"sessionId":owner.id,"projectId":p.project_id,"pageId":p.pages[0].page_id,
        "expectedSourceRevision":p.source.revision,"expectedTeachingRevision":p.teaching_revision,
        "resolution":{"changeGroupId":c["changeGroupId"],"receiptSha256":c["receiptSha256"],"note":"Reviewed; retain current teaching."}});
    let turn = sessions::begin_turn(&app.db, &owner.id, None, None).unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let call = |params| {
        super::super::handle_request(
            state.clone(),
            "courseware.teaching.confirm",
            params,
            tx.clone(),
        )
    };
    assert!(call(request.clone())
        .await
        .unwrap_err()
        .message
        .contains("Stop or finish"));
    sessions::end_turn(
        &state.lock().await.db,
        &turn,
        "completed",
        None,
        None,
        false,
    )
    .unwrap();
    let mut forged = request.clone();
    forged["workspace"] = json!("/foreign");
    assert_eq!(call(forged).await.unwrap_err().code, 1002);
    let confirmed = call(request.clone()).await.unwrap();
    assert_ne!(
        confirmed["project"]["teachingRevision"],
        p.teaching_revision
    );
    assert_eq!(
        confirmed["project"]["pages"][0]["actions"],
        json!(p.pages[0].actions)
    );
    assert!(call(request).await.is_err());
}

#[tokio::test]
async fn context_rpc_uses_persisted_workspace_requires_handshake_and_rejects_forged_fields() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    let second = dir.path().join("second");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    let seed = SavedProjectSeed {
        project_id: "context-rpc".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    };
    let project = app
        .db
        .open_identified_courseware_project(first.to_str().unwrap(), &seed)
        .unwrap();
    let a = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(first.to_string_lossy().into()),
    )
    .unwrap();
    let b = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(second.to_string_lossy().into()),
    )
    .unwrap();
    app.workspace.set(second.clone());
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let request = json!({"sessionId": a.id, "projectId": project.project_id});
    let call = |p: Value| {
        super::super::handle_request(state.clone(), "courseware.project.context", p, tx.clone())
    };
    assert_eq!(call(request.clone()).await.unwrap_err().code, 1001);
    state.lock().await.handshook = true;
    let actual = call(request.clone()).await.unwrap();
    assert_eq!(actual["project"], serde_json::to_value(&project).unwrap());
    assert_eq!(
        actual["mapping"]["pages"][0]["pageId"],
        project.pages[0].page_id
    );
    assert_eq!(
        call(json!({"sessionId":b.id,"projectId":project.project_id}))
            .await
            .unwrap_err()
            .code,
        1007
    );
    assert_eq!(
        call(json!({"sessionId":"missing","projectId":project.project_id}))
            .await
            .unwrap_err()
            .code,
        1007
    );
    for (key, value) in [
        ("workspace", json!(first)),
        ("mapping", actual["mapping"].clone()),
        ("pageId", json!(project.pages[0].page_id)),
        ("sourceSha256", json!(seed.sha256)),
    ] {
        let mut forged = request.clone();
        forged[key] = value;
        assert_eq!(call(forged).await.unwrap_err().code, 1002, "{key}");
    }
    assert_eq!(call(request).await.unwrap(), actual);
}
