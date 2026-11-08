use super::*;

#[test]
fn native_sync_baseline_follows_host_audio_invalidation() {
    use sha2::Digest;
    let hash = |actions: &Value| hex::encode(sha2::Sha256::digest(serde_json::to_vec(actions).unwrap()));
    let old = json!({"scenes":[{"id":"body","actions":[{"id":"speech","type":"speech","text":"Old"}]}]});
    let actions = json!([
        {"id":"speech","type":"speech","text":"New"},
        {"id":"motion","type":"element_animation","speechCue":{"speechActionId":"speech","atMs":10}}
    ]);
    let mut next = json!({"scenes":[{"id":"body","actions":actions,"metadata":{
        "nativeTeachingActionIds":["speech","motion"],"nativeTeachingActionsHash":hash(&actions)
    }}]});
    validation::invalidate_edited_audio(&old, &mut next);
    assert!(next["scenes"][0]["actions"][1].get("speechCue").is_none());
    assert_eq!(next["scenes"][0]["metadata"]["nativeTeachingActionsHash"], hash(&next["scenes"][0]["actions"]));
    let mut edited = json!({"scenes":[{"id":"body","actions":actions,"metadata":{
        "nativeTeachingActionIds":["speech","motion"],"nativeTeachingActionsHash":"unchanged-editor-baseline"
    }}]});
    validation::invalidate_edited_audio(&old, &mut edited);
    assert_eq!(edited["scenes"][0]["metadata"]["nativeTeachingActionsHash"], "unchanged-editor-baseline");
}

