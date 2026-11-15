use super::*;
use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};

fn fixture(db: &Database, root: &str) -> CoursewareProject {
    fixture_with_music(db, root, true)
}

fn fixture_with_music(db: &Database, root: &str, music: bool) -> CoursewareProject {
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    let seed = SavedProjectSeed {
        project_id: "workflow".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    };
    let project = db
        .open_identified_courseware_project_with_metadata(root, &seed, "scene", None)
        .unwrap();
    let mut mapping: Value = json!({"pages":[{"slideId":"scene-001","sourceHash":format!("sha256:{}", "a".repeat(64)),
        "slidePart":"ppt/slides/slide1.xml","teaching":{"pageType":"quiz","phase":"review","objective":"Choose a greeting","durationSeconds":30,
        "requiredObjects":[],"question":{"text":"Which greeting?","response":{"kind":"single","options":["Hello","Bye"],"answerIndices":[0]}},
        "music":{"purpose":"Greeting song","prompt":"Sing Hello"}},
        "elements":seed.identity.as_ref().unwrap().value()["pages"][0]["objects"].as_array().unwrap().iter().enumerate().map(|(i,o)|
            json!({"elementId":format!("object-{i}"),"objectName":format!("object-{i}"),"sourceShapeId":o["sourceShapeId"],
                "type":if o["type"]=="image" {"image_layer"} else {"native_shape"}})).collect::<Vec<_>>()}]});
    if !music {
        mapping["pages"][0]["teaching"]
            .as_object_mut()
            .unwrap()
            .remove("music");
    }
    let mapping = serde_json::from_value(mapping).unwrap();
    db.initialize_generated_scene_objects(root, &project, &mapping)
        .unwrap();
    project
}

fn checkpoint(project: &CoursewareProject) -> Checkpoint {
    Checkpoint {
        revision: 1,
        project_id: project.project_id.clone(),
        source_sha256: project.source.sha256.clone(),
        status: "running".into(),
        repair_attempts: BTreeMap::from([("c".repeat(64), 2)]),
        last_resume: Some("d".repeat(64)),
    }
}

#[test]
fn completion_checks_retained_requirements_even_when_speech_is_playable() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let mut project = fixture(&db, root);
    project.pages[0].actions = vec![
        json!({"id":"speech","type":"speech","text":"Hello","source":"generated","audioAssetId":"tts-fixture"}),
    ];
    let report = db.courseware_completion(root, &project).unwrap();
    assert_eq!(report["ready"], false);
    assert_eq!(
        report["issues"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["code"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["QUESTION_MISSING", "MUSIC_MISSING"]
    );
    project.pages[0].actions.push(json!({"id":"question","type":"interaction_checkpoint","checkpointKind":"chapter_summary","response":{"kind":"single","options":["Hello","Bye"],"answerIndices":[1]}}));
    assert_eq!(
        db.courseware_completion(root, &project).unwrap()["issues"][0]["code"],
        "QUESTION_TYPE_MISMATCH"
    );
    project.pages[0].actions[1]["response"]["answerIndices"] = json!([0]);
    project.pages[0].actions[1]["question"] = json!("Unrelated question");
    assert_eq!(
        db.courseware_completion(root, &project).unwrap()["issues"][0]["code"],
        "QUESTION_TYPE_MISMATCH"
    );
    project.pages[0].actions[1]["question"] = json!("Which greeting?");
    project.pages[0]
        .actions
        .push(json!({"id":"song","type":"music_slot","title":"Hello","prompt":"Sing Hello"}));
    assert_eq!(
        db.courseware_completion(root, &project).unwrap()["issues"][0]["code"],
        "MUSIC_PENDING"
    );
    project.pages[0].actions[2] =
        json!({"id":"song","type":"audio_clip","audioAssetId":"music-fixture"});
    assert_eq!(
        db.courseware_completion(root, &project).unwrap()["ready"],
        true
    );
    project.pages[0]
        .actions
        .push(json!({"id":"narration-1","type":"speech","text":"Outline"}));
    assert_eq!(
        db.courseware_completion(root, &project).unwrap()["issues"][0]["code"],
        "NARRATION_MISSING"
    );
    project.pages[0].actions.pop();
    project.pages[0].locked = true;
    project.pages[0].actions.pop();
    assert_eq!(
        db.courseware_completion(root, &project).unwrap()["issues"][0]["repairable"],
        false
    );
}

#[test]
fn deleted_required_page_cannot_disappear_from_acceptance() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let mut project = fixture(&db, root);
    // The retained scene mapping identifies missing pages independently of current display order.
    project.pages.clear();
    let report = db.courseware_completion(root, &project).unwrap();
    assert_eq!(report["issues"][0]["code"], "PAGE_MISSING");
    assert_eq!(report["issues"][0]["repairable"], false);
    assert_eq!(report["issues"][1]["code"], "PAGE_COUNT_MISMATCH");
}

