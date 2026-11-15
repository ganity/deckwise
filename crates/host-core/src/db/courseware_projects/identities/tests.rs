use super::*;
use serde_json::json;

fn fixture_seed() -> SavedProjectSeed {
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    SavedProjectSeed {
        project_id: "office-identity-test".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    }
}

fn identity(db: &Database) -> Value {
    db.conn
        .query_row(
            "SELECT value_json FROM kv WHERE ns = ?1",
            [IDENTITY_NAMESPACE],
            |row| row.get::<_, String>(0),
        )
        .map(|text| serde_json::from_str(&text).unwrap())
        .unwrap()
}

fn fallback_upgrade_seeds() -> (SavedProjectSeed, SavedProjectSeed) {
    let mut old = fixture_seed();
    let mut value = old.identity.as_ref().unwrap().value().clone();
    value["diagnostics"] = json!([{ "code":"pptx_fallback_ooxml", "message":"Legacy fallback", "severity":"warning" }]);
    for (index, object) in value["pages"][0]["objects"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        object["sourceObjectName"] = json!(format!("Native {index}"));
    }
    old.identity = Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap());
    let mut fresh = SavedProjectSeed {
        project_id: old.project_id.clone(),
        sha256: old.sha256.clone(),
        pages: old.pages,
        identity: None,
    };
    value["diagnostics"] = json!([]);
    value["pages"][0]["contentFingerprint"] = json!("c".repeat(64));
    value["pages"][0]["objects"][0]["type"] = json!("text");
    for (index, object) in value["pages"][0]["objects"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        object["importElementId"] = json!(format!("primary-{index}"));
        object["contentFingerprint"] = json!("d".repeat(64));
        object["geometryFingerprint"] = json!("e".repeat(64));
    }
    value["pages"][0]["objects"]
        .as_array_mut()
        .unwrap()
        .reverse();
    fresh.identity =
        Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap());
    (old, fresh)
}

#[test]
fn same_source_fallback_upgrade_preserves_teaching_cues_locks_and_native_object_ids() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let workspace = dir.path().to_str().unwrap();
    let db = Database::open(&path).unwrap();
    let (old, fresh) = fallback_upgrade_seeds();
    let project = db
        .open_identified_courseware_project(workspace, &old)
        .unwrap();
    let previous = identity(&db);
    let narrated = db.write_courseware_teaching(workspace, &TeachingWrite {
        project_id: project.project_id.clone(), page_id: project.pages[0].page_id.clone(),
        expected_source_revision: project.source.revision.clone(), expected_teaching_revision: project.teaching_revision,
        actions: vec![json!({ "id":"speech", "type":"speech", "text":"Keep this narration", "pauseAfterMs":1000,
            "visualCues":[{"id":"cue", "atMs":0, "endMs":1000, "effect":{"type":"spotlight",
                "elementIds":[previous["pages"][0]["objects"][0]["logicalId"]], "dimOpacity":0.8}}] })],
    }).unwrap();
    let locked = db
        .set_courseware_page_lock(
            workspace,
            &narrated.project_id,
            &narrated.pages[0].page_id,
            &narrated.source.revision,
            &narrated.teaching_revision,
            true,
        )
        .unwrap();
    let reopened = db
        .open_identified_courseware_project(workspace, &fresh)
        .unwrap();
    assert_eq!(
        serde_json::to_value(&reopened).unwrap(),
        serde_json::to_value(&locked).unwrap()
    );
    let upgraded = identity(&db);
    assert!(
        SavedSourceIdentity::parse(&serde_json::to_vec(&upgraded).unwrap())
            .unwrap()
            .same_export(fresh.identity.as_ref().unwrap())
    );
    assert_ne!(upgraded["mappingRevision"], previous["mappingRevision"]);
    for object in upgraded["pages"][0]["objects"].as_array().unwrap() {
        let old = previous["pages"][0]["objects"]
            .as_array()
            .unwrap()
            .iter()
            .find(|old| old["sourceShapeId"] == object["sourceShapeId"])
            .unwrap();
        assert_eq!(object["logicalId"], old["logicalId"]);
    }
    let history_key = serde_json::to_string(&(
        identity_key(workspace, &old.project_id, &old.sha256).unwrap(),
        &previous["mappingRevision"],
    ))
    .unwrap();
    assert_eq!(
        db.kv_get("coursewareIdentityHistory.v1", &history_key)
            .unwrap(),
        Some(previous)
    );
    drop(db);
    let db = Database::open(&path).unwrap();
    let again = db
        .open_identified_courseware_project(workspace, &fresh)
        .unwrap();
    assert_eq!(
        serde_json::to_value(again).unwrap(),
        serde_json::to_value(locked).unwrap()
    );
    assert_eq!(identity(&db), upgraded);
}

