use super::*;
use serde_json::json;

#[test]
fn generated_attention_uses_decoded_audio_and_auto_readies_only_generated_scenes() {
    for (task_type, generated) in [("scene", true), ("scene", false), ("import", true)] {
        use crate::db::courseware_projects::tts::{audio::Audio, Selection, TaskRef};
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let s = seed('a', "generated-attention");
        let initial = db
            .open_identified_courseware_project_with_metadata(root, &s, task_type, None)
            .unwrap();
        let context = db
            .courseware_project_context(root, &initial.project_id)
            .unwrap();
        let target = context["savedObjects"]["pages"][0]["objects"][0]["objectId"].clone();
        let mut write = TeachingWrite {
            project_id: initial.project_id.clone(),
            page_id: initial.pages[0].page_id.clone(),
            expected_source_revision: initial.source.revision.clone(),
            expected_teaching_revision: initial.teaching_revision.clone(),
            actions: vec![
                json!({"id":"speech","type":"speech","text":"Look at this object.","attention":{"type":"spotlight","objectIds":[target]}}),
            ],
        };
        if generated {
            write.actions[0]["source"] = json!("generated");
        }
        write.actions[0]["attention"]["animation"] = json!("fadeIn");
        if generated && task_type == "scene" {
            write.actions.push(json!({"id":"second-speech","type":"speech","text":"Now compare.","source":"generated","attention":{"type":"spotlight","objectIds":[target],"animation":"pulse"}}));
        }
        let valid = write.actions[0]["attention"].clone();
        write.actions[0]["attention"]["objectIds"] = json!(["invented"]);
        assert!(db
            .stage_scoped_narration_candidate(root, &s, "bad", &write, true)
            .is_err());
        write.actions[0]["attention"] = valid;
        db.stage_scoped_narration_candidate(root, &s, "generated", &write, true)
            .unwrap();
        assert!(db
            .get_courseware_project(root, &s.project_id)
            .unwrap()
            .unwrap()
            .pages[0]
            .actions
            .is_empty());
        let adopted = db.adopt_narration_candidate(root, &s, "generated").unwrap();
        assert!(adopted.pages[0].actions[0].get("visualCues").is_none());
        let selection = Selection {
            intent_id: "focus-voice".into(),
            principal_key: "c".repeat(64),
            project_id: s.project_id.clone(),
            page_id: adopted.pages[0].page_id.clone(),
            action_id: "speech".into(),
            expected_source_revision: adopted.source.revision.clone(),
            expected_teaching_revision: adopted.teaching_revision.clone(),
            model: "test-tts".into(),
            voice: None,
        };
        let prepared = db.prepare_courseware_tts(root, selection.clone()).unwrap();
        db.begin_courseware_tts(
            root,
            &s.project_id,
            &selection.principal_key,
            &selection.intent_id,
            "session",
        )
        .unwrap();
        let task = TaskRef {
            task_id: "task".into(),
            idempotency_key: prepared["intent"]["idempotencyKey"]
                .as_str()
                .unwrap()
                .into(),
            request_hash: prepared["intent"]["requestHash"].as_str().unwrap().into(),
        };
        db.bind_courseware_tts(
            root,
            &s.project_id,
            &selection.principal_key,
            &selection.intent_id,
            task.clone(),
        )
        .unwrap();
        db.stage_courseware_tts_audio(
            root,
            &s.project_id,
            &selection.principal_key,
            &selection.intent_id,
            Audio {
                task_ref: task,
                sha256: "b".repeat(64),
                mime_type: "audio/wav".into(),
                byte_length: 100,
                duration_ms: 2345,
            },
        )
        .unwrap();
        let mut ready = db
            .adopt_courseware_tts_audio(
                root,
                &s.project_id,
                &selection.principal_key,
                &selection.intent_id,
                &adopted.teaching_revision,
                None,
            )
            .unwrap();
        assert_eq!(
            ready.pages[0].review_state, "review",
            "one missing speech cannot complete a scene page"
        );
        if generated && task_type == "scene" {
            let second = Selection {
                intent_id: "second-voice".into(),
                action_id: "second-speech".into(),
                expected_teaching_revision: ready.teaching_revision.clone(),
                ..selection.clone()
            };
            let prepared = db.prepare_courseware_tts(root, second.clone()).unwrap();
            db.begin_courseware_tts(
                root,
                &s.project_id,
                &second.principal_key,
                &second.intent_id,
                "session",
            )
            .unwrap();
            let task = TaskRef {
                task_id: "second-task".into(),
                idempotency_key: prepared["intent"]["idempotencyKey"]
                    .as_str()
                    .unwrap()
                    .into(),
                request_hash: prepared["intent"]["requestHash"].as_str().unwrap().into(),
            };
            db.bind_courseware_tts(
                root,
                &s.project_id,
                &second.principal_key,
                &second.intent_id,
                task.clone(),
            )
            .unwrap();
            db.stage_courseware_tts_audio(
                root,
                &s.project_id,
                &second.principal_key,
                &second.intent_id,
                Audio {
                    task_ref: task,
                    sha256: "d".repeat(64),
                    mime_type: "audio/wav".into(),
                    byte_length: 100,
                    duration_ms: 100,
                },
            )
            .unwrap();
            ready = db
                .adopt_courseware_tts_audio(
                    root,
                    &s.project_id,
                    &second.principal_key,
                    &second.intent_id,
                    &ready.teaching_revision,
                    None,
                )
                .unwrap();
        }
        assert!(ready.pages[0].actions[0].get("attention").is_none());
        assert_eq!(
            ready.pages[0].actions[0]["visualCues"],
            json!([
                {"id":"motion-speech-0","atMs":0,"endMs":600,"effect":{"type":"element_animation","elementId":target,"effect":"fadeIn"}},
                {"id":"focus-speech","atMs":600,"endMs":2345,"effect":{"type":"spotlight","elementId":target,"elementIds":[]}}
            ])
        );
        assert_eq!(
            ready.pages[0].review_state,
            if generated && task_type == "scene" {
                "ready"
            } else {
                "review"
            }
        );
        let persisted = db
            .get_courseware_project(root, &s.project_id)
            .unwrap()
            .unwrap();
        assert_eq!(persisted.pages[0].actions, ready.pages[0].actions);
    }
}