#[test]
fn checkpoints_survive_restart_without_resetting_budgets_and_require_owned_running_turns() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let project = fixture(&db, root);
    let session =
        crate::sessions::create_session(&db, None, None, None, None, Some(root.into())).unwrap();
    let other =
        crate::sessions::create_session(&db, None, None, None, None, Some(root.into())).unwrap();
    let turn = crate::sessions::begin_turn(&db, &session.id, None, None).unwrap();
    let next = checkpoint(&project);
    assert!(db
        .save_courseware_workflow_checkpoint(root, &other.id, &turn, 0, &next)
        .is_err());
    db.save_courseware_workflow_checkpoint(root, &session.id, &turn, 0, &next)
        .unwrap();
    assert!(db
        .save_courseware_workflow_checkpoint(root, &session.id, &turn, 0, &next)
        .is_err());
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let restored = db
        .courseware_workflow_checkpoint(root, &session.id, &project.project_id)
        .unwrap()
        .unwrap();
    assert_eq!(restored.repair_attempts[&"c".repeat(64)], 2);
    assert_eq!(restored.last_resume, next.last_resume);
    assert!(db
        .courseware_workflow_checkpoint(root, &other.id, &project.project_id)
        .unwrap()
        .is_none());
    assert!(db
        .courseware_workflow_checkpoint("/other/workspace", &session.id, &project.project_id)
        .unwrap()
        .is_none());
    let resumed_turn = crate::sessions::begin_turn(&db, &session.id, None, None).unwrap();
    for attempts in [BTreeMap::new(), BTreeMap::from([("c".repeat(64), 1)])] {
        let reset = Checkpoint {
            revision: 2,
            repair_attempts: attempts,
            ..restored.clone()
        };
        assert!(db
            .save_courseware_workflow_checkpoint(root, &session.id, &resumed_turn, 1, &reset)
            .unwrap_err()
            .to_string()
            .contains("budgets cannot be reset"));
    }
    let completed = Checkpoint {
        revision: 2,
        status: "completed".into(),
        ..restored.clone()
    };
    assert!(db
        .save_courseware_workflow_checkpoint(root, &session.id, &resumed_turn, 1, &completed)
        .unwrap_err()
        .to_string()
        .contains("COURSEWARE_INCOMPLETE"));
    crate::sessions::end_turn(&db, &resumed_turn, "aborted", None, None, false).unwrap();
    let blocked = Checkpoint {
        revision: 2,
        status: "blocked".into(),
        ..restored
    };
    assert!(db
        .save_courseware_workflow_checkpoint(root, &session.id, &turn, 1, &blocked)
        .unwrap_err()
        .to_string()
        .contains("TOOL_TURN_CANCELLED"));
    assert_eq!(
        db.courseware_workflow_checkpoint(root, &session.id, &project.project_id)
            .unwrap()
            .unwrap()
            .revision,
        1
    );
}

#[test]
fn arbitrary_source_changes_cannot_rebind_a_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let project = fixture(&db, root);
    let session =
        crate::sessions::create_session(&db, None, None, None, None, Some(root.into())).unwrap();
    let turn = crate::sessions::begin_turn(&db, &session.id, None, None).unwrap();
    db.save_courseware_workflow_checkpoint(root, &session.id, &turn, 0, &checkpoint(&project))
        .unwrap();
    let mut changed = project.clone();
    changed.source.sha256 = "f".repeat(64);
    db.kv_set(
        NAMESPACE,
        &storage_key(root, &project.project_id).unwrap(),
        &serde_json::to_value(&changed).unwrap(),
    )
    .unwrap();
    let next = Checkpoint {
        revision: 2,
        source_sha256: changed.source.sha256,
        ..checkpoint(&project)
    };
    assert!(db
        .save_courseware_workflow_checkpoint(root, &session.id, &turn, 1, &next)
        .unwrap_err()
        .to_string()
        .contains("verified native-save"));
}

