use super::*;

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
}
