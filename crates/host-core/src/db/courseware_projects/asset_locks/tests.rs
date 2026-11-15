use super::*;
use crate::courseware::{
    identity::SavedSourceIdentity, source_candidates::ParsedOutput, SavedProjectSeed,
};
use crate::db::courseware_projects::source_candidates::{
    Kind, RedoEvidence, SourceCandidateRequest,
};
use serde_json::json;

fn seed() -> SavedProjectSeed {
    let value: Value = serde_json::from_str(include_str!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    SavedProjectSeed {
        project_id: "locked-lesson".into(),
        sha256: value["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap()),
    }
}
fn proof() -> ImageProof {
    ImageProof {
        source_shape_id: "719647740".into(),
        asset_sha256: "e".repeat(64),
        picture_sha256: "f".repeat(64),
        z_index: 3,
    }
}
fn context(db: &Database, root: &str, project: &CoursewareProject) -> Value {
    db.courseware_asset_lock_context(
        root,
        &project.project_id,
        &project.pages[0].page_id,
        &project.source.revision,
        &project.teaching_revision,
    )
    .unwrap()
}
fn set(
    db: &Database,
    root: &str,
    project: &CoursewareProject,
    revision: Option<&str>,
    object: &str,
    locked: bool,
) -> Result<Value> {
    db.set_courseware_asset_lock(
        root,
        &project.project_id,
        &project.pages[0].page_id,
        &project.source.revision,
        &project.teaching_revision,
        revision,
        object,
        locked,
        locked.then(proof),
    )
}
fn prepare(db: &Database, root: &str, project: &CoursewareProject, id: &str) -> Value {
    db.prepare_source_candidate(
        root,
        &seed(),
        SourceCandidateRequest {
            candidate_id: id.into(),
            page_id: project.pages[0].page_id.clone(),
            kind: Kind::PagePptx,
            expected_source_revision: project.source.revision.clone(),
            expected_teaching_revision: project.teaching_revision.clone(),
            style_batch: None,
        },
    )
    .unwrap()
}

#[test]
fn image_locks_survive_restart_and_cas_invalidates_existing_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let project = db
        .open_identified_courseware_project(root, &seed())
        .unwrap();
    let initial = context(&db, root, &project);
    let object = initial["objects"][3]["logicalId"].as_str().unwrap();
    prepare(&db, root, &project, "before-lock");
    let locked = set(&db, root, &project, None, object, true).unwrap();
    assert_eq!(locked["locks"]["images"][0]["objectId"], object);
    assert_eq!(
        db.get_source_candidate(root, &project.project_id, "before-lock")
            .unwrap()["stale"],
        true
    );
    assert!(set(&db, root, &project, None, object, false).is_err());
    assert!(set(&db, "/other", &project, None, object, true).is_err());
    assert!(set(
        &db,
        root,
        &project,
        locked["locks"]["revision"].as_str(),
        initial["objects"][0]["logicalId"].as_str().unwrap(),
        true
    )
    .is_err());
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(context(&db, root, &project), locked);
    let unlocked = set(
        &db,
        root,
        &project,
        locked["locks"]["revision"].as_str(),
        object,
        false,
    )
    .unwrap();
    assert_eq!(unlocked["locks"]["images"], json!([]));
}

#[test]
fn redo_adopts_only_proven_image_uuid_and_rebinds_locks_atomically() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = db
        .open_identified_courseware_project(root, &seed())
        .unwrap();
    let original = context(&db, root, &project);
    let object = original["objects"][3]["logicalId"].as_str().unwrap();
    set(&db, root, &project, None, object, true).unwrap();
    let candidate = prepare(&db, root, &project, "locked-redo");
    let mut identity = seed().identity.unwrap().value().clone();
    identity["sourceSha256"] = json!("b".repeat(64));
    identity["pages"][0]["contentFingerprint"] = json!("c".repeat(64));
    identity["pages"][0]["objects"][0]["contentFingerprint"] = json!("d".repeat(64));
    identity["pages"][0]["objects"][3]["sourceShapeId"] = json!("42");
    let output = ParsedOutput {
        sha256: "b".repeat(64),
        pages: 1,
        identity: Some(identity.clone()),
    };
    let evidence = RedoEvidence {
        protocol: "deckwise-main-redo/1".into(),
        source_sha256: project.source.sha256.clone(),
        output_sha256: output.sha256.clone(),
        mapping_revision: candidate["mappingRevision"].as_str().unwrap().into(),
        page_id: project.pages[0].page_id.clone(),
        slide_part: "ppt/slides/slide1.xml".into(),
    };
    let proofs = vec![PreservedImage {
        page_id: project.pages[0].page_id.clone(),
        object_id: object.into(),
        output_shape_id: "42".into(),
    }];
    let stage = |output, proofs| {
        db.stage_source_candidate_with_locked_proofs(
            root,
            &project.project_id,
            "locked-redo",
            output,
            (None, Some(evidence.clone()), None),
            proofs,
        )
    };
    assert!(stage(output.clone(), vec![]).is_err());
    for field in [
        "geometryFingerprint",
        "contentFingerprint",
        "type",
        "sourceShapeId",
    ] {
        let mut bad = output.clone();
        bad.identity.as_mut().unwrap()["pages"][0]["objects"][3][field] =
            json!(if field == "type" {
                "shape"
            } else if field == "sourceShapeId" {
                "43"
            } else {
                "0"
            });
        assert!(stage(bad, proofs.clone()).is_err(), "{field}");
    }
    stage(output, proofs).unwrap();
    let adoption = db
        .prepare_source_adoption(root, &seed(), "locked-redo")
        .unwrap();
    let next_seed = SavedProjectSeed {
        project_id: project.project_id.clone(),
        sha256: "b".repeat(64),
        pages: 1,
        identity: Some(
            SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap(),
        ),
    };
    let committed = db
        .resolve_source_adoption(
            root,
            &next_seed,
            adoption["adoptionId"].as_str().unwrap(),
            true,
        )
        .unwrap();
    let next: CoursewareProject = serde_json::from_value(committed["project"].clone()).unwrap();
    let saved = context(&db, root, &next);
    assert_eq!(saved["objects"][3]["logicalId"], object);
    assert_ne!(
        saved["objects"][0]["logicalId"],
        original["objects"][0]["logicalId"]
    );
    assert_eq!(saved["locks"]["images"][0]["sourceSha256"], "b".repeat(64));
    assert_eq!(
        saved["locks"]["images"][0]["mappingRevision"],
        saved["mappingRevision"]
    );
    assert_eq!(saved["locks"]["images"][0]["image"]["sourceShapeId"], "42");
}