#[test]
fn required_teaching_repair_saves_only_missing_actions_and_preserves_speech_audio() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let project = fixture(&db, root);
    let original = json!({"id":"speech","type":"speech","text":"Hello.","source":"generated","audioAssetId":format!("tts-{}", "a".repeat(64))});
    let mut project = db
        .write_courseware_teaching(
            root,
            &TeachingWrite {
                project_id: project.project_id.clone(),
                page_id: project.pages[0].page_id.clone(),
                expected_source_revision: project.source.revision.clone(),
                expected_teaching_revision: project.teaching_revision.clone(),
                actions: vec![original.clone()],
            },
        )
        .unwrap();
    let question_id = "question";
    let question = json!({"id":question_id,"type":"interaction_checkpoint","checkpointId":question_id,"checkpointKind":"chapter_summary",
        "chapterId":project.pages[0].page_id,"chapterTitle":"Greetings","question":"Which greeting?",
        "response":{"kind":"single","options":["Hello","Bye"],"answerIndices":[0]},
        "referenceAnswer":{"summary":"Hello","keyPoints":["Hello is a greeting."]},
        "context":{"chapterSummary":"Hello is a greeting.","sourceSceneIds":[project.pages[0].page_id]}});
    let mut write = TeachingWrite {
        project_id: project.project_id.clone(),
        page_id: project.pages[0].page_id.clone(),
        expected_source_revision: project.source.revision.clone(),
        expected_teaching_revision: project.teaching_revision.clone(),
        actions: vec![
            json!({"id":"proposed-speech","type":"speech","text":"Hello.","source":"generated"}),
            question.clone(),
            json!({"id":"song","type":"music_slot","title":"Hello","prompt":"Sing Hello"}),
        ],
    };
    let seed = SavedProjectSeed {
        project_id: project.project_id.clone(),
        sha256: project.source.sha256.clone(),
        pages: project.pages.len(),
        identity: None,
    };
    project = db
        .repair_required_teaching(root, &seed, &project, &write)
        .unwrap();
    assert_eq!(
        project.pages[0].actions,
        vec![original.clone(), question, write.actions[2].clone()]
    );
    let report = db.courseware_completion(root, &project).unwrap();
    assert_eq!(report["issues"][0]["code"], "MUSIC_PENDING");
    write.expected_teaching_revision = project.teaching_revision.clone();
    write.actions[0]["text"] = json!("Changed paid narration.");
    assert!(db
        .repair_required_teaching(root, &seed, &project, &write)
        .is_err());
    assert_eq!(
        db.get_courseware_project(root, &project.project_id)
            .unwrap()
            .unwrap()
            .pages[0]
            .actions[0],
        original
    );
}

#[test]
fn narration_cannot_add_unapproved_music_and_repairs_legacy_unsubmitted_slots() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let mut project = fixture_with_music(&db, root, false);
    let seed = SavedProjectSeed {
        project_id: project.project_id.clone(),
        sha256: project.source.sha256.clone(),
        pages: 1,
        identity: None,
    };
    let song =
        json!({"id":"extra-song","type":"music_slot","title":"Extra","prompt":"Unapproved song"});
    let mut write = TeachingWrite {
        project_id: project.project_id.clone(),
        page_id: project.pages[0].page_id.clone(),
        expected_source_revision: project.source.revision.clone(),
        expected_teaching_revision: project.teaching_revision.clone(),
        actions: vec![
            json!({"id":"speech","type":"speech","text":"Hello.","source":"generated"}),
            song.clone(),
        ],
    };
    assert!(
        db.save_generated_narration(root, &seed, &project, &write)
            .is_err(),
        "new unapproved music must be rejected at Host"
    );
    db.stage_narration_candidate(root, &seed, "legacy-unapproved", &write)
        .unwrap();
    assert!(db
        .adopt_narration_candidate(root, &seed, "legacy-unapproved")
        .is_err());
    assert_eq!(
        db.get_courseware_project(root, &project.project_id)
            .unwrap()
            .unwrap()
            .teaching_revision,
        project.teaching_revision
    );
    project = db.write_courseware_teaching(root, &write).unwrap();
    write.expected_teaching_revision = project.teaching_revision.clone();
    write.actions.pop();
    let saved = db
        .save_generated_narration(root, &seed, &project, &write)
        .unwrap();
    assert!(
        !saved.pages[0]
            .actions
            .iter()
            .any(|a| a["type"] == "music_slot"),
        "baseline preservation must not resurrect an unsubmitted unapproved slot"
    );
    assert_eq!(saved.pages[0].actions, write.actions);
}