#[test]
fn attention_source_review_requires_every_explicit_current_target_and_is_atomic() {
    for task_type in ["plain", "import", "scene"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let old = seed('a', "effects-review");
        let next = seed('b', "effects-review");
        let initial = db
            .open_identified_courseware_project_with_metadata(root, &old, task_type, None)
            .unwrap();
        let context = db
            .courseware_project_context(root, &initial.project_id)
            .unwrap();
        let objects = context["savedObjects"]["pages"][0]["objects"]
            .as_array()
            .unwrap();
        let first = objects[0]["objectId"].as_str().unwrap();
        let second = objects[1]["objectId"].as_str().unwrap();
        let actions = vec![
            json!({"id":"speech","type":"speech","text":"Find both.","source":"generated","pauseAfterMs":1200,"visualCues":[
                {"id":"highlight","atMs":0,"endMs":800,"effect":{"type":"highlight","elementIds":[first,second],"color":"#ff00aa","opacity":0.5}},
                {"id":"spotlight","atMs":800,"endMs":1900,"effect":{"type":"spotlight","elementId":second,"elementIds":[first],"dimOpacity":0.7}},
                {"id":"motion","atMs":0,"endMs":600,"effect":{"type":"element_animation","elementId":first,"effect":"fadeIn"}}
            ]}),
            json!({"id":"wait","type":"interaction_checkpoint","checkpointId":"wait","checkpointKind":"teacher_continue"}),
            json!({"id":"pending-focus","type":"speech","text":"Look again.","attention":{"type":"highlight","objectIds":[first]}}),
        ];
        let project = write(&db, root, &initial, actions.clone());
        let review = db.prepare_courseware_review(root, &next).unwrap();
        assert_eq!(review["effectTargets"].as_array().unwrap().len(), 2);
        assert_eq!(
            review["targetPages"][0]["objects"][0],
            json!({"index":1,"kind":"shape"})
        );
        let id = review["reviewId"].as_str().unwrap();
        let pages = [Some(project.pages[0].page_id.clone())];
        let bindings = vec![
            json!({"pageIndex":0,"objectId":first,"targetIndex":2}),
            json!({"pageIndex":0,"objectId":second,"targetIndex":1}),
        ];
        for bad in [
            vec![],
            bindings[..1].to_vec(),
            vec![
                bindings[0].clone(),
                json!({"pageIndex":0,"objectId":second,"targetIndex":2}),
            ],
            vec![
                bindings[0].clone(),
                json!({"pageIndex":1,"objectId":second,"targetIndex":1}),
            ],
            vec![
                bindings[0].clone(),
                json!({"pageIndex":0,"objectId":"raw-ooxml-id","targetIndex":1}),
            ],
            vec![
                bindings[0].clone(),
                json!({"pageIndex":0,"objectId":second,"targetIndex":99}),
            ],
        ] {
            assert!(db
                .adopt_courseware_review_with_effects(root, &next, id, &pages, &bad)
                .is_err());
            assert_eq!(
                serde_json::to_value(
                    db.get_courseware_project(root, &project.project_id)
                        .unwrap()
                        .unwrap()
                )
                .unwrap(),
                serde_json::to_value(&project).unwrap()
            );
        }
        assert!(db
            .adopt_courseware_review_with_effects(root, &next, id, &[None], &bindings)
            .is_err());
        db.conn.execute_batch("CREATE TRIGGER effects_adoption_failure BEFORE UPDATE ON kv WHEN NEW.ns='coursewareProjects.v1' BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        assert!(db
            .adopt_courseware_review_with_effects(root, &next, id, &pages, &bindings)
            .is_err());
        db.conn
            .execute_batch("DROP TRIGGER effects_adoption_failure;")
            .unwrap();
        let adopted = db
            .adopt_courseware_review_with_effects(root, &next, id, &pages, &bindings)
            .unwrap();
        let current = db
            .courseware_project_context(root, &adopted.project_id)
            .unwrap();
        let new_objects = &current["savedObjects"]["pages"][0]["objects"];
        let mut expected = actions;
        expected[0]["visualCues"][0]["effect"]["elementIds"] =
            json!([new_objects[1]["objectId"], new_objects[0]["objectId"]]);
        expected[0]["visualCues"][1]["effect"]["elementId"] = new_objects[0]["objectId"].clone();
        expected[0]["visualCues"][1]["effect"]["elementIds"] = json!([new_objects[1]["objectId"]]);
        expected[0]["visualCues"][2]["effect"]["elementId"] = new_objects[1]["objectId"].clone();
        expected[2]["attention"]["objectIds"] = json!([new_objects[1]["objectId"]]);
        assert_eq!(adopted.pages[0].actions, expected);
        assert_eq!(adopted.pages[0].review_state, "review");
        assert_ne!(new_objects[0]["objectId"], first);
        assert_ne!(new_objects[1]["objectId"], second);
        assert!(db
            .adopt_courseware_review_with_effects(root, &next, id, &pages, &bindings)
            .is_err());
    }
}