#[test]
fn fallback_upgrade_rejects_unverified_or_ambiguous_native_inventory_atomically() {
    for case in [
        "no-fallback",
        "still-fallback",
        "missing-name",
        "renamed",
        "duplicate-native-id",
        "unknown-native-id",
        "image-kind",
        "page-id",
        "missing-object",
        "parse-error",
        "archive-failure",
        "archive-ignored",
        "mapping-ignored",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (mut old, mut fresh) = fallback_upgrade_seeds();
        if case == "no-fallback" {
            let mut value = old.identity.as_ref().unwrap().value().clone();
            value["diagnostics"] = json!([]);
            old.identity =
                Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap());
        }
        let project = db
            .open_identified_courseware_project(workspace, &old)
            .unwrap();
        let previous = identity(&db);
        let mut value = fresh.identity.as_ref().unwrap().value().clone();
        match case {
            "still-fallback" => value["diagnostics"] = old.identity.as_ref().unwrap().value()["diagnostics"].clone(),
            "missing-name" => { value["pages"][0]["objects"][0].as_object_mut().unwrap().remove("sourceObjectName"); }
            "renamed" => value["pages"][0]["objects"][0]["sourceObjectName"] = json!("Different"),
            "duplicate-native-id" => value["pages"][0]["objects"][0]["sourceShapeId"] = value["pages"][0]["objects"][1]["sourceShapeId"].clone(),
            "unknown-native-id" => value["pages"][0]["objects"][0]["sourceShapeId"] = json!("unknown"),
            "image-kind" => value["pages"][0]["objects"][0]["type"] = json!("text"),
            "page-id" => value["pages"][0]["importPageId"] = json!("other-page"),
            "missing-object" => { value["pages"][0]["objects"].as_array_mut().unwrap().pop(); }
            "parse-error" => value["diagnostics"] = json!([{ "code":"broken", "message":"Broken source", "severity":"error" }]),
            "archive-failure" => db.conn.execute_batch("CREATE TRIGGER archive_failure BEFORE INSERT ON kv WHEN NEW.ns='coursewareIdentityHistory.v1' BEGIN SELECT RAISE(ABORT, 'fixture archive failure'); END;").unwrap(),
            "archive-ignored" => db.conn.execute_batch("CREATE TRIGGER archive_ignored BEFORE INSERT ON kv WHEN NEW.ns='coursewareIdentityHistory.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap(),
            "mapping-ignored" => db.conn.execute_batch("CREATE TRIGGER mapping_ignored BEFORE UPDATE ON kv WHEN NEW.ns='coursewareIdentities.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap(),
            _ => (),
        }
        fresh.identity =
            Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap());
        assert!(
            db.open_identified_courseware_project(workspace, &fresh)
                .is_err(),
            "{case}"
        );
        assert_eq!(identity(&db), previous, "{case}");
        assert_eq!(
            serde_json::to_value(
                db.get_courseware_project(workspace, &project.project_id)
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(project).unwrap(),
            "{case}"
        );
    }
}

#[test]
fn draft_recovery_retains_conflicting_edits_and_rebases_only_unchanged_pages() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let workspace = dir.path().to_str().unwrap();
    let seed = fixture_seed();
    let project = db
        .open_identified_courseware_project(workspace, &seed)
        .unwrap();
    let key = serde_json::to_string(&(
        workspace,
        "session",
        &project.project_id,
        &project.pages[0].page_id,
    ))
    .unwrap();
    let draft = json!({"revision":"draft-1", "baseline":project,
        "actions":[{"id":"speech", "type":"speech", "text":"Unsaved"}], "instruction":""});
    db.kv_set("coursewareTeachingDrafts.v1", &key, &draft)
        .unwrap();
    let mut next = project.clone();
    next.teaching_revision = "another-page-revision".into();
    let rebased = db
        .reconcile_courseware_draft(workspace, &next, &project.pages[0].page_id, &key, &draft)
        .unwrap()
        .unwrap();
    assert_eq!(rebased["baseline"], serde_json::to_value(&next).unwrap());
    assert_eq!(rebased["actions"], draft["actions"]);
    assert_ne!(rebased["revision"], draft["revision"]);
    for failure in [
        "changed-page",
        "locked",
        "unknown-source",
        "source-animations",
    ] {
        let mut changed = next.clone();
        let mut retained = draft.clone();
        match failure {
            "changed-page" => {
                changed.pages[0].actions =
                    vec![json!({"id":"other", "type":"speech", "text":"Saved elsewhere"})]
            }
            "locked" => changed.pages[0].locked = true,
            "unknown-source" | "source-animations" => {
                changed.source.sha256 = "b".repeat(64);
                if failure == "source-animations" {
                    retained["actions"] = json!([{"id":"native", "type":"native_animation"}]);
                }
            }
            _ => unreachable!(),
        }
        db.kv_set("coursewareTeachingDrafts.v1", &key, &retained)
            .unwrap();
        assert_eq!(
            db.reconcile_courseware_draft(
                workspace,
                &changed,
                &project.pages[0].page_id,
                &key,
                &retained
            )
            .unwrap()
            .unwrap(),
            retained,
            "{failure}"
        );
        assert_eq!(
            db.kv_get("coursewareTeachingDrafts.v1", &key)
                .unwrap()
                .unwrap(),
            retained
        );
    }
    let mut instruction = draft.clone();
    instruction["actions"] = json!([]);
    instruction["instruction"] = json!("Keep this rewrite instruction");
    db.kv_set("coursewareTeachingDrafts.v1", &key, &instruction)
        .unwrap();
    assert!(db
        .reconcile_courseware_draft(
            workspace,
            &project,
            &project.pages[0].page_id,
            &key,
            &instruction
        )
        .unwrap()
        .is_some());
}