fn fixture() -> Value {
    json!({"id":"course", "stage":{"id":"stage","name":"Greetings","createdAt":1,"updatedAt":1},"createdAt":"2026-11-04T00:00:00Z","scenes":[
        {"id":"quiz","stageId":"stage","type":"quiz","title":"Question","order":1,"content":{"type":"quiz","questions":[{"id":"question","type":"single","question":"Greeting?","options":[{"value":"B","label":"Bye","image":{"src":"data:image/png;base64,aGVsbG8=","assetId":"picture","mimeType":"image/png"}},{"value":"A","label":"Hello"}],"answer":["A"]}]}},
        {"id":"interaction","stageId":"stage","type":"slide","title":"Discussion","order":2,"content":{"type":"slide","canvas":{"id":"slide","elements":[]}},"actions":[{"id":"checkpoint","type":"interaction_checkpoint","checkpointId":"checkpoint","checkpointKind":"chapter_summary","chapterId":"chapter","chapterTitle":"Greetings","question":"Say hello","constraintPrompt":"Only greetings","referenceAnswer":{"summary":"Hello","keyPoints":[],"label":"Reference"},"context":{"chapterSummary":"Greetings","sourceSceneIds":["quiz"],"keyTerms":["Hello"]}}]}
    ],"mediaManifest":[],"audioManifest":[]})
}
fn setup(db: &Database, root: &str) -> CoursewareProject {
    let value: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    )))
    .unwrap();
    let mut project: CoursewareProject = serde_json::from_value(value["project"].clone()).unwrap();
    for page in &mut project.pages {
        page.locked = false;
    }
    db.create_courseware_project(root, &project).unwrap();
    project
}
#[test]
fn embedded_questions_do_not_skip_body_narration_or_media() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let project = setup(&db, root);
    let mut document = fixture();
    document["scenes"][1]["metadata"] = json!({"nativePageId": project.pages[0].page_id});
    let saved = db.write_courseware_classroom(root, &project.project_id, None, &project.source.revision, &document).unwrap();
    assert!(db.courseware_assessment_page_ids(root, &project).unwrap().contains(&project.pages[0].page_id));
    document["scenes"][1]["metadata"]["nativeEmbeddedAssessments"] = json!(true);
    db.write_courseware_classroom(root, &project.project_id, saved["revision"].as_str(), &project.source.revision, &document).unwrap();
    assert!(db.courseware_assessment_page_ids(root, &project).unwrap().is_empty());
}
#[test]
fn canonical_classroom_cas_restart_and_immutable_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let first;
    let project;
    {
        let db = Database::open_in_dir(dir.path()).unwrap();
        project = setup(&db, root);
        assert!(db
            .courseware_classroom(root, &project.project_id, None)
            .unwrap()["classroom"]
            .is_null());
        first = db
            .write_courseware_classroom(
                root,
                &project.project_id,
                None,
                &project.source.revision,
                &fixture(),
            )
            .unwrap();
        assert!(db
            .write_courseware_classroom(
                root,
                &project.project_id,
                None,
                &project.source.revision,
                &fixture()
            )
            .is_err());
        assert!(db
            .write_courseware_classroom(
                root,
                &project.project_id,
                first["revision"].as_str(),
                "stale",
                &fixture()
            )
            .is_err());
        let unchanged = db.write_courseware_classroom(
            root, &project.project_id, first["revision"].as_str(), &project.source.revision, &fixture(),
        ).unwrap();
        assert_eq!(unchanged, first, "unchanged saves retain the preview revision");
        let refreshed = db.refresh_courseware_classroom(
            root, &project.project_id, first["revision"].as_str(), &project.source.revision, &fixture(),
        ).unwrap();
        assert_eq!(refreshed, first);
        let mut next = fixture();
        next["scenes"][0]["content"]["questions"][0]["question"] = json!("Updated");
        db.write_courseware_classroom(
            root,
            &project.project_id,
            first["revision"].as_str(),
            &project.source.revision,
            &next,
        )
        .unwrap();
    }
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(
        db.courseware_classroom(root, &project.project_id, first["revision"].as_str())
            .unwrap(),
        first
    );
    let latest = db
        .courseware_classroom(root, &project.project_id, None)
        .unwrap();
    assert_eq!(
        latest["classroom"]["scenes"][0]["content"]["questions"][0]["answer"],
        json!(["A"])
    );
    assert_eq!(
        latest["classroom"]["scenes"][0]["content"]["questions"][0]["question"],
        "Updated"
    );
    assert!(db
        .courseware_classroom("/other-workspace", &project.project_id, None)
        .is_err());
}
#[test]
fn chapter_checkpoint_draft_accepts_empty_summaries_but_requires_strings() {
    let mut draft = fixture();
    draft["scenes"][0]["content"]["questions"][0]["question"] = json!("");
    draft["scenes"][1]["actions"][0]["question"] = json!("");
    draft["scenes"][1]["actions"][0]["chapterTitle"] = json!("");
    draft["scenes"][1]["actions"][0]["referenceAnswer"]["summary"] = json!("");
    draft["scenes"][1]["actions"][0]["context"]["chapterSummary"] = json!("");
    draft["scenes"][1]["actions"][0]["context"]["sourceSceneIds"] = json!([]);
    validate_classroom(&draft).unwrap();
    for path in [
        "/scenes/0/content/questions/0/question",
        "/scenes/1/actions/0/question",
        "/scenes/1/actions/0/chapterTitle",
    ] {
        for invalid_value in [Value::Null, json!(42), json!([])] {
            let mut invalid_draft = draft.clone();
            *invalid_draft.pointer_mut(path).unwrap() = invalid_value;
            assert!(validate_classroom(&invalid_draft).is_err());
        }
        let (parent, key) = path.rsplit_once('/').unwrap();
        let mut missing = draft.clone();
        missing.pointer_mut(parent).unwrap().as_object_mut().unwrap().remove(key);
        assert!(validate_classroom(&missing).is_err());
    }
    for (object, field) in [("referenceAnswer", "summary"), ("context", "chapterSummary")] {
        for invalid_value in [Value::Null, json!(42), json!([])] {
            let mut invalid_draft = draft.clone();
            invalid_draft["scenes"][1]["actions"][0][object][field] = invalid_value;
            assert!(validate_classroom(&invalid_draft).is_err());
        }
        let mut missing = draft.clone();
        missing["scenes"][1]["actions"][0][object]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(validate_classroom(&missing).is_err());
    }
}

#[test]
fn instant_quiz_rejects_multiple_questions_but_review_preserves_them() {
    let mut document = fixture();
    document["scenes"][0]["content"]["interactionMode"] = json!("classroom_instant_feedback");
    validate_classroom(&document).unwrap();
    let mut second = document["scenes"][0]["content"]["questions"][0].clone();
    second["id"] = json!("second-question");
    document["scenes"][0]["content"]["questions"].as_array_mut().unwrap().push(second);
    assert!(validate_classroom(&document).unwrap_err().to_string().contains("Instant Quiz accepts one question"));
    document["scenes"][0]["content"]["interactionMode"] = json!("assessment_review");
    validate_classroom(&document).unwrap();
}

#[test]
fn rejects_masquerading_quizzes_or_dangling_answers_without_erasing_optional_fields() {
    validate_classroom(&fixture()).unwrap();
    let mut bad = fixture();
    bad["scenes"][0]["content"]["questions"][0]["keyPoints"] = json!("wrong type");
    assert!(validate_classroom(&bad).is_err());
    let mut bad = fixture();
    bad["scenes"][0]["content"]["questions"][0]["answer"] = json!(["missing"]);
    assert!(validate_classroom(&bad).is_err());
    let mut bad = fixture();
    bad["scenes"][1]["actions"][0]["response"] = json!({"kind":"single"});
    assert!(validate_classroom(&bad).is_err());
    let mut bad = fixture();
    bad["scenes"][1]["actions"][0]["checkpointKind"] = json!("teacher_continue");
    assert!(validate_classroom(&bad).is_err());
}