#[test]
fn stale_lock_requires_explicit_clear_and_unknown_wire_fields_fail_closed() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let project = db
        .open_identified_courseware_project(root, &seed())
        .unwrap();
    let c = context(&db, root, &project);
    let object = c["objects"][3]["logicalId"].as_str().unwrap();
    set(&db, root, &project, None, object, true).unwrap();
    let mut record = db
        .courseware_asset_locks(root, &project.project_id)
        .unwrap()
        .unwrap();
    record.images[0].mapping_revision = "stale-mapping".into();
    db.kv_set(
        NS,
        &storage_key(root, &project.project_id).unwrap(),
        &json!(record),
    )
    .unwrap();
    assert!(db
        .candidate_asset_locks(root, &project, &[project.pages[0].page_id.as_str()])
        .is_err());
    set(&db, root, &project, Some(&record.revision), object, false).unwrap();
    prepare(&db, root, &project, "cleared");
    let mut wire = json!(proof());
    wire["path"] = json!("/forged");
    assert!(serde_json::from_value::<ImageProof>(wire).is_err());
}

#[test]
fn existing_peer_stale_lock_cannot_be_cleared_from_current_page_but_orphan_can() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let mut seed = seed();
    let mut identity = seed.identity.take().unwrap().value().clone();
    let mut peer = identity["pages"][0].clone();
    peer["logicalId"] = json!("peer-parse");
    peer["importPageId"] = json!("page_2");
    for (index, object) in peer["objects"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        object["logicalId"] = json!(format!("peer-object-{index}"));
    }
    identity["pages"].as_array_mut().unwrap().push(peer);
    seed.pages = 2;
    seed.identity =
        Some(SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap());
    let project = db.open_identified_courseware_project(root, &seed).unwrap();
    let c = context(&db, root, &project);
    let object = c["objects"][3]["logicalId"].as_str().unwrap();
    set(&db, root, &project, None, object, true).unwrap();
    let mut record = db
        .courseware_asset_locks(root, &project.project_id)
        .unwrap()
        .unwrap();
    record.images[0].source_sha256 = "b".repeat(64);
    db.kv_set(
        NS,
        &storage_key(root, &project.project_id).unwrap(),
        &json!(record),
    )
    .unwrap();
    assert!(db
        .set_courseware_asset_lock(
            root,
            &project.project_id,
            &project.pages[1].page_id,
            &project.source.revision,
            &project.teaching_revision,
            Some(&record.revision),
            object,
            false,
            None
        )
        .is_err());
    record.images[0].page_id = "deleted-page".into();
    db.kv_set(
        NS,
        &storage_key(root, &project.project_id).unwrap(),
        &json!(record),
    )
    .unwrap();
    set(&db, root, &project, Some(&record.revision), object, false).unwrap();
}