#[test]
fn animation_only_saved_source_reopens_without_losing_teaching_or_object_ids() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let workspace = dir.path().to_str().unwrap();
    let mut seed = fixture_seed();
    let mut raw = seed.identity.as_ref().unwrap().value().clone();
    for (i, object) in raw["pages"][0]["objects"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        object["sourceObjectName"] = json!(format!("lesson-picture-{i}"));
    }
    seed.identity = Some(SavedSourceIdentity::parse(&serde_json::to_vec(&raw).unwrap()).unwrap());
    let project = db
        .open_identified_courseware_project_with_metadata(workspace, &seed, "scene", None)
        .unwrap();
    let narrated = db
        .initialize_generated_narration(
            workspace,
            &project.project_id,
            &seed.sha256,
            "Lesson",
            &["Keep this narration.".into()],
        )
        .unwrap();
    let previous_identity = identity(&db);
    let mut actions = narrated.pages[0].actions.clone();
    actions[0]["visualCues"] = json!([{"id":"cue", "atMs":0, "endMs":1000,
        "effect":{"type":"spotlight", "elementIds":[previous_identity["pages"][0]["objects"][0]["logicalId"]], "dimOpacity":0.8}}]);
    let narrated = db
        .write_courseware_teaching(
            workspace,
            &TeachingWrite {
                project_id: narrated.project_id.clone(),
                page_id: narrated.pages[0].page_id.clone(),
                expected_source_revision: narrated.source.revision.clone(),
                expected_teaching_revision: narrated.teaching_revision.clone(),
                actions,
            },
        )
        .unwrap();
    let narrated = db
        .set_courseware_page_lock(
            workspace,
            &narrated.project_id,
            &narrated.pages[0].page_id,
            &narrated.source.revision,
            &narrated.teaching_revision,
            true,
        )
        .unwrap();
    seed.sha256 = "b".repeat(64);
    raw["sourceSha256"] = json!(seed.sha256);
    raw["pages"][0]["objects"][0]["sourceShapeId"] = json!("984567");
    raw["pages"][0]["objects"][0]["geometryFingerprint"] = json!("c".repeat(64));
    seed.identity = Some(SavedSourceIdentity::parse(&serde_json::to_vec(&raw).unwrap()).unwrap());
    let reopened = db
        .open_identified_courseware_project(workspace, &seed)
        .unwrap();
    assert_eq!(reopened.source.sha256, seed.sha256);
    assert_eq!(
        serde_json::to_value(&reopened.pages).unwrap(),
        serde_json::to_value(&narrated.pages).unwrap()
    );
    assert_ne!(reopened.teaching_revision, narrated.teaching_revision);
    let mapping = db.courseware_mapping(workspace, &reopened).unwrap();
    assert_eq!(
        mapping["pages"][0]["objects"][0]["objectId"],
        previous_identity["pages"][0]["objects"][0]["logicalId"]
    );
    assert_eq!(
        db.open_identified_courseware_project(workspace, &seed)
            .unwrap()
            .teaching_revision,
        reopened.teaching_revision
    );
    assert_eq!(
        db.kv_get(
            IDENTITY_NAMESPACE,
            &identity_key(workspace, &project.project_id, &project.source.sha256).unwrap()
        )
        .unwrap()
        .unwrap(),
        previous_identity
    );
    assert_eq!(
        db.kv_get(
            HISTORY_NAMESPACE,
            &serde_json::to_string(&(
                &storage_key(workspace, &project.project_id).unwrap(),
                &narrated.teaching_revision
            ))
            .unwrap()
        )
        .unwrap()
        .unwrap(),
        serde_json::to_value(&narrated).unwrap()
    );
}

