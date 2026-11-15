use super::*;

#[test]
fn video_retry_retains_the_receipt_and_normal_prepare_follows_the_successor() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("retry.sqlite");
    let db = Database::open(&path).unwrap();
    let accepted: Value = serde_json::from_slice(include_bytes!("../../../../../../packages/shared/src/courseware-contract.fixtures/accepted.json")).unwrap();
    let mut project: CoursewareProject = serde_json::from_value(accepted["project"].clone()).unwrap();
    project.pages[0].actions.push(json!({"id":"video-slot","type":"video_slot","prompt":"A turning square","durationSeconds":8}));
    db.create_courseware_project(root, &project).unwrap();
    let principal = "a".repeat(64);
    let prepared = db.prepare_courseware_video(root, &project.project_id, &principal, &project.pages[0].page_id, "video-slot", "video").unwrap();
    assert_eq!(prepared.duration_seconds, Some(8));
    assert!(db.retry_courseware_video(root, &project.project_id, &principal, &prepared.intent_id).is_err());
    db.begin_courseware_video(root, &project.project_id, &principal, &prepared.intent_id, "chat").unwrap();
    let receipt = tts::TaskRef { task_id: "original-task".into(), idempotency_key: prepared.idempotency_key.clone(), request_hash: prepared.request_hash.clone() };
    let original = db.bind_courseware_video(root, &project.project_id, &principal, &prepared.intent_id, receipt.clone()).unwrap();
    let retry = db.retry_courseware_video(root, &project.project_id, &principal, &original.intent_id).unwrap();
    assert_ne!(retry.intent_id, original.intent_id);
    assert_ne!(retry.idempotency_key, original.idempotency_key);
    assert_eq!(retry.request_hash, original.request_hash);
    assert_eq!(retry.prompt, original.prompt);
    assert_eq!(retry.duration_seconds, Some(8));
    assert_eq!(retry.phase, "prepared");
    assert!(retry.task_ref.is_none() && retry.submission_scope.is_none());
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(db.retry_courseware_video(root, &project.project_id, &principal, &original.intent_id).unwrap().intent_id, retry.intent_id);
    assert_eq!(db.get_courseware_video(root, &project.project_id, &principal, &original.intent_id).unwrap().task_ref, Some(receipt));
    assert_eq!(db.prepare_courseware_video(root, &project.project_id, &principal, &project.pages[0].page_id, "video-slot", "video").unwrap().intent_id, retry.intent_id);
}