#[test]
fn standalone_quiz_roundtrips_without_any_native_source() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let result;
    {
        let db = Database::open_in_dir(dir.path()).unwrap();
        db.kv_set("coursewareTask.v1", "session", &json!({"taskType":"scene"}))
            .unwrap();
        let mut quiz = fixture();
        quiz["scenes"].as_array_mut().unwrap().truncate(1);
        result = db
            .create_courseware_classroom(root, "session", &quiz)
            .unwrap();
        let id = result["projectId"].as_str().unwrap();
        assert!(db.get_courseware_project(root, id).unwrap().is_none());
        assert_eq!(
            db.kv_get("coursewareTask.v1", "session").unwrap().unwrap()["canonicalProjectId"],
            id
        );
        assert!(db
            .create_courseware_classroom(root, "session", &quiz)
            .is_err());
        let mut edited = quiz.clone();
        edited["scenes"][0]["content"]["questions"][0]["type"] = json!("short_answer");
        edited["scenes"][0]["content"]["questions"][0]["answer"] = json!(["A textual response"]);
        db.write_courseware_classroom(
            root,
            id,
            result["revision"].as_str(),
            result["sourceRevision"].as_str().unwrap(),
            &edited,
        )
        .unwrap();
    }
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(
        db.courseware_classroom(
            root,
            result["projectId"].as_str().unwrap(),
            result["revision"].as_str()
        )
        .unwrap(),
        result
    );
}

#[test]
fn native_locks_stale_sources_and_audio_invalidation_are_enforced() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let mut project = setup(&db, root);
    let key = storage_key(root, &project.project_id).unwrap();
    project.pages[0].locked = true;
    db.kv_set(NAMESPACE, &key, &serde_json::to_value(&project).unwrap())
        .unwrap();
    assert!(db
        .write_courseware_classroom(
            root,
            &project.project_id,
            None,
            &project.source.revision,
            &fixture()
        )
        .is_err());
    project.pages[0].locked = false;
    db.kv_set(NAMESPACE, &key, &serde_json::to_value(&project).unwrap())
        .unwrap();
    let mut content = fixture();
    content["scenes"][0]["actions"] = json!([{"id":"speech","type":"speech","text":"Greeting?","audioId":"audio","audioUrl":"data:audio/mpeg;base64,aA=="}]);
    content["audioManifest"] = json!([{"sceneId":"quiz","actionId":"speech","assetId":"audio.mp3","audioId":"audio","mimeType":"audio/mpeg","url":"data:audio/mpeg;base64,aA==","originalUrl":"data:audio/mpeg;base64,aA=="}]);
    let first = db
        .write_courseware_classroom(
            root,
            &project.project_id,
            None,
            &project.source.revision,
            &content,
        )
        .unwrap();
    let mut image_only = content.clone();
    image_only["scenes"][0]["content"]["questions"][0]["image"] =
        json!({"src":"data:image/png;base64,dXBkYXRlZA=="});
    let mut projected = image_only.clone();
    validation::invalidate_edited_audio(&content, &mut projected);
    assert_eq!(
        projected, image_only,
        "image-only changes preserve audio and timing"
    );
    let mut speech_only = content.clone();
    speech_only["scenes"][0]["actions"][0]["text"] = json!("Changed speech");
    validation::invalidate_edited_audio(&content, &mut speech_only);
    assert!(speech_only["scenes"][0]["actions"][0]
        .get("audioUrl")
        .is_none());
    assert!(speech_only["audioManifest"].as_array().unwrap().is_empty());
    content["scenes"][0]["content"]["questions"][0]["question"] = json!("Different question");
    let next = db
        .write_courseware_classroom(
            root,
            &project.project_id,
            first["revision"].as_str(),
            &project.source.revision,
            &content,
        )
        .unwrap();
    assert!(next["classroom"]["scenes"][0]["actions"][0]
        .get("audioUrl")
        .is_none());
    assert!(next["classroom"]["audioManifest"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        next["classroom"]["scenes"][0]["actions"][0]["text"],
        "Greeting?"
    );
    project.source.revision = "source-changed".into();
    let source_revision = project.source.revision.clone();
    db.kv_set(NAMESPACE, &key, &serde_json::to_value(project).unwrap())
        .unwrap();
    assert!(db
        .courseware_classroom(root, next["projectId"].as_str().unwrap(), None)
        .is_err());
    assert!(db
        .write_courseware_classroom(
            root,
            next["projectId"].as_str().unwrap(),
            next["revision"].as_str(),
            &source_revision,
            &next["classroom"]
        )
        .unwrap_err()
        .to_string()
        .contains("explicit refresh"));
    let rebound = db
        .refresh_courseware_classroom(
            root,
            next["projectId"].as_str().unwrap(),
            next["revision"].as_str(),
            &source_revision,
            &next["classroom"],
        )
        .unwrap();
    assert_eq!(rebound["sourceRevision"], source_revision);

    assert_eq!(
        db.courseware_classroom(
            root,
            next["projectId"].as_str().unwrap(),
            first["revision"].as_str()
        )
        .unwrap(),
        first
    );
}

