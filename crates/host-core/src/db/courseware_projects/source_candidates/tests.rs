use super::*;
use crate::courseware::identity::SavedSourceIdentity;
use serde_json::json;

fn seed(hash: char) -> SavedProjectSeed {
    let mut identity: Value = serde_json::from_slice(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    identity["sourceSha256"] = json!(hash.to_string().repeat(64));
    SavedProjectSeed {
        project_id: "office-source-candidate".into(),
        sha256: hash.to_string().repeat(64),
        pages: 1,
        identity: Some(
            SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap(),
        ),
    }
}

fn request(project: &CoursewareProject) -> SourceCandidateRequest {
    SourceCandidateRequest {
        candidate_id: "candidate-1".into(),
        page_id: project.pages[0].page_id.clone(),
        kind: Kind::PagePptx,
        expected_source_revision: project.source.revision.clone(),
        expected_teaching_revision: project.teaching_revision.clone(),
        style_batch: None,
    }
}

fn output() -> ParsedOutput {
    let seed = seed('b');
    ParsedOutput {
        sha256: seed.sha256,
        pages: seed.pages,
        identity: seed.identity.map(|identity| identity.value().clone()),
    }
}

fn fade_evidence(project: &CoursewareProject, mapping: &str) -> FadeEvidence {
    FadeEvidence {
        protocol: "deckwise-main-fade/1".into(),
        source_sha256: project.source.sha256.clone(),
        output_sha256: "b".repeat(64),
        mapping_revision: mapping.into(),
        page_id: project.pages[0].page_id.clone(),
        slide_part: "ppt/slides/slide1.xml".into(),
    }
}

#[test]
fn verified_fade_upgrades_legacy_candidate_and_survives_restart_without_applying() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let original = seed('a');
    let verified;
    {
        let db = Database::open(&path).unwrap();
        let project = db
            .open_identified_courseware_project(root, &original)
            .unwrap();
        let mut input = request(&project);
        input.kind = Kind::PageFade;
        let prepared = db.prepare_source_candidate(root, &original, input).unwrap();
        let proof = fade_evidence(&project, prepared["mappingRevision"].as_str().unwrap());
        let legacy = db
            .stage_source_candidate(root, &project.project_id, "candidate-1", output())
            .unwrap();
        assert_eq!(legacy["lineageVerified"], false);
        verified = db
            .stage_source_candidate_with_evidence(
                root,
                &project.project_id,
                "candidate-1",
                output(),
                Some(proof.clone()),
            )
            .unwrap();
        assert_eq!(verified["lineageVerified"], true);
        assert_eq!(verified["applied"], false);
        assert_eq!(verified["status"], "needs-review");
        assert_eq!(
            db.stage_source_candidate_with_evidence(
                root,
                &project.project_id,
                "candidate-1",
                output(),
                Some(proof)
            )
            .unwrap(),
            verified
        );
        assert_eq!(
            db.stage_source_candidate(root, &project.project_id, "candidate-1", output())
                .unwrap(),
            verified
        );
        assert_eq!(current(&db, root), serde_json::to_value(project).unwrap());
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.get_source_candidate(root, &original.project_id, "candidate-1")
            .unwrap(),
        verified
    );
    assert_eq!(
        db.reject_source_candidate(root, &original.project_id, "candidate-1")
            .unwrap()["status"],
        "rejected"
    );
}