#[test]
#[ignore = "requires DECKWISE_LOCKED_IMAGES_FIXTURE emitted by the real compiler/packaged-worker test"]
fn real_worker_locked_image_identity_adopts_and_reopens() {
    let fixture: Value = serde_json::from_slice(
        &std::fs::read(std::env::var("DECKWISE_LOCKED_IMAGES_FIXTURE").unwrap()).unwrap(),
    )
    .unwrap();
    let source = SavedProjectSeed {
        project_id: "real-worker-locked-lesson".into(),
        sha256: fixture["before"]["sourceSha256"].as_str().unwrap().into(),
        pages: 3,
        identity: Some(
            SavedSourceIdentity::parse(&serde_json::to_vec(&fixture["before"]).unwrap()).unwrap(),
        ),
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let project = db
        .open_identified_courseware_project(root, &source)
        .unwrap();
    let page = &project.pages[1].page_id;
    let context = db
        .courseware_asset_lock_context(
            root,
            &project.project_id,
            page,
            &project.source.revision,
            &project.teaching_revision,
        )
        .unwrap();
    let image: ImageProof = serde_json::from_value(fixture["lock"].clone()).unwrap();
    let old = context["objects"][image.z_index]["logicalId"]
        .as_str()
        .unwrap()
        .to_string();
    db.set_courseware_asset_lock(
        root,
        &project.project_id,
        page,
        &project.source.revision,
        &project.teaching_revision,
        None,
        &old,
        true,
        Some(image),
    )
    .unwrap();
    let candidate = db
        .prepare_source_candidate(
            root,
            &source,
            SourceCandidateRequest {
                candidate_id: "real-locked-redo".into(),
                page_id: page.clone(),
                kind: Kind::PagePptx,
                expected_source_revision: project.source.revision.clone(),
                expected_teaching_revision: project.teaching_revision.clone(),
                style_batch: None,
            },
        )
        .unwrap();
    let output = ParsedOutput {
        sha256: fixture["after"]["sourceSha256"].as_str().unwrap().into(),
        pages: 3,
        identity: Some(fixture["after"].clone()),
    };
    db.stage_source_candidate_with_locked_proofs(
        root,
        &project.project_id,
        "real-locked-redo",
        output.clone(),
        (
            None,
            Some(RedoEvidence {
                protocol: "deckwise-main-redo/1".into(),
                source_sha256: source.sha256.clone(),
                output_sha256: output.sha256.clone(),
                mapping_revision: candidate["mappingRevision"].as_str().unwrap().into(),
                page_id: page.clone(),
                slide_part: "ppt/slides/slide2.xml".into(),
            }),
            None,
        ),
        vec![PreservedImage {
            page_id: page.clone(),
            object_id: old.clone(),
            output_shape_id: fixture["outputShapeId"].as_str().unwrap().into(),
        }],
    )
    .unwrap();
    let adoption = db
        .prepare_source_adoption(root, &source, "real-locked-redo")
        .unwrap();
    let output_seed = SavedProjectSeed {
        project_id: source.project_id.clone(),
        sha256: output.sha256,
        pages: 3,
        identity: Some(
            SavedSourceIdentity::parse(&serde_json::to_vec(&fixture["after"]).unwrap()).unwrap(),
        ),
    };
    let committed = db
        .resolve_source_adoption(
            root,
            &output_seed,
            adoption["adoptionId"].as_str().unwrap(),
            true,
        )
        .unwrap();
    assert_eq!(committed["project"]["pages"][0], json!(project.pages[0]));
    assert_eq!(committed["project"]["pages"][2], json!(project.pages[2]));
    drop(db);
    let db = Database::open(&path).unwrap();
    let next = db
        .get_courseware_project(root, &source.project_id)
        .unwrap()
        .unwrap();
    let current = db
        .courseware_asset_lock_context(
            root,
            &next.project_id,
            page,
            &next.source.revision,
            &next.teaching_revision,
        )
        .unwrap();
    assert_eq!(current["objects"][1]["logicalId"], old);
    assert_eq!(current["locks"]["images"][0]["objectId"], old);
    assert_eq!(
        current["locks"]["images"][0]["sourceSha256"],
        next.source.sha256
    );
    let second = db
        .prepare_source_candidate(
            root,
            &output_seed,
            SourceCandidateRequest {
                candidate_id: "real-locked-redo-second".into(),
                page_id: page.clone(),
                kind: Kind::PagePptx,
                expected_source_revision: next.source.revision.clone(),
                expected_teaching_revision: next.teaching_revision.clone(),
                style_batch: None,
            },
        )
        .unwrap();
    let second_output = ParsedOutput {
        sha256: fixture["second"]["sourceSha256"].as_str().unwrap().into(),
        pages: 3,
        identity: Some(fixture["second"].clone()),
    };
    db.stage_source_candidate_with_locked_proofs(
        root,
        &next.project_id,
        "real-locked-redo-second",
        second_output.clone(),
        (
            None,
            Some(RedoEvidence {
                protocol: "deckwise-main-redo/1".into(),
                source_sha256: next.source.sha256.clone(),
                output_sha256: second_output.sha256.clone(),
                mapping_revision: second["mappingRevision"].as_str().unwrap().into(),
                page_id: page.clone(),
                slide_part: "ppt/slides/slide2.xml".into(),
            }),
            None,
        ),
        vec![PreservedImage {
            page_id: page.clone(),
            object_id: old.clone(),
            output_shape_id: fixture["secondOutputShapeId"].as_str().unwrap().into(),
        }],
    )
    .unwrap();
    let second_adoption = db
        .prepare_source_adoption(root, &output_seed, "real-locked-redo-second")
        .unwrap();
    let second_seed = SavedProjectSeed {
        project_id: next.project_id.clone(),
        sha256: second_output.sha256,
        pages: 3,
        identity: Some(
            SavedSourceIdentity::parse(&serde_json::to_vec(&fixture["second"]).unwrap()).unwrap(),
        ),
    };
    let committed = db
        .resolve_source_adoption(
            root,
            &second_seed,
            second_adoption["adoptionId"].as_str().unwrap(),
            true,
        )
        .unwrap();
    let final_project: CoursewareProject =
        serde_json::from_value(committed["project"].clone()).unwrap();
    let current = db
        .courseware_asset_lock_context(
            root,
            &next.project_id,
            page,
            &final_project.source.revision,
            &final_project.teaching_revision,
        )
        .unwrap();
    assert_eq!(current["objects"][1]["logicalId"], old);
    assert_eq!(current["locks"]["images"][0]["objectId"], old);
    assert_eq!(
        current["locks"]["images"][0]["image"]["pictureSha256"],
        fixture["lock"]["pictureSha256"]
    );
}