#[test]
fn malformed_canvas_action_and_foreign_assets_are_rejected() {
    let mut value = fixture();
    value["scenes"][1]["content"]["canvas"]["elements"] = json!([{"id":"x","type":"unsupported"}]);
    assert!(validate_classroom(&value).is_err());
    let mut value = fixture();
    value["scenes"][1]["actions"] = json!([{"id":"x","type":"play_audio","elementId":"foreign"}]);
    assert!(validate_classroom(&value).is_err());
    let mut value = fixture();
    value["mediaManifest"] = json!([{"sceneId":"other","elementId":"quiz-option:question:B","assetId":"picture","assetType":"image","mimeType":"image/png","src":"data:image/png;base64,aGVsbG8=","originalSrc":""}]);
    assert!(validate_classroom(&value).is_err());
    value["mediaManifest"][0]["sceneId"] = json!("quiz");
    validate_classroom(&value).unwrap();
    value["mediaManifest"][0]["src"] = json!("/etc/passwd");
    assert!(validate_classroom(&value).is_err());
    let mut value = fixture();
    value["scenes"][0]["content"]["questions"][0]["image"] =
        json!({"src":format!("data:image/png;base64,{}", "A".repeat(200_000))});
    validate_classroom(&value).unwrap();
}

#[test]
fn managed_assets_are_workspace_owned_and_hash_pinned() {
    use sha2::Digest;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let project = setup(&db, root);
    let image = b"managed image";
    let hash = hex::encode(sha2::Sha256::digest(image));
    let relative = format!(".deckwise-ppt/classroom-assets/{hash}.png");
    let path = dir.path().join(&relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, image).unwrap();
    let mut document = fixture();
    document["scenes"][0]["content"]["questions"][0]["image"] =
        json!({"src":relative,"assetId":hash,"mimeType":"image/png"});
    let saved = db
        .write_courseware_classroom(
            root,
            &project.project_id,
            None,
            &project.source.revision,
            &document,
        )
        .unwrap();
    std::fs::write(&path, b"corrupted").unwrap();
    assert!(db
        .write_courseware_classroom(
            root,
            &project.project_id,
            saved["revision"].as_str(),
            &project.source.revision,
            &document
        )
        .is_err());
    assert_eq!(
        db.courseware_classroom(root, &project.project_id, None)
            .unwrap(),
        saved
    );
    document["scenes"][0]["content"]["questions"][0]["image"]["src"] =
        json!(".deckwise-ppt/classroom-assets/../foreign.png");
    assert!(validate_classroom(&document).is_err());
}

#[test]
fn failed_revision_snapshot_rolls_back_document_and_standalone_binding() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let project = setup(&db, root);
    db.conn.execute_batch("CREATE TRIGGER ignore_classroom_revision BEFORE INSERT ON kv WHEN NEW.ns='coursewareClassroomRevisions.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(db
        .write_courseware_classroom(
            root,
            &project.project_id,
            None,
            &project.source.revision,
            &fixture()
        )
        .is_err());
    assert!(db
        .courseware_classroom(root, &project.project_id, None)
        .unwrap()["classroom"]
        .is_null());
    db.kv_set("coursewareTask.v1", "session", &json!({"taskType":"scene"}))
        .unwrap();
    let mut quiz = fixture();
    quiz["scenes"].as_array_mut().unwrap().truncate(1);
    assert!(db
        .create_courseware_classroom(root, "session", &quiz)
        .is_err());
    assert!(db
        .kv_get("coursewareTask.v1", "session")
        .unwrap()
        .unwrap()
        .get("canonicalProjectId")
        .is_none());
    let count: i64 = db
        .conn
        .query_row("SELECT COUNT(*) FROM kv WHERE ns=?1", [ANCHORS], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}
