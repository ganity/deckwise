use super::super::redo_tests::seed;
use super::*;
use crate::courseware::identity::SavedSourceIdentity;
use serde_json::json;

fn parsed(seed: SavedProjectSeed) -> ParsedOutput {
    ParsedOutput {
        sha256: seed.sha256,
        pages: seed.pages,
        identity: seed.identity.map(|i| i.value().clone()),
    }
}

fn rebuilt_seed() -> SavedProjectSeed {
    let mut result = seed('c', true);
    let mut identity = result.identity.unwrap().value().clone();
    identity["pages"][0]["contentFingerprint"] = json!("e".repeat(64));
    identity["pages"][0]["objects"]
        .as_array_mut()
        .unwrap()
        .truncate(1);
    identity["pages"][0]["objects"][0]["contentFingerprint"] = json!("f".repeat(64));
    result.identity =
        Some(SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap());
    result
}

fn fixture(
    db: &Database,
    root: &str,
) -> (
    CoursewareProject,
    SourceCandidateRequest,
    StyleBatchEvidence,
) {
    let mut project = db
        .open_identified_courseware_project(root, &seed('a', false))
        .unwrap();
    for index in 0..3 {
        project = db.write_courseware_teaching(root, &TeachingWrite {
            project_id: project.project_id.clone(), page_id: project.pages[index].page_id.clone(),
            expected_source_revision: project.source.revision.clone(), expected_teaching_revision: project.teaching_revision.clone(),
            actions: vec![json!({"id":format!("speech-{index}"),"type":"speech","text":"Good!","pauseAfterMs":4000})],
        }).unwrap();
        project = db
            .review_courseware_page(
                root,
                &project.project_id,
                &project.pages[index].page_id,
                &project.source.revision,
                &project.teaching_revision,
            )
            .unwrap();
    }
    project = db
        .set_courseware_page_lock(
            root,
            &project.project_id,
            &project.pages[2].page_id,
            &project.source.revision,
            &project.teaching_revision,
            true,
        )
        .unwrap();
    let representative = SourceCandidateRequest {
        candidate_id: "representative".into(),
        page_id: project.pages[1].page_id.clone(),
        kind: Kind::PagePptx,
        expected_source_revision: project.source.revision.clone(),
        expected_teaching_revision: project.teaching_revision.clone(),
        style_batch: None,
    };
    let prepared = db
        .prepare_source_candidate(root, &seed('a', false), representative)
        .unwrap();
    let mapping = prepared["mappingRevision"].as_str().unwrap().to_string();
    db.stage_source_candidate_with_proofs(
        root,
        &project.project_id,
        "representative",
        parsed(seed('b', true)),
        (
            None,
            Some(RedoEvidence {
                protocol: "deckwise-main-redo/1".into(),
                source_sha256: project.source.sha256.clone(),
                output_sha256: "b".repeat(64),
                mapping_revision: mapping.clone(),
                page_id: project.pages[1].page_id.clone(),
                slide_part: "ppt/slides/slide2.xml".into(),
            }),
            None,
        ),
    )
    .unwrap();
    let page_ids = vec![
        project.pages[1].page_id.clone(),
        project.pages[0].page_id.clone(),
    ];
    let request = SourceCandidateRequest {
        candidate_id: "batch-1".into(),
        page_id: project.pages[1].page_id.clone(),
        kind: Kind::StyleBatch,
        expected_source_revision: project.source.revision.clone(),
        expected_teaching_revision: project.teaching_revision.clone(),
        style_batch: Some(StyleBatchScope {
            representative_candidate_id: "representative".into(),
            representative_output_sha256: "b".repeat(64),
            instruction_hash: format!("sha256:{}", "d".repeat(64)),
            page_ids: page_ids.clone(),
        }),
    };
    let proof = StyleBatchEvidence {
        protocol: "deckwise-main-style-batch/1".into(),
        source_sha256: project.source.sha256.clone(),
        output_sha256: "c".repeat(64),
        mapping_revision: mapping,
        targets: page_ids
            .into_iter()
            .zip([2, 1])
            .map(|(page_id, n)| StyleBatchTarget {
                page_id,
                slide_part: format!("ppt/slides/slide{n}.xml"),
            })
            .collect(),
    };
    (project, request, proof)
}