#[test]
fn legacy_music_cleanup_preserves_submitted_and_unknown_orders_and_paid_speech() {
    use sha2::{Digest, Sha256};
    for (phase, retained) in [
        ("prepared", false),
        ("rejected", false),
        ("submitted", true),
        ("submission-unknown", true),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let mut project = fixture_with_music(&db, root, false);
        let speech = json!({"id":"speech","type":"speech","text":"Hello.","source":"generated","audioAssetId":format!("tts-{}", "a".repeat(64))});
        let slot = json!({"id":"extra-song","type":"music_slot","title":"Extra","prompt":"Unapproved song"});
        let mut write = TeachingWrite {
            project_id: project.project_id.clone(),
            page_id: project.pages[0].page_id.clone(),
            expected_source_revision: project.source.revision.clone(),
            expected_teaching_revision: project.teaching_revision.clone(),
            actions: vec![speech.clone(), slot.clone()],
        };
        project = db.write_courseware_teaching(root, &write).unwrap();
        let journal_key =
            serde_json::to_string(&(std::fs::canonicalize(root).unwrap(), "chat", "b".repeat(64)))
                .unwrap();
        let draft = format!(
            "auto-music-{}-p1-{}-{}",
            "c".repeat(64),
            &hex::encode(Sha256::digest(b"extra-song"))[..16],
            "d".repeat(24)
        );
        let journal =
            json!([{"intentId":"historical","draft":{"id":draft},"phase":phase,"taskRef":null}]);
        db.kv_set(music::JOURNAL, &journal_key, &journal).unwrap();
        write.expected_teaching_revision = project.teaching_revision.clone();
        write.actions = vec![
            json!({"id":"proposed","type":"speech","text":"Hello."}),
            json!({"id":"question","type":"interaction_checkpoint","checkpointId":"question","checkpointKind":"chapter_summary",
                "chapterId":project.pages[0].page_id,"chapterTitle":"Greetings","question":"Which greeting?",
                "response":{"kind":"single","options":["Hello","Bye"],"answerIndices":[0]},
                "referenceAnswer":{"summary":"Hello","keyPoints":["Hello is a greeting."]},
                "context":{"chapterSummary":"Hello is a greeting.","sourceSceneIds":[project.pages[0].page_id]}}),
        ];
        let seed = SavedProjectSeed {
            project_id: project.project_id.clone(),
            sha256: project.source.sha256.clone(),
            pages: 1,
            identity: None,
        };
        let saved = db
            .repair_required_teaching(root, &seed, &project, &write)
            .unwrap();
        assert_eq!(
            saved.pages[0].actions[0], speech,
            "paid speech must remain byte-for-byte intact"
        );
        assert_eq!(
            saved.pages[0].actions.contains(&slot),
            retained,
            "phase {phase}"
        );
        assert_eq!(
            db.kv_get(music::JOURNAL, &journal_key).unwrap(),
            Some(journal),
            "cleanup never mutates the original media ledger"
        );
    }
}

#[test]
fn completion_counts_and_action_identity_match_the_saved_project() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let mut project = fixture(&db, root);
    project.pages[0].actions = (0..211).map(|i| {
        let mut speech = json!({"id":format!("speech-{i}"),"type":"speech","text":"Hello.","source":"generated"});
        if i < 210 { speech["audioAssetId"] = json!("tts-existing"); }
        speech
    }).collect();
    let completion = db.courseware_completion(root, &project).unwrap();
    assert_eq!(completion["ready"], false);
    assert_eq!(completion["counts"]["speeches"], 211);
    assert_eq!(completion["counts"]["audioReady"], 210);
    assert_eq!(completion["counts"]["audioMissing"], 1);
    assert_eq!(completion["issues"][0]["actionId"], "speech-210");
}