#[test]
fn fade_evidence_rejects_mismatched_scope_hashes_identity_and_kind_atomically() {
    for change in [
        "protocol",
        "sourceSha256",
        "outputSha256",
        "mappingRevision",
        "pageId",
        "slidePart",
        "kind",
        "pageContent",
        "objectContent",
        "geometry",
        "shape",
        "importId",
        "objectOrder",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let original = seed('a');
        let project = db
            .open_identified_courseware_project(root, &original)
            .unwrap();
        let mut input = request(&project);
        if change != "kind" {
            input.kind = Kind::PageFade;
        }
        let prepared = db.prepare_source_candidate(root, &original, input).unwrap();
        let mut proof = serde_json::to_value(fade_evidence(
            &project,
            prepared["mappingRevision"].as_str().unwrap(),
        ))
        .unwrap();
        let mut output = output();
        match change {
            "pageContent" => {
                output.identity.as_mut().unwrap()["pages"][0]["contentFingerprint"] =
                    json!("c".repeat(64))
            }
            "objectContent" => {
                output.identity.as_mut().unwrap()["pages"][0]["objects"][0]["contentFingerprint"] =
                    json!("c".repeat(64))
            }
            "geometry" => {
                output.identity.as_mut().unwrap()["pages"][0]["objects"][0]["geometryFingerprint"] =
                    json!("c".repeat(64))
            }
            "shape" => {
                output.identity.as_mut().unwrap()["pages"][0]["objects"][0]["sourceShapeId"] =
                    json!("changed")
            }
            "importId" => {
                output.identity.as_mut().unwrap()["pages"][0]["importPageId"] = json!("page_2")
            }
            "objectOrder" => output.identity.as_mut().unwrap()["pages"][0]["objects"]
                .as_array_mut()
                .unwrap()
                .swap(0, 1),
            "kind" => {}
            "slidePart" => proof[change] = json!("ppt/slides/../slide1.xml"),
            _ => proof[change] = json!("changed"),
        }
        assert!(
            db.stage_source_candidate_with_evidence(
                root,
                &project.project_id,
                "candidate-1",
                output,
                Some(serde_json::from_value(proof).unwrap())
            )
            .is_err(),
            "{change}"
        );
        assert_eq!(
            db.get_source_candidate(root, &project.project_id, "candidate-1")
                .unwrap(),
            prepared,
            "{change}"
        );
        assert_eq!(current(&db, root), serde_json::to_value(project).unwrap());
    }
}

#[test]
fn failed_fade_evidence_update_preserves_unverified_output() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let original = seed('a');
    let project = db
        .open_identified_courseware_project(root, &original)
        .unwrap();
    let mut input = request(&project);
    input.kind = Kind::PageFade;
    let prepared = db.prepare_source_candidate(root, &original, input).unwrap();
    let proof = fade_evidence(&project, prepared["mappingRevision"].as_str().unwrap());
    let staged = db
        .stage_source_candidate(root, &project.project_id, "candidate-1", output())
        .unwrap();
    db.conn.execute_batch("CREATE TRIGGER ignore_fade BEFORE UPDATE ON kv WHEN OLD.ns='coursewareSourceCandidates.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(db
        .stage_source_candidate_with_evidence(
            root,
            &project.project_id,
            "candidate-1",
            output(),
            Some(proof)
        )
        .is_err());
    assert_eq!(
        db.get_source_candidate(root, &project.project_id, "candidate-1")
            .unwrap(),
        staged
    );
}

