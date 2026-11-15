use super::*;
fn draft() -> Value {
    json!({"title":"Rainbow rescue","summary":"Find missing colors","setting":"A garden",
    "objectives":["Name red"],"characters":[{"name":"Robin","description":"A round robot"}],
    "beats":[{"id":"find","title":"Find red","event":"Find a ball","objective":"Name red","activity":"Sort objects"}],"assumptions":[]})
}
#[test]
fn story_approval_ignores_only_production_settings() {
    assert!(same_story_requirements(
        &Value::Null,
        &json!({"bodyPageLimit":10,"visualStyle":"Watercolor"})
    ));
    assert!(same_story_requirements(
        &json!({"grade":"K2","bodyPageLimit":8}),
        &json!({"grade":"K2","bodyPageLimit":10,"visualStyle":"Watercolor"})
    ));
    for (key, value) in [
        ("schoolStage", json!("primary")),
        ("grade", json!("K3")),
        ("subject", json!("math")),
        ("fullEnglishTeaching", json!(true)),
        ("textbookVersion", json!("New edition")),
        ("chapter", json!("Colors")),
        ("lessonType", json!("Review")),
        ("customSubjectName", json!("Art")),
    ] {
        let saved = json!({"grade":"K2"});
        let mut changed = saved.clone();
        changed[key] = value;
        assert!(!same_story_requirements(&saved, &changed));
    }
}
async fn call(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let (tx, _) = mpsc::unbounded_channel();
    crate::rpc::handle_request(state.clone(), method, params, tx).await
}
#[tokio::test]
async fn story_lifecycle_both_routes_preserves_old_tasks_and_survives_restart() {
    for route in ["plain", "scene"] {
        let dir = tempfile::tempdir().unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let session = crate::sessions::create_session(
            &app.db,
            None,
            None,
            None,
            None,
            Some(dir.path().to_string_lossy().into()),
        )
        .unwrap();
        let id = session.id;
        let state = Arc::new(Mutex::new(app));
        call(
            &state,
            "courseware.task.set",
            json!({"sessionId":id,"taskType":route,"educationContext":{"subject":"english"}}),
        )
        .await
        .unwrap();
        assert_eq!(
            call(&state, "courseware.story.get", json!({"sessionId":id}))
                .await
                .unwrap()["story"],
            Value::Null
        );
        call(&state, "courseware.story.begin", json!({"sessionId":id}))
            .await
            .unwrap();
        {
            let st = state.lock().await;
            assert!(guard_tool(&st, &id, "Write").is_err());
            assert!(guard_tool(&st, &id, "GenerateImages").is_err());
        }
        let save = json!({"sessionId":id,"expectedRevision":0,"story":draft()});
        let first = call(&state, "courseware.story.save", save.clone())
            .await
            .unwrap();
        assert_eq!(first["story"]["revision"], 1);
        assert_eq!(
            call(&state, "courseware.story.save", save).await.unwrap(),
            first
        );
        assert!(call(&state,"courseware.story.decide",json!({"sessionId":id,"expectedRevision":0,"sha256":first["story"]["sha256"],"action":"approve"})).await.is_err());
        let approval = json!({"sessionId":id,"expectedRevision":1,"sha256":first["story"]["sha256"],"action":"approve"});
        let saved = call(&state, "courseware.story.decide", approval.clone())
            .await
            .unwrap();
        assert!(ready(&saved["story"]));
        assert_eq!(
            call(&state, "courseware.story.decide", approval)
                .await
                .unwrap(),
            saved
        );
        drop(state);
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let state = Arc::new(Mutex::new(app));
        assert_eq!(
            call(&state, "courseware.story.get", json!({"sessionId":id}))
                .await
                .unwrap(),
            saved
        );
        let mut revised = draft();
        revised["title"] = json!("Revised rescue");
        let second = call(
            &state,
            "courseware.story.save",
            json!({"sessionId":id,"expectedRevision":1,"story":revised}),
        )
        .await
        .unwrap();
        assert!(second["story"]["approvedSha256"].is_null());
        assert_ne!(second["story"]["sha256"], first["story"]["sha256"]);
        assert!(call(
            &state,
            "courseware.story.save",
            json!({"sessionId":id,"expectedRevision":1,"story":draft()})
        )
        .await
        .is_err());
        call(&state,"courseware.story.decide",json!({"sessionId":id,"expectedRevision":2,"sha256":second["story"]["sha256"],"action":"approve"})).await.unwrap();
        {
            let st = state.lock().await;
            assert!(bind(&st, &id, first["story"]["sha256"].as_str()).is_err());
            if route == "plain" {
                guard_tool(&st, &id, "Write").unwrap();
                assert_eq!(read(&st, &id).unwrap().unwrap()["bound"], false);
                admit_tool(&st, &id, "Write").unwrap();
            } else {
                bind(&st, &id, second["story"]["sha256"].as_str()).unwrap();
            }
        }
        assert!(call(
            &state,
            "courseware.story.save",
            json!({"sessionId":id,"expectedRevision":2,"story":draft()})
        )
        .await
        .is_err());
        assert!(call(&state,"courseware.story.decide",json!({"sessionId":id,"expectedRevision":2,"sha256":second["story"]["sha256"],"action":"disable"})).await.is_err());
    }
}
#[tokio::test]
async fn story_settings_changes_schema_and_disable_are_checked() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = crate::sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(dir.path().to_string_lossy().into()),
    )
    .unwrap();
    let id = session.id;
    let state = Arc::new(Mutex::new(app));
    assert!(call(
        &state,
        "courseware.task.set",
        json!({"sessionId":id,"taskType":"import","storyFirst":true})
    )
    .await
    .is_err());
    call(
        &state,
        "courseware.task.set",
        json!({"sessionId":id,"taskType":"plain","storyFirst":true,"educationContext":{}}),
    )
    .await
    .unwrap();
    let mut null_duration = draft();
    null_duration["durationMinutes"] = Value::Null;
    let mut null_assessment = draft();
    null_assessment["beats"][0]["assessment"] = Value::Null;
    for bad in [
        json!({}),
        json!({"title":"x","unknown":true}),
        null_duration,
        null_assessment,
    ] {
        assert!(call(
            &state,
            "courseware.story.save",
            json!({"sessionId":id,"expectedRevision":0,"story":bad})
        )
        .await
        .is_err());
    }
    let saved = call(
        &state,
        "courseware.story.save",
        json!({"sessionId":id,"expectedRevision":0,"story":draft()}),
    )
    .await
    .unwrap();
    call(&state,"courseware.story.decide",json!({"sessionId":id,"expectedRevision":1,"sha256":saved["story"]["sha256"],"action":"approve"})).await.unwrap();
    call(
        &state,
        "courseware.task.updateEducation",
        json!({"sessionId":id,"expectedEducationContext":{},"educationContext":{"grade":"K2"}}),
    )
    .await
    .unwrap();
    assert!(
        call(&state, "courseware.story.get", json!({"sessionId":id}))
            .await
            .unwrap()["story"]["approvedSha256"]
            .is_null()
    );
    assert!(call(&state,"courseware.story.decide",json!({"sessionId":id,"expectedRevision":1,"sha256":saved["story"]["sha256"],"action":"approve"})).await.is_err());
    call(&state,"courseware.story.decide",json!({"sessionId":id,"expectedRevision":1,"sha256":saved["story"]["sha256"],"action":"disable"})).await.unwrap();
    call(&state, "courseware.story.begin", json!({"sessionId":id}))
        .await
        .unwrap();
    assert!(
        call(&state, "courseware.story.get", json!({"sessionId":id}))
            .await
            .unwrap()["story"]["draft"]
            .is_null()
    );
    call(
        &state,
        "courseware.story.decide",
        json!({"sessionId":id,"expectedRevision":0,"sha256":null,"action":"disable"}),
    )
    .await
    .unwrap();
    {
        let st = state.lock().await;
        let message: sessions::UiMessage = serde_json::from_value(json!({
            "id":"already-authored","role":"tool","content":"Created SVG pages",
            "createdAt":"2026-01-01T00:00:00Z","toolName":"Write","toolCallId":"write-svg","toolStatus":"success"
        })).unwrap();
        sessions::append_message(&st.db, &id, &message, None).unwrap();
        assert!(guard_tool(&st, &id, "Write").is_ok());
    }
    assert!(
        call(&state, "courseware.story.begin", json!({"sessionId":id}))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn story_begin_and_scene_binding_roll_back_on_storage_failure() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(dir.path().to_string_lossy().into()),
    )
    .unwrap();
    let id = session.id;
    let state = Arc::new(Mutex::new(app));
    call(
        &state,
        "courseware.task.set",
        json!({"sessionId":id,"taskType":"scene"}),
    )
    .await
    .unwrap();
    state.lock().await.db.conn().execute_batch(
        "CREATE TRIGGER ignore_story BEFORE INSERT ON kv WHEN NEW.ns='coursewareStories.v1' BEGIN SELECT RAISE(IGNORE); END;"
    ).unwrap();
    assert!(
        call(&state, "courseware.story.begin", json!({"sessionId":id}))
            .await
            .is_err()
    );
    assert!(call(&state, "courseware.task.get", json!({"sessionId":id}))
        .await
        .unwrap()["task"]["storyFirst"]
        .is_null());
    state
        .lock()
        .await
        .db
        .conn()
        .execute_batch("DROP TRIGGER ignore_story")
        .unwrap();
    call(&state, "courseware.story.begin", json!({"sessionId":id}))
        .await
        .unwrap();
    let saved = call(
        &state,
        "courseware.story.save",
        json!({"sessionId":id,"expectedRevision":0,"story":draft()}),
    )
    .await
    .unwrap();
    call(&state,"courseware.story.decide",json!({"sessionId":id,"expectedRevision":1,"sha256":saved["story"]["sha256"],"action":"approve"})).await.unwrap();
    let plan = json!({"title":"Rainbow rescue","storySha256":saved["story"]["sha256"],
        "pages":[{"title":"Red ball","visibleText":["red"],"visualIntent":"A red ball","narration":"Look at the ball."}]});
    let bytes = serde_json::to_vec(&plan).unwrap();
    let path = dir
        .path()
        .join(format!(".deckwise-ppt/scenes/{id}/plan.json"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, &bytes).unwrap();
    let approve = json!({"sessionId":id,"sha256":hex::encode(Sha256::digest(&bytes))});
    state.lock().await.db.conn().execute_batch(
        "CREATE TRIGGER ignore_plan BEFORE INSERT ON kv WHEN NEW.ns='coursewareScenePlans.v1' BEGIN SELECT RAISE(IGNORE); END;"
    ).unwrap();
    assert!(
        call(&state, "courseware.scenePlan.approve", approve.clone())
            .await
            .is_err()
    );
    assert_eq!(
        call(&state, "courseware.story.get", json!({"sessionId":id}))
            .await
            .unwrap()["story"]["bound"],
        false
    );
    state
        .lock()
        .await
        .db
        .conn()
        .execute_batch("DROP TRIGGER ignore_plan")
        .unwrap();
    call(&state, "courseware.scenePlan.approve", approve)
        .await
        .unwrap();
    assert_eq!(
        call(&state, "courseware.story.get", json!({"sessionId":id}))
            .await
            .unwrap()["story"]["bound"],
        true
    );
}
