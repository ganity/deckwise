use super::*;

fn setup(db: &Database, root: &str, id: &str) -> (CoursewareProject, SavedProjectSeed) {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    )))
    .unwrap();
    let mut project: CoursewareProject =
        serde_json::from_value(fixture["project"].clone()).unwrap();
    project.project_id = id.into();
    project.pages.truncate(1);
    project.pages[0].actions.clear();
    db.create_courseware_project(root, &project).unwrap();
    let seed = SavedProjectSeed {
        project_id: id.into(),
        sha256: project.source.sha256.clone(),
        pages: 1,
        identity: None,
    };
    (project, seed)
}

fn history(current: &CoursewareProject, revision: &str, actions: Vec<Value>) -> CoursewareProject {
    let mut old = current.clone();
    old.source = CoursewareSource {
        revision: "old-source".into(),
        sha256: "a".repeat(64),
    };
    old.teaching_revision = revision.into();
    old.pages.push(CoursewarePage {
        page_id: "deleted-page".into(),
        actions,
        locked: true,
        review_state: "ready".into(),
    });
    old
}

fn archive(db: &Database, root: &str, project: &CoursewareProject, time: i64) -> String {
    let key = serde_json::to_string(&(
        storage_key(root, &project.project_id).unwrap(),
        &project.teaching_revision,
    ))
    .unwrap();
    db.kv_set(
        HISTORY_NAMESPACE,
        &key,
        &serde_json::to_value(project).unwrap(),
    )
    .unwrap();
    db.conn
        .execute(
            "UPDATE kv SET updated_at=?1 WHERE ns=?2 AND key=?3",
            params![time, HISTORY_NAMESPACE, key],
        )
        .unwrap();
    key
}

fn records(db: &Database) -> Vec<(String, String, String, i64)> {
    db.conn
        .prepare("SELECT ns,key,value_json,updated_at FROM kv ORDER BY ns,key")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
}

#[test]
fn deleted_teaching_history_restart_is_read_only_and_never_reuses_audio_cues_or_ids() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let seed;
    {
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (current, current_seed) = setup(&db, root, "history-course");
        seed = current_seed;
        let old = history(
            &current,
            "old-teaching",
            vec![
                json!({"id":"old-speech", "type":"speech", "text":"Good! Well done.", "source":"external", "pauseAfterMs":1700,
                "audioAssetId":"tts-old", "audioUrl":"https://private.invalid/old.wav", "voice":"old-voice",
                "visualCues":[{"id":"old-cue"},{"id":"old-cue-2"}]}),
                json!({"id":"old-wait", "type":"interaction_checkpoint", "checkpointId":"old-checkpoint", "checkpointKind":"teacher_continue"}),
                json!({"id":"old-music", "type":"audio_clip", "audioAssetId":format!("music-{}", "a".repeat(64))}),
                json!({"id":"old-pending","type":"speech","text":"Look again.","attention":{"type":"spotlight","objectIds":["old-object"]}}),
                json!({"id":"old-delay","type":"delay","durationMs":1200}),
            ],
        );
        archive(&db, root, &old, 1);
    }
    let db = Database::open_in_dir(dir.path()).unwrap();
    let before = records(&db);
    let value = db.list_courseware_teaching_history(root, &seed).unwrap();
    let entry = &value["entries"][0];
    assert_eq!(value["skippedEntryCount"], 0);
    assert_eq!(entry["teachingRevision"], "old-teaching");
    assert_eq!(entry["sourceRevision"], "old-source");
    assert_eq!(entry["pageId"], "deleted-page");
    assert_eq!(entry["pageNumber"], 2);
    assert_eq!(entry["omittedAudioCount"], 2);
    assert_eq!(entry["omittedCueCount"], 3);
    let actions = entry["actions"].as_array().unwrap();
    assert_eq!(actions.len(), 4);
    assert_eq!(actions[3]["type"], "delay");
    assert_eq!(actions[3]["durationMs"], 1200);
    assert_ne!(actions[3]["id"], "old-delay");
    assert!(actions[2].get("attention").is_none());
    assert_eq!(actions[0]["text"], "Good! Well done.");
    assert_eq!(actions[0]["source"], "external");
    assert_eq!(actions[0]["pauseAfterMs"], 1700);
    assert_eq!(actions[0].as_object().unwrap().len(), 5);
    assert_eq!(actions[1].as_object().unwrap().len(), 4);
    for id in [
        &actions[0]["id"],
        &actions[1]["id"],
        &actions[1]["checkpointId"],
        &actions[3]["id"],
    ] {
        uuid::Uuid::parse_str(id.as_str().unwrap()).unwrap();
    }
    assert!(!value.to_string().contains("private.invalid"));
    assert!(!value.to_string().contains("old-voice"));
    assert_ne!(
        db.list_courseware_teaching_history(root, &seed).unwrap()["entries"][0]["actions"],
        entry["actions"]
    );
    assert_eq!(records(&db), before);
}