fn current(db: &Database, root: &str) -> Value {
    serde_json::to_value(
        db.get_courseware_project(root, &seed('a').project_id)
            .unwrap()
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn generator_context_exports_complete_host_mapping_and_recovers_without_parser_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let original = seed('a');
    let context;
    {
        let db = Database::open(&path).unwrap();
        let project = db
            .open_identified_courseware_project(root, &original)
            .unwrap();
        let prepared = db
            .prepare_source_candidate(root, &original, request(&project))
            .unwrap();
        let identity = db
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(root, &original.project_id, &original.sha256).unwrap(),
            )
            .unwrap()
            .unwrap();
        context = db
            .source_candidate_context(root, &original.project_id, "candidate-1")
            .unwrap();
        assert_eq!(context["candidate"], prepared);
        assert_eq!(context["mapping"]["revision"], identity["mappingRevision"]);
        assert_eq!(context["mapping"]["sourceSha256"], original.sha256);
        let pages = context["mapping"]["pages"].as_array().unwrap();
        assert_eq!(pages.len(), project.pages.len());
        for (page, saved) in pages.iter().zip(identity["pages"].as_array().unwrap()) {
            assert_eq!(page["pageId"], saved["logicalId"]);
            assert_eq!(page["importPageId"], saved["importPageId"]);
            let objects = page["objects"].as_array().unwrap();
            assert_eq!(objects.len(), saved["objects"].as_array().unwrap().len());
            for (object, saved) in objects.iter().zip(saved["objects"].as_array().unwrap()) {
                assert_eq!(
                    object,
                    &json!({"objectId":saved["logicalId"], "importElementId":saved["importElementId"]})
                );
            }
        }
        assert!(!serde_json::to_string(&context)
            .unwrap()
            .contains("contentFingerprint"));
        assert_eq!(current(&db, root), serde_json::to_value(project).unwrap());
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.source_candidate_context(root, &original.project_id, "candidate-1")
            .unwrap(),
        context
    );
    for (workspace, project, candidate) in [
        (
            "/another-workspace",
            original.project_id.as_str(),
            "candidate-1",
        ),
        (root, "another-project", "candidate-1"),
        (root, original.project_id.as_str(), "missing"),
    ] {
        assert!(db
            .source_candidate_context(workspace, project, candidate)
            .is_err());
    }
    db.stage_source_candidate(root, &original.project_id, "candidate-1", output())
        .unwrap();
    assert_eq!(
        db.source_candidate_context(root, &original.project_id, "candidate-1")
            .unwrap()["mapping"],
        context["mapping"]
    );
    db.reject_source_candidate(root, &original.project_id, "candidate-1")
        .unwrap();
    assert!(db
        .source_candidate_context(root, &original.project_id, "candidate-1")
        .is_err());
}

#[test]
fn generator_context_rejects_corrupt_or_incomplete_saved_identity() {
    for change in ["source", "pages", "objects", "unbound", "unknown"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let original = seed('a');
        let project = db
            .open_identified_courseware_project(root, &original)
            .unwrap();
        db.prepare_source_candidate(root, &original, request(&project))
            .unwrap();
        let key = identities::identity_key(root, &original.project_id, &original.sha256).unwrap();
        let mut identity = db
            .kv_get(identities::IDENTITY_NAMESPACE, &key)
            .unwrap()
            .unwrap();
        match change {
            "source" => identity["sourceSha256"] = json!("c".repeat(64)),
            "pages" => identity["pages"] = json!([]),
            "objects" => identity["pages"][0]["objects"] = Value::Null,
            "unbound" => {
                identity.as_object_mut().unwrap().remove("mappingRevision");
            }
            "unknown" => identity["callerMapping"] = json!({}),
            _ => unreachable!(),
        }
        db.kv_set(identities::IDENTITY_NAMESPACE, &key, &identity)
            .unwrap();
        assert!(
            db.source_candidate_context(root, &original.project_id, "candidate-1")
                .is_err(),
            "{change}"
        );
    }
}

#[test]
fn prepare_stage_reject_survive_restart_without_changing_source_teaching_or_history() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let original = seed('a');
    let baseline;
    let input;
    let prepared;
    {
        let db = Database::open(&path).unwrap();
        let project = db
            .open_identified_courseware_project(root, &original)
            .unwrap();
        baseline = current(&db, root);
        input = request(&project);
        prepared = db
            .prepare_source_candidate(root, &original, input.clone())
            .unwrap();
        assert_eq!(prepared["status"], "preparing");
        assert_eq!(prepared["outputSha256"], Value::Null);
        assert_eq!(
            db.prepare_source_candidate(root, &original, input.clone())
                .unwrap(),
            prepared
        );
    }
    let staged;
    {
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.get_source_candidate(root, &original.project_id, "candidate-1")
                .unwrap(),
            prepared
        );
        staged = db
            .stage_source_candidate(root, &original.project_id, "candidate-1", output())
            .unwrap();
        assert_eq!(staged["status"], "needs-review");
        assert_eq!(staged["applied"], false);
        assert_eq!(staged["lineageVerified"], false);
        assert_eq!(staged["stale"], false);
        assert_eq!(
            db.stage_source_candidate(root, &original.project_id, "candidate-1", output())
                .unwrap(),
            staged
        );
        assert_eq!(current(&db, root), baseline);
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
    {
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.get_source_candidate(root, &original.project_id, "candidate-1")
                .unwrap(),
            staged
        );
        let rejected = db
            .reject_source_candidate(root, &original.project_id, "candidate-1")
            .unwrap();
        assert_eq!(rejected["status"], "rejected");
        assert_eq!(
            db.reject_source_candidate(root, &original.project_id, "candidate-1")
                .unwrap(),
            rejected
        );
        assert_eq!(
            db.prepare_source_candidate(root, &original, input).unwrap(),
            rejected
        );
        assert!(db
            .stage_source_candidate(root, &original.project_id, "candidate-1", output())
            .is_err());
        assert_eq!(current(&db, root), baseline);
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.get_source_candidate(root, &original.project_id, "candidate-1")
            .unwrap()["status"],
        "rejected"
    );
    assert_eq!(current(&db, root), baseline);
}