#[test]
fn attention_source_review_rejects_unknown_cues_and_real_unsupported_kinds() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let old = seed('a', "unsupported-effect");
    let mut next = seed('b', "unsupported-effect");
    let project = db.open_identified_courseware_project(root, &old).unwrap();
    let context = db
        .courseware_project_context(root, &project.project_id)
        .unwrap();
    let object = context["savedObjects"]["pages"][0]["objects"][0]["objectId"].clone();
    let changed = write(
        &db,
        root,
        &project,
        vec![
            json!({"id":"speech","type":"speech","text":"Test","visualCues":[{"id":"bad","atMs":0,"endMs":800,"effect":{"type":"element_animation","elementId":object}}]}),
        ],
    );
    assert!(db.prepare_courseware_review(root, &next).is_err());
    let changed = write(
        &db,
        root,
        &changed,
        vec![
            json!({"id":"speech","type":"speech","text":"Test","visualCues":[{"id":"cue","atMs":0,"endMs":800,"effect":{"type":"highlight","elementIds":[object]}}]}),
        ],
    );
    let mut value = next.identity.unwrap().value().clone();
    value["pages"][0]["objects"][0]["type"] = json!("line");
    next.identity = Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap());
    let review = db.prepare_courseware_review(root, &next).unwrap();
    assert!(db
        .adopt_courseware_review_with_effects(
            root,
            &next,
            review["reviewId"].as_str().unwrap(),
            &[Some(changed.pages[0].page_id.clone())],
            &[json!({"pageIndex":0,"objectId":object,"targetIndex":1})]
        )
        .is_err());
}

