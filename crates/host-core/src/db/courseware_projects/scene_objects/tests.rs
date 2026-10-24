use super::*;
use crate::courseware::SavedProjectSeed;
use serde_json::json;

fn seed() -> SavedProjectSeed {
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    SavedProjectSeed {
        project_id: "scene-objects".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    }
}

fn mapping(seed: &SavedProjectSeed) -> GeneratedSceneMapping {
    serde_json::from_value(json!({"pages":[{"slideId":"scene-001", "sourceHash":format!("sha256:{}", "a".repeat(64)),
        "slidePart":"ppt/slides/slide1.xml", "elements":seed.identity.as_ref().unwrap().value()["pages"][0]["objects"]
            .as_array().unwrap().iter().enumerate().map(|(index, object)| json!({
                "elementId":format!("独立对象 {index}"), "objectName":format!("独立对象 {index}"),
                "sourceShapeId":object["sourceShapeId"],
                "type":if object["type"] == "image" { "image_layer" } else { "native_shape" },
                "semanticRole":format!("teaching object {index}"), "spokenAliases":["apple", "苹果"],
                "animationPolicy":"emphasize_on_repeat", "objectKind":"prop"
            })).collect::<Vec<_>>() }]})).unwrap()
}

#[test]
fn generated_objects_bind_to_host_ids_and_remain_read_only_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("scene.sqlite");
    let expected;
    {
        let db = Database::open(&path).unwrap();
        let s = seed();
        let project = db
            .open_identified_courseware_project_with_metadata(root, &s, "scene", None)
            .unwrap();
        let mapping = mapping(&s);
        db.initialize_generated_scene_objects(root, &project, &mapping)
            .unwrap();
        db.initialize_generated_scene_objects(root, &project, &mapping)
            .unwrap();
        db.conn.execute_batch("PRAGMA query_only=ON").unwrap();
        expected = db
            .courseware_project_context(root, &project.project_id)
            .unwrap();
        let objects = &expected["sceneObjects"];
        assert_eq!(objects["requiresReview"], true);
        assert_eq!(objects["sourceSha256"], project.source.sha256);
        assert_eq!(objects["pages"][0]["pageId"], project.pages[0].page_id);
        assert_eq!(objects["pages"][0]["objects"].as_array().unwrap().len(), 4);
        for (semantic, canonical) in objects["pages"][0]["objects"]
            .as_array()
            .unwrap()
            .iter()
            .zip(
                expected["mapping"]["pages"][0]["objects"]
                    .as_array()
                    .unwrap(),
            )
        {
            assert_eq!(semantic["objectId"], canonical["objectId"]);
            assert_eq!(semantic["status"], "mapped");
            assert_eq!(
                semantic["element"]["spokenAliases"],
                json!(["apple", "苹果"])
            );
        }
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.courseware_project_context(root, &seed().project_id)
            .unwrap(),
        expected
    );
    assert!(db
        .courseware_project_context("/other/workspace", &seed().project_id)
        .is_err());
}

#[test]
fn native_text_matches_the_trusted_parsers_shape_type() {
    let s = seed();
    let mut text = mapping(&s);
    text.pages[0].elements[0].kind = "native_text".into();
    text.validate_source(s.identity.as_ref().unwrap()).unwrap();
    text.pages[0].elements[3].kind = "native_text".into();
    assert!(text.validate_source(s.identity.as_ref().unwrap()).is_err());
}

#[test]
fn invalid_mapping_never_replaces_the_original_semantics() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let s = seed();
    let project = db
        .open_identified_courseware_project_with_metadata(root, &s, "scene", None)
        .unwrap();
    let original = mapping(&s);
    db.initialize_generated_scene_objects(root, &project, &original)
        .unwrap();
    let expected = db
        .courseware_project_context(root, &project.project_id)
        .unwrap();
    for kind in [
        "shape",
        "duplicate",
        "count",
        "type",
        "page",
        "role",
        "aliases",
    ] {
        let mut bad = original.clone();
        match kind {
            "shape" => bad.pages[0].elements[0].source_shape_id = "999".into(),
            "duplicate" => {
                bad.pages[0].elements[1].source_shape_id =
                    bad.pages[0].elements[0].source_shape_id.clone()
            }
            "count" => {
                bad.pages[0].elements.pop();
            }
            "type" => bad.pages[0].elements[0].kind = "image_layer".into(),
            "page" => bad.pages[0].slide_part = "ppt/slides/slide2.xml".into(),
            "role" => bad.pages[0].elements[0].object_kind = Some("invented".into()),
            "aliases" => bad.pages[0].elements[0].spoken_aliases = vec!["a".into(); 51],
            _ => unreachable!(),
        }
        assert!(
            db.initialize_generated_scene_objects(root, &project, &bad)
                .is_err(),
            "{kind}"
        );
        assert_eq!(
            db.courseware_project_context(root, &project.project_id)
                .unwrap(),
            expected
        );
    }
    let mut changed = original;
    changed.pages[0].elements[0].semantic_role = Some("different role".into());
    assert!(db
        .initialize_generated_scene_objects(root, &project, &changed)
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_CONFLICT"));
    assert_eq!(
        db.courseware_project_context(root, &project.project_id)
            .unwrap(),
        expected
    );
}

