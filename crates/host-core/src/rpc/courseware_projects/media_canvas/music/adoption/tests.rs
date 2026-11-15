use super::super::tests::{call, candidates, fixture, op, submitted, task, CANDIDATE};
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};

async fn exported() -> (tempfile::TempDir, Arc<Mutex<AppState>>, Value, Value) {
    let (dir, state, prepare, _) = fixture().await;
    let (_, reference) = submitted(&state, &prepare).await;
    call(
        &state,
        "candidates.record",
        candidates(&prepare, &reference, true),
    )
    .await
    .unwrap();
    let export = json!({"sessionId":prepare["sessionId"],"principalKey":prepare["principalKey"],"intentId":"export-adopt",
        "sourceIntentId":prepare["intentId"],"candidateId":CANDIDATE,"model":"mp3"});
    let intent = call(&state, "export.prepare", export.clone())
        .await
        .unwrap();
    call(&state, "begin", op(&export)).await.unwrap();
    let reference = task(&intent, "export-task");
    let mut binding = op(&export);
    binding["taskRef"] = reference.clone();
    call(&state, "bind", binding).await.unwrap();
    let bytes = b"ID3-exported-music-adoption";
    let mut archive = op(&export);
    archive["asset"] = json!({"taskRef":reference,"sha256":hex::encode(Sha256::digest(bytes)),"mimeType":"audio/mpeg","byteLength":bytes.len()});
    archive["bytesBase64"] = json!(STANDARD.encode(bytes));
    let archived = call(&state, "asset.stage", archive).await.unwrap();
    let project = state
        .lock()
        .await
        .db
        .get_courseware_project(dir.path().to_str().unwrap(), "course-01")
        .unwrap()
        .unwrap();
    let selection = json!({"sessionId":export["sessionId"],"principalKey":export["principalKey"],"intentId":export["intentId"],
        "projectId":project.project_id,"pageId":project.pages[0].page_id,"expectedSourceRevision":project.source.revision,
        "expectedTeachingRevision":project.teaching_revision,"durationMs":1234});
    (dir, state, selection, archived)
}

fn snapshot(selection: &Value, revision: &Value) -> Value {
    json!({"sessionId":selection["sessionId"],"principalKey":selection["principalKey"],"projectId":selection["projectId"],
        "expectedSourceRevision":selection["expectedSourceRevision"],"expectedTeachingRevision":revision})
}

#[tokio::test]
async fn music_adoption_appends_once_with_durable_scope_and_snapshot_provenance() {
    let (dir, state, selection, archived) = exported().await;
    let before = state
        .lock()
        .await
        .db
        .get_courseware_project(dir.path().to_str().unwrap(), "course-01")
        .unwrap()
        .unwrap();
    let adopted = call(&state, "adopt", selection.clone()).await.unwrap();
    assert_eq!(
        adopted["project"]["pages"][0]["actions"][0],
        serde_json::to_value(&before.pages[0].actions[0]).unwrap()
    );
    let clip = adopted["project"]["pages"][0]["actions"]
        .as_array()
        .unwrap()
        .last()
        .unwrap();
    assert_eq!(clip.as_object().unwrap().len(), 3);
    assert_eq!(clip["type"], "audio_clip");
    assert_eq!(
        clip["audioAssetId"],
        format!(
            "music-{}",
            archived["intent"]["asset"]["sha256"].as_str().unwrap()
        )
    );
    assert_eq!(
        adopted,
        call(&state, "adopt", selection.clone()).await.unwrap()
    );
    let mut current_pin = selection.clone();
    current_pin["expectedTeachingRevision"] = adopted["project"]["teachingRevision"].clone();
    assert_eq!(adopted, call(&state, "adopt", current_pin).await.unwrap());
    let snapshot_input = snapshot(&selection, &adopted["project"]["teachingRevision"]);
    let assets = call(&state, "snapshotAssets", snapshot_input.clone())
        .await
        .unwrap();
    assert_eq!(assets["assets"][0]["asset"]["id"], clip["audioAssetId"]);
    assert_eq!(
        assets["assets"][0]["music"]["intentId"],
        selection["intentId"]
    );
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(
        assets,
        call(&state, "snapshotAssets", snapshot_input.clone())
            .await
            .unwrap()
    );
    assert_eq!(
        adopted,
        call(&state, "adopt", selection.clone()).await.unwrap()
    );
    let mut foreign = snapshot_input;
    foreign["principalKey"] = json!("b".repeat(64));
    assert!(call(&state, "snapshotAssets", foreign).await.is_err());
    let mut forged = selection.clone();
    forged["durationMs"] = json!(2000);
    assert!(call(&state, "adopt", forged).await.is_err());
    let mut forged = selection;
    forged["pageId"] = json!("another-page");
    assert!(call(&state, "adopt", forged).await.is_err());
}