pub(super) fn seed(hash: char, project_id: &str) -> SavedProjectSeed {
    let mut value: Value = serde_json::from_slice(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    value["sourceSha256"] = json!(hash.to_string().repeat(64));
    SavedProjectSeed {
        project_id: project_id.into(),
        sha256: hash.to_string().repeat(64),
        pages: 1,
        identity: Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap()),
    }
}

pub(super) fn write(
    db: &Database,
    root: &str,
    project: &CoursewareProject,
    actions: Vec<Value>,
) -> CoursewareProject {
    db.write_courseware_teaching(
        root,
        &TeachingWrite {
            project_id: project.project_id.clone(),
            page_id: project.pages[0].page_id.clone(),
            expected_source_revision: project.source.revision.clone(),
            expected_teaching_revision: project.teaching_revision.clone(),
            actions,
        },
    )
    .unwrap()
}

#[test]
fn durable_explicit_review_adopts_locked_narration_and_preserves_old_version() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let old = seed('a', "office-review");
    let next = seed('b', "office-review");
    let project;
    let review;
    {
        let db = Database::open(&path).unwrap();
        let initial = db.open_identified_courseware_project(root, &old).unwrap();
        let edited = write(
            &db,
            root,
            &initial,
            vec![json!({"id":"speech-1","type":"speech","text":"Good!","pauseAfterMs":30000})],
        );
        project = db
            .set_courseware_page_lock(
                root,
                &edited.project_id,
                &edited.pages[0].page_id,
                &edited.source.revision,
                &edited.teaching_revision,
                true,
            )
            .unwrap();
        review = db.prepare_courseware_review(root, &next).unwrap();
        assert_eq!(db.prepare_courseware_review(root, &next).unwrap(), review);
    }
    let db = Database::open(&path).unwrap();
    let id = review["reviewId"].as_str().unwrap();
    assert!(db
        .adopt_courseware_review(root, &next, id, &[None])
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_LOCKED"));
    assert!(db
        .adopt_courseware_review(
            "/another/workspace",
            &next,
            id,
            &[Some(project.pages[0].page_id.clone())]
        )
        .is_err());
    let adopted = db
        .adopt_courseware_review(root, &next, id, &[Some(project.pages[0].page_id.clone())])
        .unwrap();
    assert_eq!(adopted.pages[0].page_id, project.pages[0].page_id);
    assert_eq!(adopted.pages[0].actions, project.pages[0].actions);
    assert!(adopted.pages[0].locked);
    assert_eq!(adopted.source.sha256, next.sha256);
    assert_ne!(adopted.teaching_revision, project.teaching_revision);
    assert!(db
        .adopt_courseware_review(root, &next, id, &[Some(project.pages[0].page_id.clone())])
        .is_err());
    let history: String = db
        .conn
        .query_row(
            "SELECT value_json FROM kv WHERE ns=?1",
            [HISTORY_NAMESPACE],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&history).unwrap(),
        serde_json::to_value(project).unwrap()
    );
    let count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM kv WHERE ns=?1",
            [IDENTITY_NAMESPACE],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn stale_review_unsupported_effects_and_sql_failure_do_not_adopt() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let old = seed('a', "office-review");
    let next = seed('b', "office-review");
    let initial = db.open_identified_courseware_project(root, &old).unwrap();
    let review = db.prepare_courseware_review(root, &next).unwrap();
    let changed = write(
        &db,
        root,
        &initial,
        vec![json!({"id":"speech","type":"speech","text":"New","pauseAfterMs":4000})],
    );
    assert!(db
        .adopt_courseware_review(
            root,
            &next,
            review["reviewId"].as_str().unwrap(),
            &[Some(changed.pages[0].page_id.clone())]
        )
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_CONFLICT"));
    let review = db.prepare_courseware_review(root, &next).unwrap();
    assert!(db
        .adopt_courseware_review(
            root,
            &next,
            review["reviewId"].as_str().unwrap(),
            &[Some("not-a-page".into())]
        )
        .is_err());
    db.conn.execute_batch("CREATE TRIGGER adoption_failure BEFORE UPDATE ON kv WHEN NEW.ns='coursewareProjects.v1' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(db
        .adopt_courseware_review(
            root,
            &next,
            review["reviewId"].as_str().unwrap(),
            &[Some(changed.pages[0].page_id.clone())]
        )
        .is_err());
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_project(root, &old.project_id)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&changed).unwrap()
    );
    let count:i64=db.conn.query_row("SELECT COUNT(*) FROM kv WHERE ns IN ('coursewareHistory.v1','coursewareIdentities.v1')",[],|row|row.get(0)).unwrap();
    assert_eq!(count, 1);
    db.conn
        .execute_batch("DROP TRIGGER adoption_failure;")
        .unwrap();
    for action in [
        json!({"id":"speech","type":"speech","text":"New","audioId":"old-audio"}),
        json!({"id":"highlight","type":"highlight","target":"old-object"}),
    ] {
        let project = db
            .get_courseware_project(root, &old.project_id)
            .unwrap()
            .unwrap();
        write(&db, root, &project, vec![action]);
        assert!(db
            .prepare_courseware_review(root, &next)
            .unwrap_err()
            .to_string()
            .contains("COURSEWARE_INVALID"));
    }
}