#[test]
fn video_original_request_survives_restart_and_adoption_rejects_changed_slots() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("video.sqlite");
    let db = Database::open(&path).unwrap();
    let accepted: Value = serde_json::from_slice(include_bytes!(
        "../../../../../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    ))
    .unwrap();
    let mut project: CoursewareProject =
        serde_json::from_value(accepted["project"].clone()).unwrap();
    project.pages[0].actions.push(json!({"id":"video-slot","type":"video_slot","prompt":"A silent five-second square rotation."}));
    db.create_courseware_project(root, &project).unwrap();
    let principal = "a".repeat(64);
    let prepared = db
        .prepare_courseware_video(
            root,
            &project.project_id,
            &principal,
            &project.pages[0].page_id,
            "video-slot",
            "video-model",
        )
        .unwrap();
    assert_eq!(
        db.prepare_courseware_video(
            root,
            &project.project_id,
            &principal,
            &project.pages[0].page_id,
            "video-slot",
            "video-model"
        )
        .unwrap()
        .intent_id,
        prepared.intent_id
    );
    let started = db
        .begin_courseware_video(
            root,
            &project.project_id,
            &principal,
            &prepared.intent_id,
            "session",
        )
        .unwrap();
    assert_eq!(started.phase, "submission-unknown");
    assert!(db
        .begin_courseware_video(
            root,
            &project.project_id,
            &principal,
            &prepared.intent_id,
            "session"
        )
        .is_err());
    assert!(db
        .get_courseware_video(
            root,
            &project.project_id,
            &"b".repeat(64),
            &prepared.intent_id
        )
        .is_err());
    drop(db);
    let db = Database::open(&path).unwrap();
    let recovered = db
        .get_courseware_video(root, &project.project_id, &principal, &prepared.intent_id)
        .unwrap();
    assert_eq!(recovered.request_hash, prepared.request_hash);
    let task = tts::TaskRef {
        task_id: "original-task".into(),
        idempotency_key: prepared.idempotency_key.clone(),
        request_hash: prepared.request_hash.clone(),
    };
    db.bind_courseware_video(
        root,
        &project.project_id,
        &principal,
        &prepared.intent_id,
        task.clone(),
    )
    .unwrap();
    let mut wrong = task.clone();
    wrong.task_id = "other".into();
    assert!(db
        .bind_courseware_video(
            root,
            &project.project_id,
            &principal,
            &prepared.intent_id,
            wrong.clone()
        )
        .is_err());
    let asset = VideoAsset {
        sha256: "c".repeat(64),
        byte_length: 1000,
        duration_ms: 5000,
        width: 1280,
        height: 720,
    };
    assert!(VideoAsset { byte_length: 17 * 1024 * 1024, duration_ms: 60_000, width: 7680, height: 4320, ..asset.clone() }.validate().is_ok());
    assert!(VideoAsset { byte_length: 40 * 1024 * 1024 + 1, ..asset.clone() }.validate().is_err());
    assert!(VideoAsset { duration_ms: 0, ..asset.clone() }.validate().is_err());
    assert!(db
        .stage_courseware_video(
            root,
            &project.project_id,
            &principal,
            &prepared.intent_id,
            &wrong,
            asset.clone()
        )
        .is_err());
    db.stage_courseware_video(
        root,
        &project.project_id,
        &principal,
        &prepared.intent_id,
        &task,
        asset.clone(),
    )
    .unwrap();
    assert!(db
        .adopt_courseware_video(
            root,
            &project.project_id,
            &principal,
            &prepared.intent_id,
            "wrong"
        )
        .is_err());
    let saved = db
        .adopt_courseware_video(
            root,
            &project.project_id,
            &principal,
            &prepared.intent_id,
            &project.teaching_revision,
        )
        .unwrap();
    assert_eq!(
        saved.pages[0].actions.last().unwrap(),
        &json!({"id":"video-slot","type":"video_clip","videoAssetId":asset.asset().id})
    );
    assert_eq!(saved.pages[0].actions[0], project.pages[0].actions[0]);
    assert_eq!(
        db.adopt_courseware_video(
            root,
            &project.project_id,
            &principal,
            &prepared.intent_id,
            &saved.teaching_revision
        )
        .unwrap()
        .teaching_revision,
        saved.teaching_revision
    );
    assert_eq!(
        db.current_courseware_video_asset(root, &saved, &principal, &prepared.intent_id, "session")
            .unwrap()
            .sha256,
        asset.sha256
    );
    assert!(db
        .current_courseware_video_asset(
            root,
            &saved,
            &principal,
            &prepared.intent_id,
            "other-session"
        )
        .is_err());
    assert!(db
        .current_courseware_video_asset(
            root,
            &saved,
            &"b".repeat(64),
            &prepared.intent_id,
            "session"
        )
        .is_err());
    let mut changed = saved.clone();
    changed.source.sha256 = "d".repeat(64);
    assert!(db
        .current_courseware_video_asset(root, &changed, &principal, &prepared.intent_id, "session")
        .is_err());
    let mut removed = saved.clone();
    removed.pages[0].actions.retain(|a| a["id"] != "video-slot");
    assert!(db
        .current_courseware_video_asset(root, &removed, &principal, &prepared.intent_id, "session")
        .is_err());
    let unlocked = db
        .set_courseware_page_lock(
            root,
            &saved.project_id,
            &saved.pages[1].page_id,
            &saved.source.revision,
            &saved.teaching_revision,
            false,
        )
        .unwrap();
    let mut write = TeachingWrite {
        project_id: unlocked.project_id.clone(),
        page_id: unlocked.pages[1].page_id.clone(),
        expected_source_revision: unlocked.source.revision.clone(),
        expected_teaching_revision: "stale".into(),
        actions: Vec::new(),
    };
    assert!(db
        .reuse_courseware_video(
            root,
            &write,
            &principal,
            &prepared.intent_id,
            "session",
            "reuse-1"
        )
        .is_err());
    write.expected_teaching_revision = unlocked.teaching_revision.clone();
    assert!(db
        .reuse_courseware_video(
            root,
            &write,
            &principal,
            &prepared.intent_id,
            "other-session",
            "reuse-1"
        )
        .is_err());
    let reused = db
        .reuse_courseware_video(
            root,
            &write,
            &principal,
            &prepared.intent_id,
            "session",
            "reuse-1",
        )
        .unwrap();
    assert_eq!(reused.pages[0].actions, unlocked.pages[0].actions);
    assert_eq!(
        reused.pages[1].actions.last().unwrap(),
        &json!({"id":"reuse-1","type":"video_clip","videoAssetId":asset.asset().id})
    );
    assert_eq!(
        db.reuse_courseware_video(
            root,
            &write,
            &principal,
            &prepared.intent_id,
            "session",
            "reuse-1"
        )
        .unwrap()
        .teaching_revision,
        reused.teaching_revision
    );
    let mut only_reused = reused.clone();
    only_reused.pages[0]
        .actions
        .retain(|action| action["id"] != "video-slot");
    assert_eq!(
        db.current_courseware_video_asset(
            root,
            &only_reused,
            &principal,
            &prepared.intent_id,
            "session"
        )
        .unwrap()
        .sha256,
        asset.sha256
    );
    only_reused.pages[1]
        .actions
        .retain(|action| action["id"] != "reuse-1");
    assert!(db
        .current_courseware_video_asset(
            root,
            &only_reused,
            &principal,
            &prepared.intent_id,
            "session"
        )
        .is_err());
    let intents = db
        .list_courseware_videos(root, &project.project_id, &principal)
        .unwrap();
    assert_eq!(intents.len(), 1);
    assert_eq!(intents[0].placements.len(), 1);
    assert_eq!(intents[0].task_ref.as_ref(), Some(&task));
    assert_eq!(intents[0].request_hash, prepared.request_hash);
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.get_courseware_video(root, &project.project_id, &principal, &prepared.intent_id)
            .unwrap()
            .placements[0]
            .action_id,
        "reuse-1"
    );
    let mut remove = write.clone();
    remove.expected_teaching_revision = reused.teaching_revision;
    remove.actions = unlocked.pages[1].actions.clone();
    db.write_courseware_teaching(root, &remove).unwrap();
    assert!(db
        .reuse_courseware_video(
            root,
            &write,
            &principal,
            &prepared.intent_id,
            "session",
            "reuse-1"
        )
        .is_err());
}
