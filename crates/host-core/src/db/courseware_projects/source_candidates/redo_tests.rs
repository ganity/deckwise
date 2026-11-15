use super::*;
use crate::courseware::identity::SavedSourceIdentity;
use serde_json::json;

pub(super) fn seed(hash: char, rebuilt: bool) -> SavedProjectSeed {
    let mut identity: Value = serde_json::from_slice(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    let template = identity["pages"][0].clone();
    identity["sourceSha256"] = json!(hash.to_string().repeat(64));
    identity["pages"] = json!((1..=3)
        .map(|index| {
            let mut page = template.clone();
            page["logicalId"] = json!(format!("parsed-page-{index}"));
            page["importPageId"] = json!(format!("page_{index}"));
            for (i, object) in page["objects"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .enumerate()
            {
                object["logicalId"] = json!(format!("parsed-object-{index}-{i}"));
            }
            if rebuilt && index == 2 {
                page["contentFingerprint"] = json!("c".repeat(64));
                page["objects"].as_array_mut().unwrap().truncate(2);
                page["objects"][0]["contentFingerprint"] = json!("d".repeat(64));
            }
            page
        })
        .collect::<Vec<_>>());
    SavedProjectSeed {
        project_id: "office-redo".into(),
        sha256: hash.to_string().repeat(64),
        pages: 3,
        identity: Some(
            SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap(),
        ),
    }
}

fn output() -> ParsedOutput {
    let seed = seed('b', true);
    ParsedOutput {
        sha256: seed.sha256,
        pages: seed.pages,
        identity: seed.identity.map(|v| v.value().clone()),
    }
}

fn fixture(db: &Database, root: &str) -> (CoursewareProject, RedoEvidence) {
    let source = seed('a', false);
    let mut project = db
        .open_identified_courseware_project(root, &source)
        .unwrap();
    for index in 0..3 {
        project = db.write_courseware_teaching(root, &TeachingWrite {
            project_id: project.project_id.clone(), page_id: project.pages[index].page_id.clone(),
            expected_source_revision: project.source.revision.clone(), expected_teaching_revision: project.teaching_revision.clone(),
            actions: vec![json!({"id":format!("speech-{index}"),"type":"speech","text":"Good!","pauseAfterMs":4000})],
        }).unwrap();
    }
    let prepared = db
        .prepare_source_candidate(
            root,
            &source,
            SourceCandidateRequest {
                candidate_id: "redo-1".into(),
                page_id: project.pages[1].page_id.clone(),
                kind: Kind::PagePptx,
                expected_source_revision: project.source.revision.clone(),
                expected_teaching_revision: project.teaching_revision.clone(),
                style_batch: None,
            },
        )
        .unwrap();
    let proof = RedoEvidence {
        protocol: "deckwise-main-redo/1".into(),
        source_sha256: source.sha256,
        output_sha256: output().sha256,
        mapping_revision: prepared["mappingRevision"].as_str().unwrap().into(),
        page_id: project.pages[1].page_id.clone(),
        slide_part: "ppt/slides/slide2.xml".into(),
    };
    (project, proof)
}

fn current(db: &Database, root: &str) -> Value {
    json!(db
        .get_courseware_project(root, "office-redo")
        .unwrap()
        .unwrap())
}

fn bound(db: &Database, root: &str, hash: char) -> Value {
    db.kv_get(
        identities::IDENTITY_NAMESPACE,
        &identities::identity_key(root, "office-redo", &hash.to_string().repeat(64)).unwrap(),
    )
    .unwrap()
    .unwrap()
}

#[test]
fn redo_keeps_pages_and_narration_but_retires_target_objects_across_restarts() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let (before, old_identity, staged, intent);
    {
        let db = Database::open(&path).unwrap();
        let (project, proof) = fixture(&db, root);
        before = json!(project);
        old_identity = bound(&db, root, 'a');
        // Old unverified records remain readable and may acquire a trusted attestation later.
        assert_eq!(
            db.stage_source_candidate(root, "office-redo", "redo-1", output())
                .unwrap()["lineageVerified"],
            false
        );
        assert!(db
            .prepare_source_adoption(root, &seed('a', false), "redo-1")
            .is_err());
        staged = db
            .stage_source_candidate_with_proofs(
                root,
                "office-redo",
                "redo-1",
                output(),
                (None, Some(proof.clone()), None),
            )
            .unwrap();
        assert_eq!(staged["lineageVerified"], true);
        assert_eq!(staged["applied"], false);
        assert_eq!(
            db.stage_source_candidate_with_proofs(
                root,
                "office-redo",
                "redo-1",
                output(),
                (None, Some(proof), None)
            )
            .unwrap(),
            staged
        );
        intent = db
            .prepare_source_adoption(root, &seed('a', false), "redo-1")
            .unwrap();
        assert_eq!(current(&db, root), before);
        assert!(db.ensure_no_source_adoption(root).is_err());
    }
    let committed;
    {
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.get_source_candidate(root, "office-redo", "redo-1")
                .unwrap(),
            staged
        );
        assert_eq!(db.get_source_adoption(root, "office-redo").unwrap(), intent);
        assert_eq!(
            db.prepare_source_adoption(root, &seed('a', false), "redo-1")
                .unwrap(),
            intent
        );
        committed = db
            .resolve_source_adoption(
                root,
                &seed('b', true),
                intent["adoptionId"].as_str().unwrap(),
                true,
            )
            .unwrap();
        let next = &committed["project"];
        for index in 0..3 {
            assert_eq!(
                next["pages"][index]["pageId"],
                before["pages"][index]["pageId"]
            );
            assert_eq!(
                next["pages"][index]["actions"],
                before["pages"][index]["actions"]
            );
        }
        assert_eq!(next["pages"][1]["reviewState"], "review");
        let new_identity = bound(&db, root, 'b');
        for index in [0, 2] {
            assert_eq!(new_identity["pages"][index], old_identity["pages"][index]);
        }
        let old_ids: Vec<_> = old_identity["pages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|p| p["objects"].as_array().unwrap())
            .map(|o| &o["logicalId"])
            .collect();
        assert_eq!(
            new_identity["pages"][1]["objects"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        for object in new_identity["pages"][1]["objects"].as_array().unwrap() {
            assert!(!old_ids.contains(&&object["logicalId"]));
        }
        assert_eq!(bound(&db, root, 'a'), old_identity);
        assert_eq!(
            db.get_source_candidate(root, "office-redo", "redo-1")
                .unwrap()["status"],
            "adopted"
        );
        db.ensure_no_source_adoption(root).unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.resolve_source_adoption(
            root,
            &seed('b', true),
            intent["adoptionId"].as_str().unwrap(),
            true
        )
        .unwrap(),
        committed
    );
    assert!(db
        .reject_source_candidate(root, "office-redo", "redo-1")
        .is_err());
}

#[test]
fn redo_rejects_wrong_attestation_and_non_target_changes_without_staging() {
    for change in [
        "protocol",
        "sourceSha256",
        "outputSha256",
        "mappingRevision",
        "pageId",
        "slidePart",
        "non-target-content",
        "non-target-object",
        "non-target-geometry",
        "page-order",
        "target-import",
        "missing-page",
        "both-proofs",
        "kind",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (project, proof) = fixture(&db, root);
        let mut proof_json = json!(proof);
        let mut parsed = output();
        let pages = &mut parsed.identity.as_mut().unwrap()["pages"];
        match change {
            "non-target-content" => pages[0]["contentFingerprint"] = json!("e".repeat(64)),
            "non-target-object" => pages[2]["objects"]
                .as_array_mut()
                .unwrap()
                .pop()
                .map(|_| ())
                .unwrap(),
            "non-target-geometry" => {
                pages[0]["objects"][0]["geometryFingerprint"] = json!("e".repeat(64))
            }
            "page-order" => pages.as_array_mut().unwrap().swap(0, 1),
            "target-import" => pages[1]["importPageId"] = json!("page_9"),
            "missing-page" => {
                pages.as_array_mut().unwrap().pop();
            }
            "both-proofs" => {}
            "kind" => {
                let stored_key = key(root, "office-redo", "redo-1").unwrap();
                let mut stored = db.kv_get(CANDIDATES, &stored_key).unwrap().unwrap();
                stored["request"]["kind"] = json!("page-fade");
                db.kv_set(CANDIDATES, &stored_key, &stored).unwrap();
            }
            "slidePart" => proof_json[change] = json!("ppt/slides/../slide2.xml"),
            _ => proof_json[change] = json!("wrong"),
        }
        let before = db
            .get_source_candidate(root, "office-redo", "redo-1")
            .unwrap();
        let fade = (change == "both-proofs").then(|| FadeEvidence {
            protocol: "deckwise-main-fade/1".into(),
            ..proof.clone()
        });
        assert!(
            db.stage_source_candidate_with_proofs(
                root,
                "office-redo",
                "redo-1",
                parsed,
                (
                    fade,
                    Some(serde_json::from_value(proof_json).unwrap()),
                    None
                )
            )
            .is_err(),
            "{change}"
        );
        assert_eq!(
            db.get_source_candidate(root, "office-redo", "redo-1")
                .unwrap(),
            before,
            "{change}"
        );
        assert_eq!(current(&db, root), json!(project));
        db.ensure_no_source_adoption(root).unwrap();
    }
}

#[test]
fn redo_late_mutation_and_failed_commits_preserve_pending_intent() {
    for failure in [
        "identity",
        "stale",
        "INSERT:coursewareHistory.v1",
        "INSERT:coursewareIdentities.v1",
        "UPDATE:coursewareProjects.v1",
        "UPDATE:coursewareSourceCandidates.v1",
        "UPDATE:coursewareSourceAdoptions.v1",
        "DELETE:coursewareSourceAdoptionLocks.v1",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (_, proof) = fixture(&db, root);
        db.stage_source_candidate_with_proofs(
            root,
            "office-redo",
            "redo-1",
            output(),
            (None, Some(proof), None),
        )
        .unwrap();
        let intent = db
            .prepare_source_adoption(root, &seed('a', false), "redo-1")
            .unwrap();
        let id = intent["adoptionId"].as_str().unwrap();
        let mut parsed = seed('b', true);
        if failure == "identity" {
            let mut identity = parsed.identity.unwrap().value().clone();
            identity["pages"][1]["contentFingerprint"] = json!("f".repeat(64));
            parsed.identity =
                Some(SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap());
        } else if failure == "stale" {
            let mut value = current(&db, root);
            value["pages"][0]["locked"] = json!(true);
            db.kv_set(
                NAMESPACE,
                &storage_key(root, "office-redo").unwrap(),
                &value,
            )
            .unwrap();
        } else {
            let (operation, namespace) = failure.split_once(':').unwrap();
            let row = if operation == "DELETE" { "OLD" } else { "NEW" };
            db.conn.execute_batch(&format!("CREATE TRIGGER redo_failure BEFORE {operation} ON kv WHEN {row}.ns='{namespace}' BEGIN SELECT RAISE(IGNORE); END;")).unwrap();
        }
        let before = current(&db, root);
        assert!(
            db.resolve_source_adoption(root, &parsed, id, true).is_err(),
            "{failure}"
        );
        assert_eq!(current(&db, root), before);
        assert_eq!(db.get_source_adoption(root, "office-redo").unwrap(), intent);
        assert_eq!(
            db.get_source_candidate(root, "office-redo", "redo-1")
                .unwrap()["status"],
            "needs-review"
        );
        assert!(db.ensure_no_source_adoption(root).is_err());
        if failure.contains(':') {
            db.conn.execute_batch("DROP TRIGGER redo_failure").unwrap();
            assert_eq!(
                db.resolve_source_adoption(root, &seed('b', true), id, true)
                    .unwrap()["status"],
                "committed"
            );
        }
    }
}

#[test]
fn redo_can_cancel_only_on_original_and_keeps_legacy_serialization() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (project, proof) = fixture(&db, root);
    let stored = db
        .kv_get(CANDIDATES, &key(root, "office-redo", "redo-1").unwrap())
        .unwrap()
        .unwrap();
    assert!(stored.get("redoEvidence").is_none());
    db.stage_source_candidate_with_proofs(
        root,
        "office-redo",
        "redo-1",
        output(),
        (None, Some(proof), None),
    )
    .unwrap();
    let intent = db
        .prepare_source_adoption(root, &seed('a', false), "redo-1")
        .unwrap();
    let id = intent["adoptionId"].as_str().unwrap();
    assert!(db
        .resolve_source_adoption(root, &seed('b', true), id, false)
        .is_err());
    assert_eq!(
        db.resolve_source_adoption(root, &seed('a', false), id, false)
            .unwrap()["status"],
        "cancelled"
    );
    db.ensure_no_source_adoption(root).unwrap();
    assert_eq!(current(&db, root), json!(project));
    assert_eq!(
        db.get_source_candidate(root, "office-redo", "redo-1")
            .unwrap()["applied"],
        false
    );
}