#[test]
fn changes_to_full_project_or_mapping_make_candidates_stale_and_never_stage() {
    for change in [
        "teachingRevision",
        "source",
        "title",
        "educationContext",
        "actions",
        "locked",
        "mapping",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let seed = seed('a');
        let project = db.open_identified_courseware_project(root, &seed).unwrap();
        db.prepare_source_candidate(root, &seed, request(&project))
            .unwrap();
        let mut next = current(&db, root);
        match change {
            "mapping" => {
                let key = identities::identity_key(root, &seed.project_id, &seed.sha256).unwrap();
                let mut identity = db
                    .kv_get(identities::IDENTITY_NAMESPACE, &key)
                    .unwrap()
                    .unwrap();
                identity["mappingRevision"] = json!("other-mapping");
                db.kv_set(identities::IDENTITY_NAMESPACE, &key, &identity)
                    .unwrap();
            }
            "locked" => next["pages"][0]["locked"] = json!(true),
            "actions" => {
                next["pages"][0]["actions"] =
                    json!([{"id":"speech","type":"speech","text":"Good!","pauseAfterMs":4000}])
            }
            "source" => next["source"]["revision"] = json!("other-source-revision"),
            "educationContext" => next["educationContext"] = json!({"schoolStage":"KINDERGARTEN"}),
            _ => next[change] = json!("changed"),
        }
        db.kv_set(
            NAMESPACE,
            &storage_key(root, &seed.project_id).unwrap(),
            &next,
        )
        .unwrap();
        assert_eq!(
            db.get_source_candidate(root, &seed.project_id, "candidate-1")
                .unwrap()["stale"],
            true,
            "{change}"
        );
        assert!(
            db.source_candidate_context(root, &seed.project_id, "candidate-1")
                .is_err(),
            "{change}"
        );
        assert!(
            db.stage_source_candidate(root, &seed.project_id, "candidate-1", output())
                .unwrap_err()
                .to_string()
                .starts_with("COURSEWARE_CONFLICT"),
            "{change}"
        );
        assert_eq!(current(&db, root), next);
        assert_eq!(
            db.reject_source_candidate(root, &seed.project_id, "candidate-1")
                .unwrap()["status"],
            "rejected"
        );
    }
}

#[test]
fn invalid_output_or_reused_id_cannot_replace_a_prepared_or_staged_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let original = seed('a');
    let project = db
        .open_identified_courseware_project(root, &original)
        .unwrap();
    let prepared = db
        .prepare_source_candidate(root, &original, request(&project))
        .unwrap();
    for change in ["hash", "pages", "identity", "unchanged", "bound"] {
        let mut invalid = output();
        match change {
            "hash" => invalid.sha256 = "c".repeat(64),
            "pages" => invalid.pages = 2,
            "identity" => invalid.identity = None,
            "bound" => invalid.identity.as_mut().unwrap()["mappingRevision"] = json!("not-raw"),
            "unchanged" => {
                invalid.sha256 = original.sha256.clone();
                invalid.identity = original
                    .identity
                    .as_ref()
                    .map(|identity| identity.value().clone());
            }
            _ => unreachable!(),
        }
        assert!(
            db.stage_source_candidate(root, &original.project_id, "candidate-1", invalid)
                .is_err(),
            "{change}"
        );
        assert_eq!(
            db.get_source_candidate(root, &original.project_id, "candidate-1")
                .unwrap(),
            prepared
        );
    }
    let mut another = request(&project);
    another.kind = Kind::PageFade;
    assert!(db
        .prepare_source_candidate(root, &original, another)
        .is_err());
    db.stage_source_candidate(root, &original.project_id, "candidate-1", output())
        .unwrap();
    let mut other = output();
    other.identity.as_mut().unwrap()["pages"][0]["contentFingerprint"] = json!("c".repeat(64));
    assert!(db
        .stage_source_candidate(root, &original.project_id, "candidate-1", other)
        .is_err());
}

