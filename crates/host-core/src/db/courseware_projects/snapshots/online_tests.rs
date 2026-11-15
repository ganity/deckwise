use super::*;
use crate::courseware::source_candidates::ParsedOutput;

fn input(db: &Database, root: &str) -> (ParsedOutput, CoursewareProject, Value) {
    let local = super::tests::ready(db, root);
    let mut mapping = db
        .courseware_project_context(root, &local.project_id)
        .unwrap()["mapping"]
        .clone();
    let mut project = local;
    project.project_id = "22222222-2222-4222-8222-222222222222".into();
    project.source.revision = "33333333-3333-4333-8333-333333333333".into();
    project.teaching_revision = "remote-teaching-1".into();
    mapping["revision"] = json!("remote-mapping-1");
    mapping["sourceRevision"] = json!(project.source.revision);
    let seed = super::tests::seed();
    (
        ParsedOutput {
            sha256: seed.sha256,
            pages: seed.pages,
            identity: seed.identity.map(|identity| identity.value().clone()),
        },
        project,
        mapping,
    )
}

#[test]
fn online_import_is_immutable_after_restart_and_never_changes_the_local_project() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (parsed, project, mapping) = input(&db, root);
    let local_id = "office-snapshot-test";
    let local_before = db.courseware_project_context(root, local_id).unwrap();
    let frozen = db
        .import_online_courseware_snapshot(
            root,
            &parsed,
            "online-1",
            project.clone(),
            &mapping,
            super::tests::assets(),
        )
        .unwrap();
    let expected = serde_json::to_value(&frozen).unwrap();
    assert!(db
        .is_online_courseware_snapshot(root, &project.project_id, "online-1")
        .unwrap());
    assert!(!db
        .is_online_courseware_snapshot(root, &project.project_id, "missing")
        .unwrap());
    assert!(!db
        .is_online_courseware_snapshot("/other/workspace", &project.project_id, "online-1")
        .unwrap());
    assert_eq!(frozen.snapshot.source.revision, project.source.revision);
    assert_eq!(frozen.snapshot.teaching_revision, project.teaching_revision);
    let mut exported_mapping = mapping.clone();
    exported_mapping
        .as_object_mut()
        .unwrap()
        .remove("sourceRevision");
    assert_eq!(frozen.mapping(), exported_mapping);
    assert_eq!(
        db.courseware_project_context(root, local_id).unwrap(),
        local_before
    );
    assert!(db
        .get_courseware_project(root, &project.project_id)
        .unwrap()
        .is_none());
    assert_eq!(
        serde_json::to_value(
            db.import_online_courseware_snapshot(
                root,
                &parsed,
                "online-1",
                project.clone(),
                &mapping,
                super::tests::assets()
            )
            .unwrap()
        )
        .unwrap(),
        expected
    );
    let mut changed = project.clone();
    changed.pages[0].actions[0]["text"] = json!("Unreviewed remote replacement");
    assert!(db
        .import_online_courseware_snapshot(
            root,
            &parsed,
            "online-1",
            changed,
            &mapping,
            super::tests::assets()
        )
        .unwrap_err()
        .to_string()
        .contains("different content"));
    let local = db.get_courseware_project(root, local_id).unwrap().unwrap();
    db.write_courseware_teaching(
        root,
        &TeachingWrite {
            project_id: local.project_id,
            page_id: local.pages[0].page_id.clone(),
            expected_source_revision: local.source.revision,
            expected_teaching_revision: local.teaching_revision,
            actions: vec![],
        },
    )
    .unwrap();
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert!(db
        .is_online_courseware_snapshot(root, &project.project_id, "online-1")
        .unwrap());
    assert_eq!(
        serde_json::to_value(
            db.get_courseware_snapshot(root, &project.project_id, "online-1")
                .unwrap()
        )
        .unwrap(),
        expected
    );
    assert!(db
        .get_courseware_snapshot("/other/workspace", &project.project_id, "online-1")
        .is_err());
    assert!(db
        .get_courseware_project(root, &project.project_id)
        .unwrap()
        .is_none());
}

#[test]
fn online_origin_marker_is_complete_and_durable_and_never_classifies_local_snapshots() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (parsed, project, mapping) = input(&db, root);
    let local = db
        .get_courseware_project(root, "office-snapshot-test")
        .unwrap()
        .unwrap();
    db.capture_courseware_snapshot(
        root,
        &super::tests::seed(),
        "local-only",
        &local.source.revision,
        &local.teaching_revision,
        super::tests::assets(),
    )
    .unwrap();
    assert!(!db
        .is_online_courseware_snapshot(root, &local.project_id, "local-only")
        .unwrap());
    let record = db
        .import_online_courseware_snapshot(
            root,
            &parsed,
            "online-marker",
            project.clone(),
            &mapping,
            super::tests::assets(),
        )
        .unwrap();
    let original = serde_json::to_value(&record.snapshot).unwrap();
    let marker_key = key(root, &project.project_id, "online-marker").unwrap();
    for field in [
        "projectId",
        "snapshotId",
        "source",
        "teachingRevision",
        "mappingRevision",
        "assetIds",
    ] {
        let mut corrupted = original.clone();
        corrupted[field] = json!("different");
        db.kv_set(ONLINE_SNAPSHOTS, &marker_key, &corrupted)
            .unwrap();
        assert!(
            db.is_online_courseware_snapshot(root, &project.project_id, "online-marker")
                .is_err(),
            "field {field}"
        );
    }
    db.kv_set(ONLINE_SNAPSHOTS, &marker_key, &original).unwrap();
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert!(db
        .is_online_courseware_snapshot(root, &project.project_id, "online-marker")
        .unwrap());
    assert!(!db
        .is_online_courseware_snapshot(root, &local.project_id, "local-only")
        .unwrap());
    db.kv_delete(SNAPSHOTS, &marker_key).unwrap();
    assert!(
        db.is_online_courseware_snapshot(root, &project.project_id, "online-marker")
            .is_err(),
        "orphaned marker must not grant online origin"
    );
}