#[test]
fn explicit_reorder_copy_and_omission_never_duplicate_old_identity() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let mut old = seed('a', "office-review");
    let mut value = old.identity.take().unwrap().value().clone();
    let mut second = value["pages"][0].clone();
    second["logicalId"] = json!("second");
    second["importPageId"] = json!("page_2");
    second["objects"] = json!([]);
    value["pages"].as_array_mut().unwrap().push(second);
    old.pages = 2;
    old.identity = Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap());
    let initial = db.open_identified_courseware_project(root, &old).unwrap();
    let initial = write(
        &db,
        root,
        &initial,
        vec![json!({"id":"first","type":"speech","text":"First","pauseAfterMs":4000})],
    );
    let initial = db
        .write_courseware_teaching(
            root,
            &TeachingWrite {
                project_id: initial.project_id.clone(),
                page_id: initial.pages[1].page_id.clone(),
                expected_source_revision: initial.source.revision.clone(),
                expected_teaching_revision: initial.teaching_revision.clone(),
                actions: vec![
                    json!({"id":"second","type":"speech","text":"Second","pauseAfterMs":0}),
                ],
            },
        )
        .unwrap();
    let mut next = seed('b', "office-review");
    value["sourceSha256"] = json!(next.sha256);
    next.pages = 2;
    next.identity = Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap());
    let review = db.prepare_courseware_review(root, &next).unwrap();
    let id = review["reviewId"].as_str().unwrap();
    assert!(db
        .adopt_courseware_review(
            root,
            &next,
            id,
            &[
                Some(initial.pages[0].page_id.clone()),
                Some(initial.pages[0].page_id.clone())
            ]
        )
        .is_err());
    let adopted = db
        .adopt_courseware_review(
            root,
            &next,
            id,
            &[Some(initial.pages[1].page_id.clone()), None],
        )
        .unwrap();
    assert_eq!(adopted.pages[0].page_id, initial.pages[1].page_id);
    assert_eq!(adopted.pages[0].actions, initial.pages[1].actions);
    assert_eq!(adopted.pages[0].review_state, "review");
    assert!(!initial
        .pages
        .iter()
        .any(|page| page.page_id == adopted.pages[1].page_id));
    assert!(adopted.pages[1].actions.is_empty());
}

