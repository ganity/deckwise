use super::*;
use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};
use crate::db::courseware_projects::{snapshots::Asset, TeachingWrite};

#[tokio::test]
async fn unresolved_declared_chat_blocks_new_publication_without_erasing_existing_snapshot() {
    use crate::db::courseware_projects::chat_changes::{
        OperationRequest, Plan, PlanItem, ResolutionRequest,
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let (state, session, selection) = setup(dir.path());
    let request = json!({"sessionId":session,"principalKey":"a".repeat(64),"selection":selection});
    let project = {
        let state = state.lock().await;
        let p = state
            .db
            .get_courseware_project(root, "office-share-test")
            .unwrap()
            .unwrap();
        state
            .db
            .declare_courseware_chat_plan(
                root,
                &p.project_id,
                OperationRequest {
                    session_id: &session,
                    turn_id: "turn",
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
        p
    };
    let error = call(
        state.clone(),
        "courseware.fixedShare.prepare",
        request.clone(),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("unresolved Chat"));
    assert!(call(
        state.clone(),
        "courseware.fixedShare.get",
        json!({"sessionId":session,"principalKey":"a".repeat(64)})
    )
    .await
    .unwrap()["intent"]
        .is_null());
    {
        let state = state.lock().await;
        assert!(state
            .db
            .get_courseware_snapshot(root, &project.project_id, "snapshot-1")
            .is_ok());
        let c = state
            .db
            .courseware_project_context(root, &project.project_id)
            .unwrap()["chatChanges"][0]
            .clone();
        state
            .db
            .resolve_courseware_chat_change(
                root,
                &session,
                &project.project_id,
                &project.pages[0].page_id,
                &project.source.revision,
                &project.teaching_revision,
                &ResolutionRequest {
                    change_group_id: c["changeGroupId"].as_str().unwrap().into(),
                    receipt_sha256: c["receiptSha256"].as_str().unwrap().into(),
                    note: "Reviewed; retain fixed version.".into(),
                },
            )
            .unwrap();
    }
    assert!(call(state, "courseware.fixedShare.prepare", request)
        .await
        .unwrap()["intent"]
        .is_object());
}

fn setup(dir: &Path) -> (Arc<Mutex<AppState>>, String, Value) {
    let mut app = AppState::open(dir).unwrap();
    app.handshook = true;
    let root = dir.to_str().unwrap();
    let session =
        sessions::create_session(&app.db, None, None, None, None, Some(root.into())).unwrap();
    app.db
        .kv_set(TASK_NAMESPACE, &session.id, &json!({ "taskType": "plain" }))
        .unwrap();
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    let seed = SavedProjectSeed {
        project_id: "office-share-test".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    };
    let p = app
        .db
        .open_identified_courseware_project(root, &seed)
        .unwrap();
    let p = app.db.write_courseware_teaching(root, &TeachingWrite { project_id: p.project_id,
        page_id: p.pages[0].page_id.clone(), expected_source_revision: p.source.revision,
        expected_teaching_revision: p.teaching_revision,
        actions: vec![json!({ "id": "speech-1", "type": "speech", "text": "Good!", "audioAssetId": "voice-1" })] }).unwrap();
    let p = app
        .db
        .review_courseware_page(
            root,
            &p.project_id,
            &p.pages[0].page_id,
            &p.source.revision,
            &p.teaching_revision,
        )
        .unwrap();
    app.db
        .capture_courseware_snapshot(
            root,
            &seed,
            "snapshot-1",
            &p.source.revision,
            &p.teaching_revision,
            vec![Asset {
                id: "voice-1".into(),
                sha256: "a".repeat(64),
                mime_type: "audio/wav".into(),
            }],
        )
        .unwrap();
    let selection = json!({ "projectId": p.project_id, "snapshotId": "snapshot-1", "buildId": "b".repeat(64),
        "manifestSha256": "c".repeat(64), "teamProjectId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "channel": "formal" });
    (Arc::new(Mutex::new(app)), session.id, selection)
}

async fn call(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let (tx, _) = mpsc::unbounded_channel();
    super::super::handle_request(state, method, params, tx).await
}

fn setup_online(dir: &Path) -> (Arc<Mutex<AppState>>, String, Value) {
    let (state, session, mut selection) = setup(dir);
    let root = dir.to_str().unwrap();
    {
        let app = state.try_lock().unwrap();
        let record = app
            .db
            .get_courseware_snapshot(root, "office-share-test", "snapshot-1")
            .unwrap();
        let mut project = record.project.clone();
        project.project_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into();
        project.source.revision = "33333333-3333-4333-8333-333333333333".into();
        project.teaching_revision = "online-teaching-1".into();
        let mut mapping = record.mapping();
        mapping["sourceRevision"] = json!(project.source.revision);
        let parsed = crate::courseware::source_candidates::ParsedOutput {
            sha256: record.snapshot.source.sha256,
            pages: project.pages.len(),
            identity: Some(
                SavedSourceIdentity::parse(include_bytes!(
                    "../../courseware/identity/fixtures/identity.json"
                ))
                .unwrap()
                .value()
                .clone(),
            ),
        };
        app.db
            .import_online_courseware_snapshot(
                root,
                &parsed,
                "online-snapshot",
                project,
                &mapping,
                record.assets,
            )
            .unwrap();
        app.db.kv_delete(TASK_NAMESPACE, &session).unwrap();
    }
    selection["projectId"] = selection["teamProjectId"].clone();
    selection["snapshotId"] = json!("online-snapshot");
    (state, session, selection)
}

#[tokio::test]
async fn online_snapshot_can_publish_to_original_team_after_restart_without_a_local_task() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session, selection) = setup_online(dir.path());
    let origin = json!({"sessionId":session,"projectId":selection["projectId"],"snapshotId":selection["snapshotId"]});
    assert_eq!(
        call(
            state.clone(),
            "courseware.snapshot.onlineOrigin",
            origin.clone()
        )
        .await
        .unwrap(),
        json!({"teamProjectId":selection["teamProjectId"]})
    );
    let saved = call(
        state.clone(),
        "courseware.fixedShare.prepare",
        json!({"sessionId":session,
        "principalKey":"a".repeat(64),"selection":selection,"receiptAware":true}),
    )
    .await
    .unwrap();
    assert_eq!(saved["intent"]["state"], "unknown");
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(
        call(state.clone(), "courseware.snapshot.onlineOrigin", origin)
            .await
            .unwrap(),
        json!({"teamProjectId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"})
    );
    let complete = json!({"sessionId":session,"principalKey":"a".repeat(64),"intentId":saved["intent"]["intentId"]});
    let bound = call(
        state.clone(),
        "courseware.fixedShare.complete",
        complete.clone(),
    )
    .await
    .unwrap();
    assert_eq!(bound["intent"]["state"], "bound");
    assert_eq!(bound["intent"]["selection"], saved["intent"]["selection"]);
    assert_eq!(
        call(state.clone(), "courseware.fixedShare.complete", complete)
            .await
            .unwrap(),
        bound
    );
    let app = state.lock().await;
    assert!(app.db.kv_get(TASK_NAMESPACE, &session).unwrap().is_none());
    assert!(app
        .db
        .get_courseware_project(
            dir.path().to_str().unwrap(),
            "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        )
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn online_snapshot_rejects_another_team_without_journaling_and_preserves_unrelated_local_task(
) {
    let dir = tempfile::tempdir().unwrap();
    let (state, session, selection) = setup_online(dir.path());
    let local = json!({"taskType":"scene","teamProjectId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","instruction":"Keep me"});
    state
        .lock()
        .await
        .db
        .kv_set(TASK_NAMESPACE, &session, &local)
        .unwrap();
    let mut foreign = selection.clone();
    foreign["teamProjectId"] = local["teamProjectId"].clone();
    let error = call(
        state.clone(),
        "courseware.fixedShare.prepare",
        json!({"sessionId":session,
        "principalKey":"a".repeat(64),"selection":foreign}),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("original team"));
    assert!(call(
        state.clone(),
        "courseware.fixedShare.get",
        json!({"sessionId":session,"principalKey":"a".repeat(64)})
    )
    .await
    .unwrap()["intent"]
        .is_null());
    let saved = call(
        state.clone(),
        "courseware.fixedShare.prepare",
        json!({"sessionId":session,
        "principalKey":"a".repeat(64),"selection":selection}),
    )
    .await
    .unwrap();
    call(
        state.clone(),
        "courseware.fixedShare.complete",
        json!({"sessionId":session,"principalKey":"a".repeat(64),
        "intentId":saved["intent"]["intentId"]}),
    )
    .await
    .unwrap();
    assert_eq!(
        state
            .lock()
            .await
            .db
            .kv_get(TASK_NAMESPACE, &session)
            .unwrap()
            .unwrap(),
        local
    );
}

#[tokio::test]
async fn missing_or_corrupted_online_origin_never_bypasses_local_task_requirements() {
    for corrupt in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let (state, session, selection) = setup_online(dir.path());
        {
            let app = state.lock().await;
            let key: String = app
                .db
                .conn()
                .query_row(
                    "SELECT key FROM kv WHERE ns='coursewareOnlineSnapshots.v1'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            if corrupt {
                app.db
                    .kv_set(
                        "coursewareOnlineSnapshots.v1",
                        &key,
                        &json!({"projectId":"forged"}),
                    )
                    .unwrap();
            } else {
                app.db
                    .kv_delete("coursewareOnlineSnapshots.v1", &key)
                    .unwrap();
            }
        }
        drop(state);
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let state = Arc::new(Mutex::new(app));
        let origin = call(
            state.clone(),
            "courseware.snapshot.onlineOrigin",
            json!({"sessionId":session,
            "projectId":selection["projectId"],"snapshotId":selection["snapshotId"]}),
        )
        .await;
        if corrupt {
            assert!(origin.is_err());
        } else {
            assert_eq!(origin.unwrap(), json!({"teamProjectId":null}));
        }
        assert!(call(
            state.clone(),
            "courseware.fixedShare.prepare",
            json!({"sessionId":session,
            "principalKey":"a".repeat(64),"selection":selection})
        )
        .await
        .is_err());
        assert!(call(
            state.clone(),
            "courseware.fixedShare.get",
            json!({"sessionId":session,"principalKey":"a".repeat(64)})
        )
        .await
        .unwrap()["intent"]
            .is_null());
        assert!(state
            .lock()
            .await
            .db
            .kv_get(TASK_NAMESPACE, &session)
            .unwrap()
            .is_none());
    }
}

#[tokio::test]
async fn unknown_intent_survives_restart_and_blocks_new_publication_identity() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session_id, selection) = setup(dir.path());
    let params = json!({ "sessionId": session_id, "principalKey": "a".repeat(64) });
    let mut prepare = params.clone();
    prepare["selection"] = selection;
    let saved = call(
        state.clone(),
        "courseware.fixedShare.prepare",
        prepare.clone(),
    )
    .await
    .unwrap();
    assert_eq!(saved["intent"]["state"], "unknown");
    assert_eq!(saved["intent"]["receiptAware"], false);
    assert!(state
        .lock()
        .await
        .db
        .kv_get(TASK_NAMESPACE, &session_id)
        .unwrap()
        .unwrap()
        .get("teamProjectId")
        .is_none());
    let key = serde_json::to_string(&(dir.path().to_str().unwrap(), &session_id, "a".repeat(64)))
        .unwrap();
    let mut legacy = saved["intent"].clone();
    legacy.as_object_mut().unwrap().remove("receiptAware");
    state
        .lock()
        .await
        .db
        .kv_set(NAMESPACE, &key, &legacy)
        .unwrap();
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(
        call(state.clone(), "courseware.fixedShare.get", params.clone())
            .await
            .unwrap(),
        saved
    );
    prepare["selection"]["teamProjectId"] = json!("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert!(
        call(state.clone(), "courseware.fixedShare.prepare", prepare)
            .await
            .unwrap_err()
            .message
            .contains("unknown")
    );
    let mut other = params;
    other["principalKey"] = json!("f".repeat(64));
    assert!(call(state, "courseware.fixedShare.get", other)
        .await
        .unwrap()["intent"]
        .is_null());
}

#[tokio::test]
async fn receipt_aware_intent_survives_restart_and_cannot_be_reclassified_by_get_or_complete() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session_id, selection) = setup(dir.path());
    let base = json!({ "sessionId": session_id, "principalKey": "a".repeat(64) });
    let mut prepare = base.clone();
    prepare["selection"] = selection;
    prepare["receiptAware"] = json!(true);
    let saved = call(state.clone(), "courseware.fixedShare.prepare", prepare)
        .await
        .unwrap();
    assert_eq!(saved["intent"]["receiptAware"], true);
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(
        call(state.clone(), "courseware.fixedShare.get", base.clone())
            .await
            .unwrap(),
        saved
    );
    for value in [json!(true), json!(false), Value::Null] {
        let mut forged = base.clone();
        forged["receiptAware"] = value;
        assert!(
            call(state.clone(), "courseware.fixedShare.get", forged.clone())
                .await
                .is_err()
        );
        forged["intentId"] = saved["intent"]["intentId"].clone();
        assert!(
            call(state.clone(), "courseware.fixedShare.complete", forged)
                .await
                .is_err()
        );
    }
    let mut complete = base;
    complete["intentId"] = saved["intent"]["intentId"].clone();
    let bound = call(state, "courseware.fixedShare.complete", complete)
        .await
        .unwrap();
    assert_eq!(bound["intent"]["receiptAware"], true);
    assert_eq!(bound["intent"]["state"], "bound");
}

#[tokio::test]
async fn completion_binds_atomically_and_cannot_replace_another_team() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session_id, selection) = setup(dir.path());
    let base = json!({ "sessionId": session_id, "principalKey": "a".repeat(64) });
    let mut prepare = base.clone();
    prepare["selection"] = selection;
    let saved = call(state.clone(), "courseware.fixedShare.prepare", prepare)
        .await
        .unwrap();
    let mut complete = base.clone();
    complete["intentId"] = saved["intent"]["intentId"].clone();
    let foreign =
        json!({ "taskType": "plain", "teamProjectId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    state
        .lock()
        .await
        .db
        .kv_set(TASK_NAMESPACE, &session_id, &foreign)
        .unwrap();
    assert!(call(
        state.clone(),
        "courseware.fixedShare.complete",
        complete.clone()
    )
    .await
    .is_err());
    assert_eq!(
        call(state.clone(), "courseware.fixedShare.get", base.clone())
            .await
            .unwrap(),
        saved
    );
    assert_eq!(
        state
            .lock()
            .await
            .db
            .kv_get(TASK_NAMESPACE, &session_id)
            .unwrap()
            .unwrap(),
        foreign
    );
    state
        .lock()
        .await
        .db
        .kv_set(TASK_NAMESPACE, &session_id, &json!({ "taskType": "plain" }))
        .unwrap();
    let bound = call(
        state.clone(),
        "courseware.fixedShare.complete",
        complete.clone(),
    )
    .await
    .unwrap();
    assert_eq!(bound["intent"]["state"], "bound");
    assert_eq!(
        call(state.clone(), "courseware.fixedShare.complete", complete)
            .await
            .unwrap(),
        bound
    );
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    assert_eq!(
        app.db.kv_get(TASK_NAMESPACE, &session_id).unwrap().unwrap()["teamProjectId"],
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    );
    assert_eq!(
        call(Arc::new(Mutex::new(app)), "courseware.fixedShare.get", base)
            .await
            .unwrap(),
        bound
    );
}

#[tokio::test]
async fn forged_snapshot_missing_task_and_extra_fields_never_create_an_intent() {
    let dir = tempfile::tempdir().unwrap();
    let (state, session_id, selection) = setup(dir.path());
    let base = json!({ "sessionId": session_id, "principalKey": "a".repeat(64) });
    for field in [
        "snapshotId",
        "projectId",
        "buildId",
        "manifestSha256",
        "channel",
    ] {
        let mut request = base.clone();
        request["selection"] = selection.clone();
        request["selection"][field] = json!("forged");
        assert!(
            call(state.clone(), "courseware.fixedShare.prepare", request)
                .await
                .is_err()
        );
    }
    let mut request = base.clone();
    request["selection"] = selection;
    request["path"] = json!("/private/forged");
    assert!(call(
        state.clone(),
        "courseware.fixedShare.prepare",
        request.clone()
    )
    .await
    .is_err());
    request.as_object_mut().unwrap().remove("path");
    state
        .lock()
        .await
        .db
        .kv_delete(TASK_NAMESPACE, &session_id)
        .unwrap();
    assert!(
        call(state.clone(), "courseware.fixedShare.prepare", request)
            .await
            .is_err()
    );
    assert!(call(state, "courseware.fixedShare.get", base)
        .await
        .unwrap()["intent"]
        .is_null());
}