#[test]
fn online_import_refuses_source_mapping_review_and_audio_mismatches_without_a_record() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (parsed, original, original_mapping) = input(&db, root);
    let before = db
        .courseware_project_context(root, "office-snapshot-test")
        .unwrap();
    for case in (0..10).filter(|case| *case != 4) {
        let mut project = original.clone();
        let mut mapping = original_mapping.clone();
        let mut assets = super::tests::assets();
        match case {
            0 => project.source.sha256 = "b".repeat(64),
            1 => mapping["sourceRevision"] = json!("stale-source"),
            2 => mapping["pages"][0]["pageId"] = json!("different-page"),
            3 => mapping["pages"][0]["objects"]
                .as_array_mut()
                .unwrap()
                .reverse(),
            5 => assets.clear(),
            6 => project.pages[0].actions[0]["audioAssetId"] = json!("missing-audio"),
            7 => assets.push(Asset {
                id: "unused".into(),
                sha256: "b".repeat(64),
                mime_type: "audio/wav".into(),
            }),
            8 => assets[0].mime_type = "video/mp4".into(),
            _ => project.pages[0].actions[0]["text"] = json!(" "),
        }
        let id = format!("bad-{case}");
        assert!(
            db.import_online_courseware_snapshot(root, &parsed, &id, project, &mapping, assets)
                .is_err(),
            "case {case}"
        );
        assert!(
            db.get_courseware_snapshot(root, &original.project_id, &id)
                .is_err(),
            "case {case}"
        );
    }
    assert_eq!(
        db.courseware_project_context(root, "office-snapshot-test")
            .unwrap(),
        before
    );
}

#[test]
fn online_import_does_not_require_any_canonical_project_or_write_teaching_history() {
    let fixture = tempfile::tempdir().unwrap();
    let fixture_db = Database::open_in_dir(fixture.path()).unwrap();
    let (parsed, project, mapping) = input(&fixture_db, fixture.path().to_str().unwrap());
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    db.import_online_courseware_snapshot(
        root,
        &parsed,
        "independent",
        project.clone(),
        &mapping,
        super::tests::assets(),
    )
    .unwrap();
    for namespace in [NAMESPACE, HISTORY_NAMESPACE, identities::IDENTITY_NAMESPACE] {
        let count: i64 = db
            .conn
            .query_row("SELECT COUNT(*) FROM kv WHERE ns=?1", [namespace], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0, "namespace {namespace}");
    }
    assert!(db
        .get_courseware_snapshot(root, &project.project_id, "independent")
        .is_ok());
}

#[test]
fn native_import_is_immutable_and_never_creates_a_mutable_project_or_online_origin() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (parsed, project, mapping) = input(&db, root);
    let mut mapping = mapping;
    mapping["pages"][0]["groups"] = json!([{ "objectId": "native-group", "sourceShapeId": "77" }]);
    let local_before = db
        .courseware_project_context(root, "office-snapshot-test")
        .unwrap();
    let record = db
        .import_native_courseware_snapshot(
            root,
            &parsed,
            "native-1",
            project.clone(),
            &mapping,
            super::tests::assets(),
        )
        .unwrap();
    assert!(record.native_teaching);
    assert_eq!(
        record.mapping()["pages"][0]["groups"],
        mapping["pages"][0]["groups"]
    );
    assert!(!db
        .is_online_courseware_snapshot(root, &project.project_id, "native-1")
        .unwrap());
    assert!(db
        .get_courseware_project(root, &project.project_id)
        .unwrap()
        .is_none());
    assert_eq!(
        db.courseware_project_context(root, "office-snapshot-test")
            .unwrap(),
        local_before
    );
    let mut changed = project.clone();
    changed.pages[0].actions[0]["text"] = json!("Changed native narration");
    assert!(db
        .import_native_courseware_snapshot(
            root,
            &parsed,
            "native-1",
            changed,
            &mapping,
            super::tests::assets()
        )
        .is_err());
    drop(db);
    let reopened = Database::open_in_dir(dir.path()).unwrap();
    let restored = reopened
        .get_courseware_snapshot(root, &project.project_id, "native-1")
        .unwrap();
    assert!(restored.native_teaching);
    assert_eq!(
        restored.mapping()["pages"][0]["groups"],
        mapping["pages"][0]["groups"]
    );
    assert!(reopened
        .get_courseware_project(root, &project.project_id)
        .unwrap()
        .is_none());
}