#[test]
fn source_review_rebinds_adopted_audio_without_changing_paid_intent() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let principal = "a".repeat(64);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let initial = db
        .open_identified_courseware_project(root, &seed('a', "office-review"))
        .unwrap();
    let edited = write(
        &db,
        root,
        &initial,
        vec![json!({"id":"speech","type":"speech","text":"Keep the audio","source":"notes"})],
    );
    let selection = tts::Selection {
        intent_id: "audio-intent".into(),
        principal_key: principal.clone(),
        project_id: edited.project_id.clone(),
        page_id: edited.pages[0].page_id.clone(),
        action_id: "speech".into(),
        expected_source_revision: edited.source.revision.clone(),
        expected_teaching_revision: edited.teaching_revision.clone(),
        model: "courseware-tts-v1".into(),
        voice: Some("teacher_1".into()),
    };
    let prepared = db.prepare_courseware_tts(root, selection).unwrap();
    db.begin_courseware_tts(
        root,
        &edited.project_id,
        &principal,
        "audio-intent",
        "test-session",
    )
    .unwrap();
    let task = tts::TaskRef {
        task_id: "paid-task".into(),
        idempotency_key: prepared["intent"]["idempotencyKey"]
            .as_str()
            .unwrap()
            .into(),
        request_hash: prepared["intent"]["requestHash"].as_str().unwrap().into(),
    };
    db.bind_courseware_tts(
        root,
        &edited.project_id,
        &principal,
        "audio-intent",
        task.clone(),
    )
    .unwrap();
    let audio = tts::audio::Audio {
        task_ref: task,
        sha256: "d".repeat(64),
        mime_type: "audio/wav".into(),
        byte_length: 1644,
        duration_ms: 100,
    };
    db.stage_courseware_tts_audio(root, &edited.project_id, &principal, "audio-intent", audio)
        .unwrap();
    let adopted = db
        .adopt_courseware_tts_audio(
            root,
            &edited.project_id,
            &principal,
            "audio-intent",
            &edited.teaching_revision,
            None,
        )
        .unwrap();
    let original_intent = db
        .get_courseware_tts(root, &edited.project_id, &principal, "audio-intent")
        .unwrap()["intent"]
        .clone();
    let locked = db
        .set_courseware_page_lock(
            root,
            &adopted.project_id,
            &adopted.pages[0].page_id,
            &adopted.source.revision,
            &adopted.teaching_revision,
            true,
        )
        .unwrap();
    let next = seed('b', "office-review");
    let review = db.prepare_courseware_review(root, &next).unwrap();
    db.conn.execute_batch("CREATE TRIGGER reject_audio_rebind BEFORE UPDATE ON kv WHEN OLD.ns='coursewareTtsAudio.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(db
        .adopt_courseware_review(
            root,
            &next,
            review["reviewId"].as_str().unwrap(),
            &[Some(locked.pages[0].page_id.clone())]
        )
        .is_err());
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_project(root, &locked.project_id)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&locked).unwrap()
    );
    assert!(db
        .get_courseware_tts_audio(root, &locked.project_id, &principal, "audio-intent")
        .unwrap()
        .bound_source
        .is_none());
    db.conn
        .execute_batch("DROP TRIGGER reject_audio_rebind")
        .unwrap();
    for hash in ['b', 'c', 'a', 'b'] {
        let next = seed(hash, "office-review");
        let review = db.prepare_courseware_review(root, &next).unwrap();
        let moved = db
            .adopt_courseware_review(
                root,
                &next,
                review["reviewId"].as_str().unwrap(),
                &[Some(locked.pages[0].page_id.clone())],
            )
            .unwrap();
        assert_eq!(moved.pages[0].actions, locked.pages[0].actions);
        assert!(moved.pages[0].locked);
        assert_eq!(
            db.get_courseware_tts(root, &locked.project_id, &principal, "audio-intent")
                .unwrap()["intent"],
            original_intent
        );
        let record = db
            .get_courseware_tts_audio(root, &locked.project_id, &principal, "audio-intent")
            .unwrap();
        assert_eq!(record.bound_source.as_ref().unwrap().sha256, next.sha256);
    }
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let record = db
        .get_courseware_tts_audio(root, &locked.project_id, &principal, "audio-intent")
        .unwrap();
    assert_eq!(record.bound_source.unwrap().sha256, "b".repeat(64));
    assert!(db
        .get_courseware_tts_audio(root, &locked.project_id, &"e".repeat(64), "audio-intent")
        .is_err());
}

#[test]
fn source_review_refuses_audio_without_an_adopted_receipt() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let initial = db
        .open_identified_courseware_project(root, &seed('a', "office-review"))
        .unwrap();
    let project = write(
        &db,
        root,
        &initial,
        vec![json!({
            "id":"speech", "type":"speech", "text":"Unverified audio",
            "audioAssetId":format!("tts-{}", "d".repeat(64))
        })],
    );
    let next = seed('b', "office-review");
    let review = db.prepare_courseware_review(root, &next).unwrap();
    let error = db
        .adopt_courseware_review(
            root,
            &next,
            review["reviewId"].as_str().unwrap(),
            &[Some(project.pages[0].page_id.clone())],
        )
        .unwrap_err();
    assert!(error.to_string().contains("COURSEWARE_AUDIO_REQUIRED"));
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_project(root, &project.project_id)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&project).unwrap()
    );
}