fn stage(db: &Database, root: &str, proof: StyleBatchEvidence) -> Result<Value> {
    db.stage_source_candidate_with_proofs(
        root,
        "office-redo",
        "batch-1",
        parsed(rebuilt_seed()),
        (None, None, Some(proof)),
    )
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
fn confirmed_batch_preserves_peers_and_teaching_across_cancel_commit_and_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let (before, old, pending, intent);
    {
        let db = Database::open(&path).unwrap();
        let (project, request, proof) = fixture(&db, root);
        before = json!(project);
        old = bound(&db, root, 'a');
        let prepared = db
            .prepare_source_candidate(root, &seed('a', false), request.clone())
            .unwrap();
        assert_eq!(
            prepared["targetPageIds"],
            json!(request.style_batch.unwrap().page_ids)
        );
        db.stage_source_candidate(root, "office-redo", "batch-1", parsed(rebuilt_seed()))
            .unwrap();
        assert!(db
            .prepare_source_adoption(root, &seed('a', false), "batch-1")
            .is_err());
        pending = stage(&db, root, proof.clone()).unwrap();
        assert_eq!(pending["lineageVerified"], true);
        assert_eq!(pending["applied"], false);
        assert_eq!(stage(&db, root, proof).unwrap(), pending);
        assert_eq!(
            json!(db
                .get_courseware_project(root, "office-redo")
                .unwrap()
                .unwrap()),
            before
        );
        intent = db
            .prepare_source_adoption(root, &seed('a', false), "batch-1")
            .unwrap();
    }
    let committed;
    {
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.get_source_candidate(root, "office-redo", "batch-1")
                .unwrap(),
            pending
        );
        assert_eq!(db.get_source_adoption(root, "office-redo").unwrap(), intent);
        db.resolve_source_adoption(
            root,
            &seed('a', false),
            intent["adoptionId"].as_str().unwrap(),
            false,
        )
        .unwrap();
        assert_eq!(
            json!(db
                .get_courseware_project(root, "office-redo")
                .unwrap()
                .unwrap()),
            before
        );
        let intent = db
            .prepare_source_adoption(root, &seed('a', false), "batch-1")
            .unwrap();
        committed = db
            .resolve_source_adoption(
                root,
                &rebuilt_seed(),
                intent["adoptionId"].as_str().unwrap(),
                true,
            )
            .unwrap();
        assert_eq!(
            db.resolve_source_adoption(
                root,
                &rebuilt_seed(),
                intent["adoptionId"].as_str().unwrap(),
                true
            )
            .unwrap(),
            committed
        );
        let next = &committed["project"];
        let new = bound(&db, root, 'c');
        let old_ids: Vec<_> = old["pages"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|p| p["objects"].as_array().unwrap())
            .map(|o| &o["logicalId"])
            .collect();
        for index in 0..3 {
            assert_eq!(
                next["pages"][index]["pageId"],
                before["pages"][index]["pageId"]
            );
            assert_eq!(
                next["pages"][index]["actions"],
                before["pages"][index]["actions"]
            );
            assert_eq!(
                next["pages"][index]["locked"],
                before["pages"][index]["locked"]
            );
            assert_eq!(
                next["pages"][index]["reviewState"],
                if index < 2 {
                    json!("review")
                } else {
                    before["pages"][index]["reviewState"].clone()
                }
            );
            assert_eq!(
                new["pages"][index]["logicalId"],
                old["pages"][index]["logicalId"]
            );
            if index < 2 {
                for object in new["pages"][index]["objects"].as_array().unwrap() {
                    assert!(!old_ids.contains(&&object["logicalId"]));
                }
            } else {
                assert_eq!(new["pages"][index], old["pages"][index]);
            }
        }
        assert_eq!(bound(&db, root, 'a'), old);
        db.ensure_no_source_adoption(root).unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        json!(db
            .get_courseware_project(root, "office-redo")
            .unwrap()
            .unwrap()),
        committed["project"]
    );
    assert_eq!(
        db.get_source_candidate(root, "office-redo", "batch-1")
            .unwrap()["status"],
        "adopted"
    );
}