#[tokio::test]
async fn music_adoption_refuses_stale_lock_preview_scope_and_invalid_duration() {
    let (dir, state, selection, _) = exported().await;
    for (field, value) in [
        ("durationMs", json!(0)),
        ("durationMs", json!(86_400_001)),
        ("expectedTeachingRevision", json!("stale")),
        ("expectedSourceRevision", json!("stale")),
        ("intentId", json!("music-1")),
        ("principalKey", json!("b".repeat(64))),
        ("projectId", json!("missing")),
        ("sessionId", json!("missing")),
    ] {
        let mut changed = selection.clone();
        changed[field] = value;
        assert!(call(&state, "adopt", changed).await.is_err(), "{field}");
    }
    let locked = {
        let app = state.lock().await;
        app.db
            .set_courseware_page_lock(
                dir.path().to_str().unwrap(),
                "course-01",
                selection["pageId"].as_str().unwrap(),
                selection["expectedSourceRevision"].as_str().unwrap(),
                selection["expectedTeachingRevision"].as_str().unwrap(),
                true,
            )
            .unwrap()
    };
    let mut current = selection.clone();
    current["expectedTeachingRevision"] = json!(locked.teaching_revision);
    assert!(call(&state, "adopt", current).await.is_err());
    let app = state.lock().await;
    let journal_key = serde_json::to_string(&(
        dir.path(),
        selection["sessionId"].as_str().unwrap(),
        selection["principalKey"].as_str().unwrap(),
    ))
    .unwrap();
    assert!(load(&app, &journal_key)
        .unwrap()
        .iter()
        .all(|intent| intent.intent_id != "forged"));
    assert_eq!(
        app.db
            .courseware_music_adoptions(dir.path().to_str().unwrap(), "course-01")
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
async fn deleted_music_is_not_silently_readopted_and_corrupt_export_is_rejected() {
    let (dir, state, selection, archived) = exported().await;
    let adopted = call(&state, "adopt", selection.clone()).await.unwrap();
    let mut project: crate::db::courseware_projects::CoursewareProject =
        serde_json::from_value(adopted["project"].clone()).unwrap();
    project.pages[0]
        .actions
        .retain(|action| action["type"] != "audio_clip");
    state
        .lock()
        .await
        .db
        .write_courseware_teaching(
            dir.path().to_str().unwrap(),
            &TeachingWrite {
                project_id: project.project_id,
                page_id: project.pages[0].page_id.clone(),
                expected_source_revision: project.source.revision,
                expected_teaching_revision: project.teaching_revision,
                actions: project.pages[0].actions.clone(),
            },
        )
        .unwrap();
    assert!(call(&state, "adopt", selection.clone()).await.is_err());
    std::fs::write(archived["path"].as_str().unwrap(), b"broken").unwrap();
    assert!(call(&state, "asset.get", op(&selection)).await.is_err());
    assert!(call(&state, "adopt", selection).await.is_err());
}

#[tokio::test]
async fn music_adoption_is_atomic_and_refuses_changed_team_or_foreign_action() {
    let (dir, state, selection, archived) = exported().await;
    {
        let app = state.lock().await;
        app.db
            .conn()
            .execute_batch(
                r#"CREATE TEMP TRIGGER reject_music_adoption BEFORE INSERT ON kv
            WHEN NEW.ns='coursewareMediaCanvasMusic.v1' AND NEW.key LIKE '["adoptions",%'
            BEGIN SELECT RAISE(ABORT, 'injected music receipt failure'); END;"#,
            )
            .unwrap();
    }
    assert!(call(&state, "adopt", selection.clone()).await.is_err());
    {
        let app = state.lock().await;
        assert_eq!(
            app.db
                .get_courseware_project(dir.path().to_str().unwrap(), "course-01")
                .unwrap()
                .unwrap()
                .teaching_revision,
            selection["expectedTeachingRevision"].as_str().unwrap()
        );
        assert!(app
            .db
            .courseware_music_adoptions(dir.path().to_str().unwrap(), "course-01")
            .unwrap()
            .is_empty());
        app.db
            .conn()
            .execute_batch("DROP TRIGGER reject_music_adoption")
            .unwrap();
    }
    let adopted = call(&state, "adopt", selection.clone()).await.unwrap();
    let (tx, _) = mpsc::unbounded_channel();
    let error = handle_request(state.clone(), "courseware.snapshot.capture", json!({"sessionId":selection["sessionId"],
        "jobId":"missing","snapshotId":"forged","expectedSourceRevision":selection["expectedSourceRevision"],
        "expectedTeachingRevision":adopted["project"]["teachingRevision"],"assets":[{"asset":{
            "id":adopted["adoption"]["assetId"],"sha256":archived["intent"]["asset"]["sha256"],"mimeType":"audio/mpeg"},
            "path":archived["path"]}]}), tx).await.unwrap_err();
    assert_eq!(error.message, "Invalid snapshot assets");
    let mut project: crate::db::courseware_projects::CoursewareProject =
        serde_json::from_value(adopted["project"].clone()).unwrap();
    let mut forged = project.pages[0].actions.last().unwrap().clone();
    forged["id"] = json!("unproven-duplicate");
    project.pages[0].actions.push(forged);
    let project = state
        .lock()
        .await
        .db
        .write_courseware_teaching(
            dir.path().to_str().unwrap(),
            &TeachingWrite {
                project_id: project.project_id,
                page_id: project.pages[0].page_id.clone(),
                expected_source_revision: project.source.revision,
                expected_teaching_revision: project.teaching_revision,
                actions: project.pages[0].actions.clone(),
            },
        )
        .unwrap();
    assert!(call(
        &state,
        "snapshotAssets",
        snapshot(&selection, &json!(project.teaching_revision))
    )
    .await
    .is_err());
    let (tx, _) = mpsc::unbounded_channel();
    handle_request(
        state.clone(),
        "courseware.task.bindTeam",
        json!({"sessionId":selection["sessionId"],
        "teamProjectId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}),
        tx,
    )
    .await
    .unwrap();
    assert!(call(&state, "adopt", selection).await.is_err());
}

#[tokio::test]
async fn music_export_reuses_across_explicit_pages_without_new_tasks_and_dedupes_assets() {
    let (dir, state, selection, _) = exported().await;
    let first = call(&state, "adopt", selection.clone()).await.unwrap();
    let mut second = selection.clone();
    second["pageId"] = json!("fixture-page-2");
    let unlocked = state
        .lock()
        .await
        .db
        .set_courseware_page_lock(
            dir.path().to_str().unwrap(),
            "course-01",
            "fixture-page-2",
            selection["expectedSourceRevision"].as_str().unwrap(),
            first["project"]["teachingRevision"].as_str().unwrap(),
            false,
        )
        .unwrap();
    second["expectedTeachingRevision"] = json!(unlocked.teaching_revision);
    let adopted = call(&state, "adopt", second.clone()).await.unwrap();
    assert_eq!(first["adoption"]["assetId"], adopted["adoption"]["assetId"]);
    assert_ne!(
        first["adoption"]["actionId"],
        adopted["adoption"]["actionId"]
    );
    assert_eq!(
        call(
            &state,
            "snapshotAssets",
            snapshot(&selection, &adopted["project"]["teachingRevision"])
        )
        .await
        .unwrap()["assets"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut project: crate::db::courseware_projects::CoursewareProject =
        serde_json::from_value(adopted["project"].clone()).unwrap();
    project.pages[0]
        .actions
        .retain(|action| action["type"] != "audio_clip");
    let project = state
        .lock()
        .await
        .db
        .write_courseware_teaching(
            dir.path().to_str().unwrap(),
            &TeachingWrite {
                project_id: project.project_id,
                page_id: project.pages[0].page_id.clone(),
                expected_source_revision: project.source.revision,
                expected_teaching_revision: project.teaching_revision,
                actions: project.pages[0].actions.clone(),
            },
        )
        .unwrap();
    let assets = call(
        &state,
        "snapshotAssets",
        snapshot(&selection, &json!(project.teaching_revision)),
    )
    .await
    .unwrap();
    assert_eq!(assets["assets"].as_array().unwrap().len(), 1);
    let mut deleted = selection.clone();
    deleted["expectedTeachingRevision"] = json!(project.teaching_revision);
    assert!(call(&state, "adopt", deleted).await.is_err());
    second["expectedTeachingRevision"] = json!(project.teaching_revision);
    assert_eq!(
        call(&state, "adopt", second).await.unwrap()["adoption"],
        adopted["adoption"]
    );
    let app = state.lock().await;
    let journal_key = serde_json::to_string(&(
        dir.path(),
        selection["sessionId"].as_str().unwrap(),
        selection["principalKey"].as_str().unwrap(),
    ))
    .unwrap();
    assert_eq!(load(&app, &journal_key).unwrap().len(), 2);
}

fn identified_seed(hash: char) -> crate::courseware::SavedProjectSeed {
    use crate::courseware::identity::SavedSourceIdentity;
    let mut value: Value = serde_json::from_slice(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/src/courseware/identity/fixtures/identity.json"
    )))
    .unwrap();
    value["sourceSha256"] = json!(hash.to_string().repeat(64));
    crate::courseware::SavedProjectSeed {
        project_id: "music-snapshot".into(),
        sha256: hash.to_string().repeat(64),
        pages: 1,
        identity: Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap()),
    }
}

#[tokio::test]
async fn music_snapshot_source_review_and_narration_regeneration_keep_the_same_asset_and_slots() {
    let (dir, state, mut selection, archived) = exported().await;
    let root = dir.path().to_str().unwrap();
    let seed = identified_seed('a');
    let initial = state
        .lock()
        .await
        .db
        .open_identified_courseware_project(root, &seed)
        .unwrap();
    selection["projectId"] = json!(initial.project_id);
    selection["pageId"] = json!(initial.pages[0].page_id);
    selection["expectedSourceRevision"] = json!(initial.source.revision);
    selection["expectedTeachingRevision"] = json!(initial.teaching_revision);
    let adopted = call(&state, "adopt", selection.clone()).await.unwrap();
    let mut project: crate::db::courseware_projects::CoursewareProject =
        serde_json::from_value(adopted["project"].clone()).unwrap();
    let clip = project.pages[0].actions[0].clone();
    let asset: Asset = serde_json::from_value(
        call(
            &state,
            "snapshotAssets",
            snapshot(&selection, &json!(project.teaching_revision)),
        )
        .await
        .unwrap()["assets"][0]["asset"]
            .clone(),
    )
    .unwrap();
    let frozen;
    {
        let app = state.lock().await;
        project = app
            .db
            .review_courseware_page(
                root,
                &project.project_id,
                &project.pages[0].page_id,
                &project.source.revision,
                &project.teaching_revision,
            )
            .unwrap();
        frozen = app
            .db
            .capture_courseware_snapshot(
                root,
                &seed,
                "music-fixed",
                &project.source.revision,
                &project.teaching_revision,
                vec![asset.clone()],
            )
            .unwrap();
        assert_eq!(frozen.project.pages[0].actions, vec![clip.clone()]);
        assert!(app
            .db
            .capture_courseware_snapshot(
                root,
                &seed,
                "music-missing",
                &project.source.revision,
                &project.teaching_revision,
                vec![]
            )
            .is_err());
        let next_seed = identified_seed('b');
        let review = app.db.prepare_courseware_review(root, &next_seed).unwrap();
        project = app
            .db
            .adopt_courseware_review(
                root,
                &next_seed,
                review["reviewId"].as_str().unwrap(),
                &[Some(project.pages[0].page_id.clone())],
            )
            .unwrap();
        assert_eq!(project.pages[0].actions, vec![clip.clone()]);
        app.db
            .courseware_music_snapshot_asset(
                root,
                &project,
                selection["sessionId"].as_str().unwrap(),
                selection["principalKey"].as_str().unwrap(),
                selection["intentId"].as_str().unwrap(),
                &asset,
            )
            .unwrap();
        let write = TeachingWrite {
            project_id: project.project_id.clone(),
            page_id: project.pages[0].page_id.clone(),
            expected_source_revision: project.source.revision.clone(),
            expected_teaching_revision: project.teaching_revision.clone(),
            actions: vec![json!({"id":"new-speech","type":"speech","text":"New narration"})],
        };
        app.db
            .stage_narration_candidate(root, &next_seed, "narration-with-music", &write)
            .unwrap();
        project = app
            .db
            .adopt_narration_candidate(root, &next_seed, "narration-with-music")
            .unwrap();
        assert_eq!(project.pages[0].actions[0], clip);
        assert_eq!(project.pages[0].actions[1]["text"], "New narration");
        assert_eq!(
            app.db
                .get_courseware_snapshot(root, &project.project_id, "music-fixed")
                .unwrap()
                .snapshot
                .asset_ids,
            frozen.snapshot.asset_ids
        );
    }
    assert_eq!(
        std::fs::read(archived["path"].as_str().unwrap()).unwrap(),
        b"ID3-exported-music-adoption"
    );
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let record = app
        .db
        .courseware_music_snapshot_asset(
            root,
            &project,
            selection["sessionId"].as_str().unwrap(),
            selection["principalKey"].as_str().unwrap(),
            selection["intentId"].as_str().unwrap(),
            &asset,
        )
        .unwrap();
    assert_eq!(record.source.sha256, seed.sha256);
    assert_eq!(record.bound_source.sha256, "b".repeat(64));
    assert_eq!(record.asset.id, frozen.snapshot.asset_ids[0]);
}

#[tokio::test]
async fn music_adoption_replaces_its_authored_slot_without_moving_or_duplicating_it() {
    let (dir, state, mut selection, _) = exported().await;
    {
        let guard = state.lock().await;
        let project = guard
            .db
            .get_courseware_project(dir.path().to_str().unwrap(), "course-01")
            .unwrap()
            .unwrap();
        let mut actions = project.pages[0].actions.clone();
        actions.push(json!({"id":"song-slot","type":"music_slot","title":"Hello song","prompt":"Sing Hello"}));
        actions.push(json!({"id":"after-song","type":"speech","text":"What did you hear?"}));
        let saved = guard
            .db
            .write_courseware_teaching(
                dir.path().to_str().unwrap(),
                &crate::db::courseware_projects::TeachingWrite {
                    project_id: project.project_id.clone(),
                    page_id: project.pages[0].page_id.clone(),
                    expected_source_revision: project.source.revision.clone(),
                    expected_teaching_revision: project.teaching_revision.clone(),
                    actions,
                },
            )
            .unwrap();
        selection["expectedTeachingRevision"] = json!(saved.teaching_revision);
    }
    selection["slotId"] = json!("song-slot");
    let adopted = call(&state, "adopt", selection.clone()).await.unwrap();
    let actions = adopted["project"]["pages"][0]["actions"]
        .as_array()
        .unwrap();
    assert_eq!(actions[actions.len() - 2]["id"], "song-slot");
    assert_eq!(actions[actions.len() - 2]["type"], "audio_clip");
    assert_eq!(actions.last().unwrap()["id"], "after-song");
    assert_eq!(actions.iter().filter(|a| a["id"] == "song-slot").count(), 1);
    assert_eq!(adopted, call(&state, "adopt", selection).await.unwrap());
}
