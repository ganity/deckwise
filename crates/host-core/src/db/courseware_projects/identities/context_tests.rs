use super::*;
use serde_json::json;

fn seed() -> SavedProjectSeed {
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    SavedProjectSeed {
        project_id: "readonly-context".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    }
}

fn rows(db: &Database) -> Vec<(String, String, String, i64)> {
    db.conn
        .prepare("SELECT ns,key,value_json,updated_at FROM kv ORDER BY ns,key")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn context_is_read_only_current_canonical_and_stable_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let expected;
    {
        let db = Database::open(&path).unwrap();
        let project = db
            .open_identified_courseware_project(workspace, &seed())
            .unwrap();
        let taught = db.write_courseware_teaching(workspace, &TeachingWrite {
            project_id: project.project_id.clone(), page_id: project.pages[0].page_id.clone(),
            expected_source_revision: project.source.revision.clone(),
            expected_teaching_revision: project.teaching_revision,
            actions: vec![json!({"id":"speech","type":"speech","text":"Keep this narration","pauseAfterMs":1000})],
        }).unwrap();
        let locked = db
            .set_courseware_page_lock(
                workspace,
                &taught.project_id,
                &taught.pages[0].page_id,
                &taught.source.revision,
                &taught.teaching_revision,
                true,
            )
            .unwrap();
        let before = rows(&db);
        db.conn.execute_batch("PRAGMA query_only=ON").unwrap();
        expected = db
            .courseware_project_context(workspace, &locked.project_id)
            .unwrap();
        assert_eq!(expected["project"], serde_json::to_value(&locked).unwrap());
        let mapping = &expected["mapping"];
        assert_eq!(mapping["sourceSha256"], locked.source.sha256);
        assert!(mapping["revision"].as_str().is_some_and(|r| !r.is_empty()));
        assert_eq!(mapping["pages"][0]["pageId"], locked.pages[0].page_id);
        assert_eq!(mapping["pages"][0]["importPageId"], "page_1");
        assert_eq!(mapping["pages"][0]["objects"].as_array().unwrap().len(), 4);
        assert_eq!(
            mapping["pages"][0]["objects"][0]["importElementId"],
            "pptx_shape_1"
        );
        assert_eq!(
            mapping["pages"][0]["objects"][0].as_object().unwrap().len(),
            2
        );
        let objects = &expected["savedObjects"];
        assert_eq!(objects["sourceSha256"], locked.source.sha256);
        assert_eq!(objects["mappingRevision"], mapping["revision"]);
        assert_eq!(objects["pages"][0]["pageId"], locked.pages[0].page_id);
        assert_eq!(
            objects["pages"][0]["objects"][0]["objectId"],
            mapping["pages"][0]["objects"][0]["objectId"]
        );
        assert_eq!(objects["pages"][0]["objects"][0]["kind"], "shape");
        assert_eq!(objects["pages"][0]["objects"][0]["index"], 1);
        assert_eq!(objects["pages"][0]["objects"][3]["kind"], "image");
        assert!(objects["pages"][0]["objects"][0]
            .get("importElementId")
            .is_none());
        assert_eq!(objects["pages"][0]["objects"][0]["sourceShapeId"], "1951970051");
        assert_eq!(expected["saveWarnings"], json!([]));
        assert_eq!(rows(&db), before);
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.courseware_project_context(workspace, &seed().project_id)
            .unwrap(),
        expected
    );
}

#[test]
fn context_does_not_initialize_legacy_identity_or_missing_projects() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let s = seed();
    let workspace = dir.path().to_str().unwrap();
    db.open_saved_courseware_project(workspace, &s.project_id, &s.sha256, s.pages)
        .unwrap();
    let before = rows(&db);
    for (root, id, error) in [
        (workspace, s.project_id.as_str(), "COURSEWARE_INVALID"),
        (workspace, "missing", "COURSEWARE_NOT_FOUND"),
        (
            "/other/workspace",
            s.project_id.as_str(),
            "COURSEWARE_NOT_FOUND",
        ),
        (workspace, "../bad", "COURSEWARE_INVALID"),
    ] {
        assert!(db
            .courseware_project_context(root, id)
            .unwrap_err()
            .to_string()
            .starts_with(error));
        assert_eq!(rows(&db), before);
    }
}

#[test]
fn context_rejects_corrupt_or_unbound_identity_without_repairing_it() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let s = seed();
    let project = db
        .open_identified_courseware_project(workspace, &s)
        .unwrap();
    let key = identity_key(workspace, &s.project_id, &s.sha256).unwrap();
    let original = db.kv_get(IDENTITY_NAMESPACE, &key).unwrap().unwrap();
    for change in ["source", "logical", "revision", "count", "object"] {
        let mut value = original.clone();
        match change {
            "source" => value["sourceSha256"] = json!("b".repeat(64)),
            "logical" => value["pages"][0]["logicalId"] = json!("other-page"),
            "revision" => {
                value.as_object_mut().unwrap().remove("mappingRevision");
            }
            "count" => {
                let page = value["pages"][0].clone();
                value["pages"].as_array_mut().unwrap().push(page);
            }
            "object" => value["pages"][0]["objects"][0]["importElementId"] = json!("pptx_shape_2"),
            _ => unreachable!(),
        }
        db.kv_set(IDENTITY_NAMESPACE, &key, &value).unwrap();
        let before = rows(&db);
        assert!(
            db.courseware_project_context(workspace, &s.project_id)
                .is_err(),
            "{change}"
        );
        assert_eq!(rows(&db), before);
        assert_eq!(
            serde_json::to_value(
                db.get_courseware_project(workspace, &s.project_id)
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(&project).unwrap()
        );
    }
}

#[test]
fn candidate_and_readonly_context_share_the_exact_mapping_projection() {
    use super::super::source_candidates::{Kind, SourceCandidateRequest};
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let s = seed();
    let project = db
        .open_identified_courseware_project(workspace, &s)
        .unwrap();
    db.prepare_source_candidate(
        workspace,
        &s,
        SourceCandidateRequest {
            candidate_id: "pending".into(),
            page_id: project.pages[0].page_id.clone(),
            kind: Kind::PageFade,
            expected_source_revision: project.source.revision,
            expected_teaching_revision: project.teaching_revision,
            style_batch: None,
        },
    )
    .unwrap();
    let before = rows(&db);
    let context = db
        .courseware_project_context(workspace, &s.project_id)
        .unwrap();
    let candidate = db
        .source_candidate_context(workspace, &s.project_id, "pending")
        .unwrap();
    assert_eq!(context["mapping"], candidate["mapping"]);
    assert_eq!(rows(&db), before);
}