#[test]
fn invalid_or_unverified_representative_and_scope_never_prepare_a_batch() {
    for change in [
        "missing-scope",
        "wrong-kind",
        "self",
        "wrong-representative",
        "wrong-hash",
        "instruction",
        "one-page",
        "duplicate",
        "foreign",
        "locked",
        "too-many",
        "wrong-page",
        "rejected",
        "unverified",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (project, request, _) = fixture(&db, root);
        let mut value = json!(request);
        match change {
            "missing-scope" => {
                value.as_object_mut().unwrap().remove("styleBatch");
            }
            "wrong-kind" => value["kind"] = json!("page-pptx"),
            "self" => value["styleBatch"]["representativeCandidateId"] = json!("batch-1"),
            "wrong-representative" => {
                value["styleBatch"]["representativeCandidateId"] = json!("missing")
            }
            "wrong-hash" => {
                value["styleBatch"]["representativeOutputSha256"] = json!("f".repeat(64))
            }
            "instruction" => value["styleBatch"]["instructionHash"] = json!("not-a-hash"),
            "one-page" => {
                value["styleBatch"]["pageIds"].as_array_mut().unwrap().pop();
            }
            "duplicate" => {
                value["styleBatch"]["pageIds"][1] = value["styleBatch"]["pageIds"][0].clone()
            }
            "foreign" => value["styleBatch"]["pageIds"][1] = json!("foreign"),
            "locked" => value["styleBatch"]["pageIds"][1] = json!(project.pages[2].page_id),
            "too-many" => {
                value["styleBatch"]["pageIds"] = json!(vec![project.pages[1].page_id.clone(); 21])
            }
            "wrong-page" => value["pageId"] = json!(project.pages[0].page_id),
            "rejected" => {
                db.reject_source_candidate(root, "office-redo", "representative")
                    .unwrap();
            }
            "unverified" => {
                let key = key(root, "office-redo", "representative").unwrap();
                let mut stored = db.kv_get(CANDIDATES, &key).unwrap().unwrap();
                stored.as_object_mut().unwrap().remove("redoEvidence");
                db.kv_set(CANDIDATES, &key, &stored).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            db.prepare_source_candidate(
                root,
                &seed('a', false),
                serde_json::from_value(value).unwrap()
            )
            .is_err(),
            "{change}"
        );
        assert!(db
            .get_source_candidate(root, "office-redo", "batch-1")
            .is_err());
        assert_eq!(
            json!(db
                .get_courseware_project(root, "office-redo")
                .unwrap()
                .unwrap()),
            json!(project)
        );
    }
}

#[test]
fn forged_batch_proof_or_peer_changes_roll_back_without_verified_status() {
    for change in [
        "protocol",
        "sourceSha256",
        "outputSha256",
        "mappingRevision",
        "extra-target",
        "target-order",
        "duplicate-part",
        "unsafe-part",
        "peer-content",
        "peer-object",
        "page-order",
        "both-proofs",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (project, request, proof) = fixture(&db, root);
        let before = db
            .prepare_source_candidate(root, &seed('a', false), request)
            .unwrap();
        let mut value = json!(proof);
        let mut output = parsed(rebuilt_seed());
        let mut redo = None;
        match change {
            "extra-target" => {
                let extra = value["targets"][0].clone();
                value["targets"].as_array_mut().unwrap().push(extra);
            }
            "target-order" => value["targets"].as_array_mut().unwrap().reverse(),
            "duplicate-part" => {
                value["targets"][1]["slidePart"] = value["targets"][0]["slidePart"].clone()
            }
            "unsafe-part" => value["targets"][0]["slidePart"] = json!("ppt/slides/../slide2.xml"),
            "peer-content" => {
                output.identity.as_mut().unwrap()["pages"][2]["contentFingerprint"] =
                    json!("f".repeat(64))
            }
            "peer-object" => {
                output.identity.as_mut().unwrap()["pages"][2]["objects"]
                    .as_array_mut()
                    .unwrap()
                    .pop();
            }
            "page-order" => output.identity.as_mut().unwrap()["pages"]
                .as_array_mut()
                .unwrap()
                .swap(0, 2),
            "both-proofs" => {
                redo = Some(RedoEvidence {
                    protocol: "deckwise-main-redo/1".into(),
                    source_sha256: project.source.sha256.clone(),
                    output_sha256: "c".repeat(64),
                    mapping_revision: before["mappingRevision"].as_str().unwrap().into(),
                    page_id: project.pages[1].page_id.clone(),
                    slide_part: "ppt/slides/slide2.xml".into(),
                })
            }
            _ => value[change] = json!("wrong"),
        }
        assert!(
            db.stage_source_candidate_with_proofs(
                root,
                "office-redo",
                "batch-1",
                output,
                (None, redo, Some(serde_json::from_value(value).unwrap()))
            )
            .is_err(),
            "{change}"
        );
        assert_eq!(
            db.get_source_candidate(root, "office-redo", "batch-1")
                .unwrap(),
            before,
            "{change}"
        );
        assert_eq!(
            json!(db
                .get_courseware_project(root, "office-redo")
                .unwrap()
                .unwrap()),
            json!(project)
        );
        db.ensure_no_source_adoption(root).unwrap();
    }
}

#[test]
fn representative_rejection_invalidates_pending_batch_before_adoption() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (_, request, proof) = fixture(&db, root);
    db.prepare_source_candidate(root, &seed('a', false), request)
        .unwrap();
    stage(&db, root, proof.clone()).unwrap();
    db.reject_source_candidate(root, "office-redo", "representative")
        .unwrap();
    assert_eq!(
        db.get_source_candidate(root, "office-redo", "batch-1")
            .unwrap()["stale"],
        true
    );
    assert!(stage(&db, root, proof).is_err());
    assert!(db
        .prepare_source_adoption(root, &seed('a', false), "batch-1")
        .is_err());
    db.ensure_no_source_adoption(root).unwrap();
}