#[test]
fn workspace_targets_locks_revisions_and_unsupported_media_are_fenced() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let original = seed('a');
    let project = db
        .open_identified_courseware_project(root, &original)
        .unwrap();
    for change in ["source", "teaching", "page", "candidate"] {
        let mut input = request(&project);
        match change {
            "source" => input.expected_source_revision = "stale".into(),
            "teaching" => input.expected_teaching_revision = "stale".into(),
            "page" => input.page_id = "missing".into(),
            "candidate" => input.candidate_id = "../escape".into(),
            _ => unreachable!(),
        }
        assert!(db.prepare_source_candidate(root, &original, input).is_err());
    }
    db.prepare_source_candidate(root, &original, request(&project))
        .unwrap();
    for workspace in ["/another-workspace", "relative"] {
        assert!(db
            .get_source_candidate(workspace, &original.project_id, "candidate-1")
            .is_err());
        assert!(db
            .reject_source_candidate(workspace, &original.project_id, "candidate-1")
            .is_err());
        assert!(db
            .stage_source_candidate(workspace, &original.project_id, "candidate-1", output())
            .is_err());
    }
    let locked = db
        .set_courseware_page_lock(
            root,
            &project.project_id,
            &project.pages[0].page_id,
            &project.source.revision,
            &project.teaching_revision,
            true,
        )
        .unwrap();
    assert!(db
        .prepare_source_candidate(root, &original, request(&locked))
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_LOCKED"));
    let mut media = serde_json::to_value(project).unwrap();
    media["pages"][0]["actions"] = json!([{"id":"audio","type":"audio","url":"keep-intact"}]);
    db.kv_set(
        NAMESPACE,
        &storage_key(root, &original.project_id).unwrap(),
        &media,
    )
    .unwrap();
    let project: CoursewareProject = serde_json::from_value(media.clone()).unwrap();
    assert!(db
        .prepare_source_candidate(root, &original, request(&project))
        .is_err());
    assert_eq!(current(&db, root), media);
}

#[test]
fn failed_status_cas_leaves_preparation_intact_and_rejection_can_cancel_preparation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let seed = seed('a');
    let project = db.open_identified_courseware_project(root, &seed).unwrap();
    let prepared = db
        .prepare_source_candidate(root, &seed, request(&project))
        .unwrap();
    db.conn.execute_batch("CREATE TRIGGER ignore_candidate_update BEFORE UPDATE ON kv WHEN OLD.ns='coursewareSourceCandidates.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(db
        .stage_source_candidate(root, &seed.project_id, "candidate-1", output())
        .is_err());
    assert!(db
        .reject_source_candidate(root, &seed.project_id, "candidate-1")
        .is_err());
    assert_eq!(
        db.get_source_candidate(root, &seed.project_id, "candidate-1")
            .unwrap(),
        prepared
    );
    db.conn
        .execute_batch("DROP TRIGGER ignore_candidate_update")
        .unwrap();
    let rejected = db
        .reject_source_candidate(root, &seed.project_id, "candidate-1")
        .unwrap();
    assert_eq!(rejected["status"], "rejected");
    assert_eq!(rejected["outputSha256"], Value::Null);
    assert_eq!(current(&db, root), serde_json::to_value(project).unwrap());
}