#[test]
fn saved_source_recovery_refuses_changed_or_ambiguous_inventories_without_writes() {
    for failure in [
        "content",
        "page",
        "count",
        "name",
        "duplicate",
        "missing",
        "order",
        "animation",
        "pending",
        "diagnostic",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let workspace = dir.path().to_str().unwrap();
        let mut seed = fixture_seed();
        let mut raw = seed.identity.as_ref().unwrap().value().clone();
        for (i, object) in raw["pages"][0]["objects"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            object["sourceObjectName"] = json!(format!("lesson-picture-{i}"));
        }
        seed.identity =
            Some(SavedSourceIdentity::parse(&serde_json::to_vec(&raw).unwrap()).unwrap());
        let mut previous = db
            .open_identified_courseware_project(workspace, &seed)
            .unwrap();
        if failure == "animation" {
            previous.pages[0].actions = vec![
                json!({"id":"animation", "type":"native_animation", "version":1,
                "sourceSha256":previous.source.sha256, "stepIndex":0}),
            ];
            db.kv_set(
                NAMESPACE,
                &storage_key(workspace, &seed.project_id).unwrap(),
                &serde_json::to_value(&previous).unwrap(),
            )
            .unwrap();
        }
        if failure == "pending" {
            db.kv_set(
                "coursewareNativeSavePending.v1",
                &storage_key(workspace, "native-save").unwrap(),
                &json!("pending-save"),
            )
            .unwrap();
        }
        let old_identity = identity(&db);
        raw["sourceSha256"] = json!("b".repeat(64));
        match failure {
            "content" => {
                raw["pages"][0]["objects"][0]["contentFingerprint"] = json!("c".repeat(64))
            }
            "page" => raw["pages"][0]["contentFingerprint"] = json!("c".repeat(64)),
            "count" => {
                raw["pages"][0]["objects"].as_array_mut().unwrap().pop();
            }
            "name" => raw["pages"][0]["objects"][0]["sourceObjectName"] = json!("replaced-picture"),
            "duplicate" => {
                raw["pages"][0]["objects"][1]["sourceObjectName"] = json!("lesson-picture-0")
            }
            "missing" => {
                raw["pages"][0]["objects"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("sourceObjectName");
            }
            "order" => raw["pages"][0]["objects"]
                .as_array_mut()
                .unwrap()
                .swap(0, 1),
            "diagnostic" => raw["diagnostics"][0]["severity"] = json!("error"),
            "animation" | "pending" => {}
            _ => unreachable!(),
        }
        seed.sha256 = "b".repeat(64);
        seed.identity =
            Some(SavedSourceIdentity::parse(&serde_json::to_vec(&raw).unwrap()).unwrap());
        assert!(
            db.open_identified_courseware_project(workspace, &seed)
                .unwrap_err()
                .to_string()
                .starts_with("COURSEWARE_CONFLICT"),
            "{failure}"
        );
        assert_eq!(
            serde_json::to_value(
                db.get_courseware_project(workspace, &seed.project_id)
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(previous).unwrap()
        );
        assert_eq!(identity(&db), old_identity);
        assert!(db
            .kv_get(
                IDENTITY_NAMESPACE,
                &identity_key(workspace, &seed.project_id, &seed.sha256).unwrap()
            )
            .unwrap()
            .is_none());
        assert_eq!(
            db.conn
                .query_row(
                    "SELECT count(*) FROM kv WHERE ns=?1",
                    [HISTORY_NAMESPACE],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
}

#[test]
fn first_open_uses_selected_task_and_teaching_settings_without_rewriting_existing_project() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let workspace = dir.path().to_str().unwrap();
    let seed = fixture_seed();
    let education: CoursewareEducationContext = serde_json::from_value(json!({
        "schoolStage": "kindergarten", "subject": "english", "grade": "大班"
    }))
    .unwrap();
    let project = db
        .open_identified_courseware_project_with_metadata(
            workspace,
            &seed,
            "scene",
            Some(education),
        )
        .unwrap();
    assert_eq!(project.task_type, "scene");
    assert_eq!(
        project.education_context.as_ref().unwrap().grade.as_deref(),
        Some("大班")
    );
    let narrated = db
        .initialize_generated_narration(
            workspace,
            &project.project_id,
            &seed.sha256,
            "问候课",
            &["和朋友挥手，说 Hello。".into()],
        )
        .unwrap();
    assert_eq!(narrated.title, "问候课");
    assert_eq!(
        narrated.pages[0].actions[0]["text"],
        "和朋友挥手，说 Hello。"
    );
    assert_eq!(narrated.pages[0].actions[0]["type"], "speech");
    let repeated = db
        .initialize_generated_narration(
            workspace,
            &project.project_id,
            &seed.sha256,
            "问候课",
            &["和朋友挥手，说 Hello。".into()],
        )
        .unwrap();
    assert_eq!(repeated.teaching_revision, narrated.teaching_revision);
    assert!(db
        .initialize_generated_narration(
            workspace,
            &project.project_id,
            &seed.sha256,
            "问候课",
            &["另一段讲解".into()],
        )
        .is_err());
    let reopened = db
        .open_identified_courseware_project_with_metadata(workspace, &seed, "import", None)
        .unwrap();
    assert_eq!(reopened.task_type, "scene");
    assert_eq!(reopened.pages[0].page_id, project.pages[0].page_id);
    assert_eq!(
        reopened.education_context.unwrap().subject.as_deref(),
        Some("english")
    );
    assert_eq!(
        reopened.pages[0].actions[0]["text"],
        "和朋友挥手，说 Hello。"
    );
    assert_eq!(reopened.title, "问候课");
}

#[test]
fn generated_narration_starts_as_sentences_and_retains_legacy_teaching() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let workspace = dir.path().to_str().unwrap();
    let seed = fixture_seed();
    let project = db
        .open_identified_courseware_project_with_metadata(workspace, &seed, "scene", None)
        .unwrap();
    let sentences = [
        "欢迎小朋友！",
        "小猫说：‘Hello!’ ",
        "它有 1.5 米高。",
        "Let's say hello. ",
        "Are you ready?",
    ];
    let text = sentences.concat();
    let narrated = db
        .initialize_generated_narration(
            workspace,
            &project.project_id,
            &seed.sha256,
            "Greetings",
            std::slice::from_ref(&text),
        )
        .unwrap();
    assert_eq!(
        narrated.pages[0]
            .actions
            .iter()
            .map(|a| a["text"].as_str().unwrap())
            .collect::<Vec<_>>(),
        sentences
    );
    assert_eq!(narrated.pages[0].actions[1]["id"], "narration-1");
    let repeated = db
        .initialize_generated_narration(
            workspace,
            &project.project_id,
            &seed.sha256,
            "Greetings",
            std::slice::from_ref(&text),
        )
        .unwrap();
    assert_eq!(repeated.teaching_revision, narrated.teaching_revision);
    let mut legacy = narrated.clone();
    legacy.pages[0].actions = vec![json!({"id":"narration-0","type":"speech","text":text})];
    db.kv_set(
        NAMESPACE,
        &storage_key(workspace, &project.project_id).unwrap(),
        &serde_json::to_value(&legacy).unwrap(),
    )
    .unwrap();
    let retained = db
        .initialize_generated_narration(
            workspace,
            &project.project_id,
            &seed.sha256,
            "Greetings",
            std::slice::from_ref(&text),
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(retained).unwrap(),
        serde_json::to_value(&legacy).unwrap()
    );
    legacy.pages[0].actions[0]["text"] = json!("Manually revised narration.");
    db.kv_set(
        NAMESPACE,
        &storage_key(workspace, &project.project_id).unwrap(),
        &serde_json::to_value(&legacy).unwrap(),
    )
    .unwrap();
    assert!(db
        .initialize_generated_narration(
            workspace,
            &project.project_id,
            &seed.sha256,
            "Greetings",
            &[text]
        )
        .is_err());
}

#[test]
fn same_source_keeps_logical_ids_mapping_revision_teaching_and_locks_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let workspace = dir.path().to_str().unwrap();
    let seed = fixture_seed();
    let saved;
    let project;
    {
        let db = Database::open(&path).unwrap();
        let initial = db
            .open_identified_courseware_project(workspace, &seed)
            .unwrap();
        let edited = db
            .write_courseware_teaching(
                workspace,
                &TeachingWrite {
                    project_id: initial.project_id.clone(),
                    page_id: initial.pages[0].page_id.clone(),
                    expected_source_revision: initial.source.revision.clone(),
                    expected_teaching_revision: initial.teaching_revision,
                    actions: vec![json!({"id":"speech-1","type":"speech","text":"Good!"})],
                },
            )
            .unwrap();
        project = db
            .set_courseware_page_lock(
                workspace,
                &edited.project_id,
                &edited.pages[0].page_id,
                &edited.source.revision,
                &edited.teaching_revision,
                true,
            )
            .unwrap();
        saved = identity(&db);
        assert_eq!(saved["pages"][0]["logicalId"], project.pages[0].page_id);
        assert!(
            SavedSourceIdentity::parse(&serde_json::to_vec(&saved).unwrap())
                .unwrap()
                .same_export(seed.identity.as_ref().unwrap())
        );
        assert_eq!(
            serde_json::to_value(
                db.open_identified_courseware_project(workspace, &seed)
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(&project).unwrap()
        );
        assert_eq!(identity(&db), saved);
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        serde_json::to_value(
            db.open_identified_courseware_project(workspace, &seed)
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&project).unwrap()
    );
    assert_eq!(identity(&db), saved);
    let mut changed = fixture_seed();
    changed.sha256 = "b".repeat(64);
    assert!(db
        .open_identified_courseware_project(workspace, &changed)
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_CONFLICT"));
    assert_eq!(identity(&db), saved);
    let mut drift = seed.identity.unwrap().value().clone();
    drift["pages"][0]["objects"][0]["contentFingerprint"] = json!("b".repeat(64));
    changed.sha256 = project.source.sha256.clone();
    changed.identity =
        Some(SavedSourceIdentity::parse(&serde_json::to_vec(&drift).unwrap()).unwrap());
    assert!(db
        .open_identified_courseware_project(workspace, &changed)
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_CONFLICT"));
    assert_eq!(identity(&db), saved);
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_project(workspace, &project.project_id)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(project).unwrap()
    );
}

#[test]
fn identity_failure_rolls_back_new_project_and_existing_projects_upgrade_without_changes() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let seed = fixture_seed();
    db.conn.execute_batch("CREATE TRIGGER identity_failure BEFORE INSERT ON kv WHEN NEW.ns = 'coursewareIdentities.v1' BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END;").unwrap();
    assert!(db
        .open_identified_courseware_project(workspace, &seed)
        .is_err());
    assert!(db
        .get_courseware_project(workspace, &seed.project_id)
        .unwrap()
        .is_none());
    db.conn
        .execute_batch("DROP TRIGGER identity_failure;")
        .unwrap();
    let legacy = db
        .open_saved_courseware_project(workspace, &seed.project_id, &seed.sha256, seed.pages)
        .unwrap();
    let upgraded = db
        .open_identified_courseware_project(workspace, &seed)
        .unwrap();
    assert_eq!(
        serde_json::to_value(upgraded).unwrap(),
        serde_json::to_value(&legacy).unwrap()
    );
    let saved = identity(&db);
    assert_eq!(saved["pages"][0]["logicalId"], legacy.pages[0].page_id);
    let legacy_seed = SavedProjectSeed {
        identity: None,
        ..seed
    };
    db.open_identified_courseware_project(workspace, &legacy_seed)
        .unwrap();
    assert_eq!(identity(&db), saved);
    db.open_identified_courseware_project("/different/workspace", &legacy_seed)
        .unwrap();
    assert_eq!(identity(&db), saved);
}