#[test]
fn batch_commit_failures_preserve_recoverable_intent_and_retry_once() {
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
        let (_, request, proof) = fixture(&db, root);
        db.prepare_source_candidate(root, &seed('a', false), request)
            .unwrap();
        stage(&db, root, proof).unwrap();
        let intent = db
            .prepare_source_adoption(root, &seed('a', false), "batch-1")
            .unwrap();
        let id = intent["adoptionId"].as_str().unwrap();
        let mut parsed = rebuilt_seed();
        if failure == "identity" {
            let mut identity = parsed.identity.unwrap().value().clone();
            identity["pages"][0]["contentFingerprint"] = json!("0".repeat(64));
            parsed.identity =
                Some(SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap());
        } else if failure == "stale" {
            let project_key = storage_key(root, "office-redo").unwrap();
            let mut current = db.kv_get(NAMESPACE, &project_key).unwrap().unwrap();
            current["pages"][0]["locked"] = json!(true);
            db.kv_set(NAMESPACE, &project_key, &current).unwrap();
        } else {
            let (operation, namespace) = failure.split_once(':').unwrap();
            let row = if operation == "DELETE" { "OLD" } else { "NEW" };
            db.conn.execute_batch(&format!("CREATE TRIGGER batch_failure BEFORE {operation} ON kv WHEN {row}.ns='{namespace}' BEGIN SELECT RAISE(IGNORE); END;")).unwrap();
        }
        let current = json!(db
            .get_courseware_project(root, "office-redo")
            .unwrap()
            .unwrap());
        assert!(
            db.resolve_source_adoption(root, &parsed, id, true).is_err(),
            "{failure}"
        );
        assert_eq!(
            json!(db
                .get_courseware_project(root, "office-redo")
                .unwrap()
                .unwrap()),
            current
        );
        assert_eq!(db.get_source_adoption(root, "office-redo").unwrap(), intent);
        assert_eq!(
            db.get_source_candidate(root, "office-redo", "batch-1")
                .unwrap()["status"],
            "needs-review"
        );
        assert!(db.ensure_no_source_adoption(root).is_err());
        if failure.contains(':') {
            db.conn.execute_batch("DROP TRIGGER batch_failure").unwrap();
            let committed = db
                .resolve_source_adoption(root, &rebuilt_seed(), id, true)
                .unwrap();
            assert_eq!(
                db.resolve_source_adoption(root, &rebuilt_seed(), id, true)
                    .unwrap(),
                committed
            );
            db.ensure_no_source_adoption(root).unwrap();
        }
    }
}