#[test]
fn manual_saved_source_review_keeps_semantics_but_invalidates_unproven_object_bindings() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let s = seed();
    let project = db
        .open_identified_courseware_project_with_metadata(root, &s, "scene", None)
        .unwrap();
    let mut mapping = mapping(&s);
    mapping.pages[0].elements[0].identity_mismatch = Some(true);
    db.initialize_generated_scene_objects(root, &project, &mapping)
        .unwrap();
    assert_eq!(
        db.courseware_project_context(root, &project.project_id)
            .unwrap()["sceneObjects"]["pages"][0]["objects"][0]["status"],
        "identity_mismatch"
    );
    let mut next = seed();
    next.sha256 = "b".repeat(64);
    let mut identity = next.identity.take().unwrap().value().clone();
    identity["sourceSha256"] = json!(next.sha256);
    next.identity =
        Some(SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap());
    let review = db.prepare_courseware_review(root, &next).unwrap();
    db.adopt_courseware_review(
        root,
        &next,
        review["reviewId"].as_str().unwrap(),
        &[Some(project.pages[0].page_id.clone())],
    )
    .unwrap();
    let context = db
        .courseware_project_context(root, &project.project_id)
        .unwrap();
    let objects = &context["sceneObjects"];
    assert_eq!(objects["originalSourceSha256"], s.sha256);
    assert_eq!(objects["sourceSha256"], next.sha256);
    assert_eq!(objects["pages"][0]["pageId"], project.pages[0].page_id);
    assert!(objects["pages"][0]["objects"]
        .as_array()
        .unwrap()
        .iter()
        .all(|object| object["status"] == "missing" && object["currentSourceShapeId"].is_null()));
    assert_ne!(
        objects["pages"][0]["objects"][0]["objectId"],
        context["mapping"]["pages"][0]["objects"][0]["objectId"]
    );
}

#[test]
fn old_projects_need_no_migration_and_corrupt_scene_records_are_not_silently_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let s = seed();
    let project = db
        .open_identified_courseware_project_with_metadata(root, &s, "scene", None)
        .unwrap();
    assert!(db
        .courseware_project_context(root, &project.project_id)
        .unwrap()
        .get("sceneObjects")
        .is_none());
    db.initialize_generated_scene_objects(root, &project, &mapping(&s))
        .unwrap();
    let key = storage_key(root, &project.project_id).unwrap();
    let original = db.kv_get(SCENE_OBJECTS_NAMESPACE, &key).unwrap().unwrap();
    for kind in ["version", "source", "shape", "field"] {
        let mut bad = original.clone();
        match kind {
            "version" => bad["schemaVersion"] = json!("unknown"),
            "source" => bad["sourceSha256"] = json!("c".repeat(64)),
            "shape" => {
                bad["mapping"]["pages"][0]["elements"][0]["sourceShapeId"] = json!("unknown")
            }
            "field" => {
                bad["mapping"]["pages"][0]["elements"][0]["url"] = json!("https://unexpected.test")
            }
            _ => unreachable!(),
        }
        db.kv_set(SCENE_OBJECTS_NAMESPACE, &key, &bad).unwrap();
        assert!(
            db.courseware_project_context(root, &project.project_id)
                .is_err(),
            "{kind}"
        );
        assert_eq!(
            db.kv_get(SCENE_OBJECTS_NAMESPACE, &key).unwrap().unwrap(),
            bad
        );
    }
}