#[test]
fn source_review_preserves_manual_narration_origins_after_restart() {
    for source in ["notes", "external"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let old = seed('a', "office-review");
        let next = seed('b', "office-review");
        let project;
        let review;
        {
            let db = Database::open_in_dir(dir.path()).unwrap();
            let initial = db.open_identified_courseware_project(root, &old).unwrap();
            project = write(
                &db,
                root,
                &initial,
                vec![
                    json!({"id":"speech","type":"speech","text":"Keep the selected text","source":source,"pauseAfterMs":4000}),
                ],
            );
            review = db.prepare_courseware_review(root, &next).unwrap();
        }
        let db = Database::open_in_dir(dir.path()).unwrap();
        let adopted = db
            .adopt_courseware_review(
                root,
                &next,
                review["reviewId"].as_str().unwrap(),
                &[Some(project.pages[0].page_id.clone())],
            )
            .unwrap();
        assert_eq!(adopted.pages[0].actions, project.pages[0].actions);
        assert_eq!(adopted.pages[0].page_id, project.pages[0].page_id);
        assert_eq!(adopted.source.sha256, next.sha256);
        assert_eq!(adopted.pages[0].review_state, "review");
    }
}

#[test]
fn source_review_rejects_unsafe_pauses_and_bound_media_without_mutation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let old = seed('a', "office-review");
    let next = seed('b', "office-review");
    db.open_identified_courseware_project(root, &old).unwrap();
    let mut bad = Vec::new();
    for pause in [
        json!(-1),
        json!(30001),
        json!(1.5),
        json!("4000"),
        Value::Null,
        json!(true),
    ] {
        bad.push(json!({"id":"speech","type":"speech","text":"Keep me","pauseAfterMs":pause}));
    }
    for (key, value) in [
        ("audioId", json!("audio")),
        ("voice", json!("voice")),
        ("cue", json!("object")),
        ("effects", json!([])),
    ] {
        let mut action =
            json!({"id":"speech","type":"speech","text":"Keep me","pauseAfterMs":4000});
        action[key] = value;
        bad.push(action);
    }
    bad.push(json!({"id":"wait","type":"wait","durationMs":4000}));
    for source in [json!("other"), json!(true), json!(0), Value::Null] {
        bad.push(json!({"id":"speech","type":"speech","text":"Keep me","source":source}));
    }
    for action in bad {
        let project = db
            .get_courseware_project(root, &old.project_id)
            .unwrap()
            .unwrap();
        let project = write(&db, root, &project, vec![action.clone()]);
        assert!(
            db.prepare_courseware_review(root, &next)
                .unwrap_err()
                .to_string()
                .contains("COURSEWARE_INVALID"),
            "{action}"
        );
        assert_eq!(
            serde_json::to_value(
                db.get_courseware_project(root, &old.project_id)
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(project).unwrap()
        );
    }
    let count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM kv WHERE ns IN ('coursewareHistory.v1','coursewareReviews.v1')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn speech_animation_sequence_allows_serial_emphasis_without_duplicate_owners() {
    let speech = |effects: &[&str]| {
        json!({"type":"speech","visualCues":effects.iter().map(|effect| json!({
        "effect":{"type":"element_animation","elementId":"monkey","effect":effect}
    })).collect::<Vec<_>>()})
    };
    for motions in [vec!["fadeIn", "pulse", "pulse"], vec!["pulse", "pulse"]] {
        let actions: Vec<_> = motions.iter().map(|motion| speech(&[motion])).collect();
        effects::validate_animation_sequence(&actions).unwrap();
    }
    for actions in [
        vec![speech(&["pulse", "pulse"])],
        vec![speech(&["fadeIn"]), speech(&["fadeIn"])],
        vec![speech(&["fadeOut"]), speech(&["pulse"])],
    ] {
        assert!(effects::validate_animation_sequence(&actions).is_err());
    }
}