#[test]
fn deleted_teaching_history_exact_project_workspace_and_current_source_isolation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (current, seed) = setup(&db, root, "history-course");
    let (_, neighbor_seed) = setup(&db, root, "history-course-other");
    archive(
        &db,
        root,
        &history(
            &current,
            "old",
            vec![json!({"id":"speech", "type":"speech", "text":"Private course narration"})],
        ),
        1,
    );
    let other = dir.path().join("other");
    std::fs::create_dir(&other).unwrap();
    let (_, other_seed) = setup(&db, other.to_str().unwrap(), "history-course");
    assert!(db
        .list_courseware_teaching_history(root, &neighbor_seed)
        .unwrap()["entries"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(db
        .list_courseware_teaching_history(other.to_str().unwrap(), &other_seed)
        .unwrap()["entries"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(
        db.list_courseware_teaching_history(root, &seed).unwrap()["entries"]
            .as_array()
            .unwrap()
            .len()
            == 1
    );
    let wrong_source = SavedProjectSeed {
        sha256: "b".repeat(64),
        ..seed
    };
    assert!(db
        .list_courseware_teaching_history(root, &wrong_source)
        .unwrap_err()
        .to_string()
        .contains("COURSEWARE_CONFLICT"));
}

#[test]
fn deleted_teaching_history_corrupt_or_mismatched_records_fail_closed_without_writes() {
    for mode in ["json", "project", "revision", "pages", "key"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (current, seed) = setup(&db, root, "history-course");
        let old = history(
            &current,
            "old",
            vec![json!({"id":"speech", "type":"speech", "text":"Retained"})],
        );
        let key = archive(&db, root, &old, 1);
        let mut polluted = serde_json::to_value(old).unwrap();
        match mode {
            "project" => polluted["projectId"] = json!("unrelated"),
            "revision" => polluted["teachingRevision"] = json!("other"),
            "pages" => polluted["pages"][1]["pageId"] = polluted["pages"][0]["pageId"].clone(),
            _ => {}
        }
        let raw = if mode == "json" {
            "invalid-json".into()
        } else {
            polluted.to_string()
        };
        db.conn
            .execute(
                "UPDATE kv SET value_json=?1 WHERE ns=?2 AND key=?3",
                params![raw, HISTORY_NAMESPACE, key],
            )
            .unwrap();
        if mode == "key" {
            let malformed = format!(
                "[{},123]",
                serde_json::to_string(&storage_key(root, &current.project_id).unwrap()).unwrap()
            );
            db.conn
                .execute(
                    "UPDATE kv SET key=?1 WHERE ns=?2 AND key=?3",
                    params![malformed, HISTORY_NAMESPACE, key],
                )
                .unwrap();
        }
        let before = records(&db);
        assert!(
            db.list_courseware_teaching_history(root, &seed)
                .unwrap_err()
                .to_string()
                .starts_with("COURSEWARE_INVALID"),
            "{mode}"
        );
        assert_eq!(records(&db), before);
    }
}

#[test]
fn deleted_teaching_history_latest_twenty_page_versions_and_explicit_skipped_count() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (current, seed) = setup(&db, root, "history-course");
    for index in 0..25 {
        archive(
            &db,
            root,
            &history(
                &current,
                &format!("revision-{index:02}"),
                vec![json!({"id":"speech", "type":"speech", "text":format!("Version {index}")})],
            ),
            index,
        );
    }
    for (index, actions) in [
        vec![json!({"id":"future", "type":"future_action"})],
        vec![],
        vec![json!({"id":"music", "type":"audio_clip", "audioAssetId":format!("music-{}", "a".repeat(64))})],
        vec![json!({"id":"speech", "type":"speech", "text":"Valid", "pauseAfterMs":30001})],
        vec![json!({"id":"speech", "type":"speech", "text":"Valid", "source":"unknown"})],
        vec![json!({"id":"speech", "type":"speech", "text":"Valid", "visualCues":null})],
    ]
    .into_iter()
    .enumerate()
    {
        archive(
            &db,
            root,
            &history(&current, &format!("unsupported-{index}"), actions),
            100 + index as i64,
        );
    }
    let before = records(&db);
    let value = db.list_courseware_teaching_history(root, &seed).unwrap();
    let entries = value["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 20);
    assert_eq!(value["skippedEntryCount"], 6);
    assert_eq!(entries[0]["teachingRevision"], "revision-24");
    assert_eq!(entries[19]["teachingRevision"], "revision-05");
    assert!(entries
        .iter()
        .all(|entry| entry["pageId"] == "deleted-page"));
    assert_eq!(records(&db), before);
}

#[test]
fn deleted_teaching_history_response_budget_skips_whole_versions_without_truncating_text() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (current, seed) = setup(&db, root, "history-course");
    let text = "a".repeat(16000);
    for index in 0..4 {
        let actions = (0..50)
            .map(|id| json!({"id":format!("speech-{id}"), "type":"speech", "text":text}))
            .collect();
        archive(
            &db,
            root,
            &history(&current, &format!("large-{index}"), actions),
            index,
        );
    }
    let value = db.list_courseware_teaching_history(root, &seed).unwrap();
    assert!(serde_json::to_vec(&value).unwrap().len() <= MAX_BYTES);
    assert_eq!(value["entries"].as_array().unwrap().len(), 2);
    assert_eq!(value["skippedEntryCount"], 2);
    for entry in value["entries"].as_array().unwrap() {
        assert_eq!(entry["actions"].as_array().unwrap().len(), 50);
        assert!(entry["actions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|action| action["text"] == text));
    }
}

#[test]
fn deleted_teaching_history_projection_boundary_values_are_explicit() {
    let mut page = CoursewarePage {
        page_id: "deleted".into(),
        locked: false,
        review_state: "review".into(),
        actions: vec![],
    };
    for source in [
        "notes",
        "external",
        "original",
        "light_rewrite",
        "generated",
    ] {
        page.actions = vec![
            json!({"id":"speech", "type":"speech", "text":"😀".repeat(16000), "pauseAfterMs":30000, "source":source}),
        ];
        assert!(projection(&page).is_some());
    }
    page.actions[0]["text"] = json!("😀".repeat(16001));
    assert!(projection(&page).is_none());
    page.actions = vec![
        json!({"id":"wait", "type":"interaction_checkpoint", "checkpointId":"old", "checkpointKind":"teacher_continue"}),
    ];
    assert!(projection(&page).is_some());
    page.actions[0]["checkpointKind"] = json!("student_answer");
    assert!(projection(&page).is_none());
}

#[test]
fn deleted_teaching_history_reads_actual_source_review_deleted_page_after_restart() {
    use crate::courseware::identity::SavedSourceIdentity;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let source = |hash: char, count: usize| {
        let mut identity: Value = serde_json::from_slice(include_bytes!(
            "../../../courseware/identity/fixtures/identity.json"
        ))
        .unwrap();
        identity["sourceSha256"] = json!(hash.to_string().repeat(64));
        if count == 2 {
            let mut second = identity["pages"][0].clone();
            second["logicalId"] = json!("second-source-page");
            second["importPageId"] = json!("page_2");
            second["objects"] = json!([]);
            identity["pages"].as_array_mut().unwrap().push(second);
        }
        SavedProjectSeed {
            project_id: "deleted-source-review".into(),
            sha256: hash.to_string().repeat(64),
            pages: count,
            identity: Some(
                SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap(),
            ),
        }
    };
    let next = source('b', 1);
    let deleted_id;
    {
        let db = Database::open_in_dir(dir.path()).unwrap();
        let project = db
            .open_identified_courseware_project(root, &source('a', 2))
            .unwrap();
        deleted_id = project.pages[1].page_id.clone();
        let written = db.write_courseware_teaching(root, &TeachingWrite { project_id:project.project_id.clone(), page_id:deleted_id.clone(),
            expected_source_revision:project.source.revision.clone(), expected_teaching_revision:project.teaching_revision.clone(),
            actions:vec![json!({"id":"speech", "type":"speech", "text":"Recover this deleted page.", "pauseAfterMs":1500}),
                json!({"id":"wait", "type":"interaction_checkpoint", "checkpointId":"checkpoint", "checkpointKind":"teacher_continue"})] }).unwrap();
        let review = db.prepare_courseware_review(root, &next).unwrap();
        let adopted = db
            .adopt_courseware_review(
                root,
                &next,
                review["reviewId"].as_str().unwrap(),
                &[Some(written.pages[0].page_id.clone())],
            )
            .unwrap();
        assert_eq!(adopted.pages.len(), 1);
        assert_ne!(adopted.teaching_revision, written.teaching_revision);
    }
    let db = Database::open_in_dir(dir.path()).unwrap();
    let before = records(&db);
    let value = db.list_courseware_teaching_history(root, &next).unwrap();
    assert_eq!(value["entries"].as_array().unwrap().len(), 1);
    assert_eq!(value["entries"][0]["pageId"], deleted_id);
    assert_eq!(value["entries"][0]["pageNumber"], 2);
    assert_eq!(
        value["entries"][0]["actions"][0]["text"],
        "Recover this deleted page."
    );
    assert_eq!(value["entries"][0]["actions"][0]["pauseAfterMs"], 1500);
    assert_eq!(records(&db), before);
}
