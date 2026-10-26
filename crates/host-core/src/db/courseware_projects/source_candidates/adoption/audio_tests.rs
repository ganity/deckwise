use super::*;
use crate::courseware::snapshot_assets;
use crate::db::courseware_projects::source_candidates::batch::StyleBatchTarget;
use crate::db::courseware_projects::source_candidates::redo_tests::seed;
use crate::db::courseware_projects::tts::{audio::Audio, Selection, TaskRef};
use serde_json::json;
use sha2::{Digest, Sha256};

const PRINCIPAL: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn fixture(db: &Database, root: &str) -> (CoursewareProject, Vec<(String, Audio, Value)>) {
    let mut project = db
        .open_identified_courseware_project(root, &seed('a', false))
        .unwrap();
    let mut receipts = vec![];
    for index in 0..3 {
        project = db.write_courseware_teaching(root, &TeachingWrite {
            project_id: project.project_id.clone(), page_id: project.pages[index].page_id.clone(),
            expected_source_revision: project.source.revision.clone(), expected_teaching_revision: project.teaching_revision.clone(),
            actions: vec![json!({"id":format!("speech-{index}"),"type":"speech","text":format!("Exact narration {index}"),"source":"notes","pauseAfterMs":1700+index}),
                json!({"id":format!("wait-{index}"),"type":"interaction_checkpoint","checkpointId":format!("checkpoint-{index}"),"checkpointKind":"teacher_continue"})],
        }).unwrap();
        let intent_id = format!("intent-{index}");
        let prepared = db
            .prepare_courseware_tts(
                root,
                Selection {
                    intent_id: intent_id.clone(),
                    principal_key: PRINCIPAL.into(),
                    project_id: project.project_id.clone(),
                    page_id: project.pages[index].page_id.clone(),
                    action_id: format!("speech-{index}"),
                    expected_source_revision: project.source.revision.clone(),
                    expected_teaching_revision: project.teaching_revision.clone(),
                    model: "courseware-tts-v1".into(),
                    voice: Some("fixture-voice".into()),
                },
            )
            .unwrap();
        db.begin_courseware_tts(
            root,
            &project.project_id,
            PRINCIPAL,
            &intent_id,
            "test-session",
        )
        .unwrap();
        let task = TaskRef {
            task_id: format!("task-{index}"),
            idempotency_key: prepared["intent"]["idempotencyKey"]
                .as_str()
                .unwrap()
                .into(),
            request_hash: prepared["intent"]["requestHash"].as_str().unwrap().into(),
        };
        db.bind_courseware_tts(
            root,
            &project.project_id,
            PRINCIPAL,
            &intent_id,
            task.clone(),
        )
        .unwrap();
        let mut bytes = vec![0; 46];
        bytes[..4].copy_from_slice(b"RIFF");
        bytes[4..8].copy_from_slice(&38u32.to_le_bytes());
        bytes[8..16].copy_from_slice(b"WAVEfmt ");
        bytes[16..20].copy_from_slice(&16u32.to_le_bytes());
        bytes[20..22].copy_from_slice(&1u16.to_le_bytes());
        bytes[22..24].copy_from_slice(&1u16.to_le_bytes());
        bytes[24..28].copy_from_slice(&8000u32.to_le_bytes());
        bytes[28..32].copy_from_slice(&16000u32.to_le_bytes());
        bytes[32..34].copy_from_slice(&2u16.to_le_bytes());
        bytes[34..36].copy_from_slice(&16u16.to_le_bytes());
        bytes[36..40].copy_from_slice(b"data");
        bytes[40..44].copy_from_slice(&2u32.to_le_bytes());
        bytes[44] = index as u8;
        let audio = Audio {
            task_ref: task,
            sha256: hex::encode(Sha256::digest(&bytes)),
            mime_type: "audio/wav".into(),
            byte_length: bytes.len() as u64,
            duration_ms: 1,
        };
        snapshot_assets::archive_bytes(std::path::Path::new(root), &audio.sha256, &bytes).unwrap();
        db.stage_courseware_tts_audio(
            root,
            &project.project_id,
            PRINCIPAL,
            &intent_id,
            audio.clone(),
        )
        .unwrap();
        project = db
            .adopt_courseware_tts_audio(
                root,
                &project.project_id,
                PRINCIPAL,
                &intent_id,
                &project.teaching_revision,
                None,
            )
            .unwrap();
        let intent = db
            .get_courseware_tts(root, &project.project_id, PRINCIPAL, &intent_id)
            .unwrap()["intent"]
            .clone();
        receipts.push((intent_id, audio, intent));
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
    (project, receipts)
}

fn stage(
    db: &Database,
    root: &str,
    project: &CoursewareProject,
    batch: bool,
) -> (SavedProjectSeed, String) {
    let prepared = db
        .prepare_source_candidate(
            root,
            &seed('a', false),
            SourceCandidateRequest {
                candidate_id: "audio-redo".into(),
                page_id: project.pages[1].page_id.clone(),
                kind: Kind::PagePptx,
                expected_source_revision: project.source.revision.clone(),
                expected_teaching_revision: project.teaching_revision.clone(),
                style_batch: None,
            },
        )
        .unwrap();
    let output = seed('b', true);
    let parsed = |seed: &SavedProjectSeed| ParsedOutput {
        sha256: seed.sha256.clone(),
        pages: seed.pages,
        identity: seed.identity.as_ref().map(|i| i.value().clone()),
    };
    let mapping = prepared["mappingRevision"].as_str().unwrap().to_string();
    db.stage_source_candidate_with_proofs(
        root,
        &project.project_id,
        "audio-redo",
        parsed(&output),
        (
            None,
            Some(RedoEvidence {
                protocol: "deckwise-main-redo/1".into(),
                source_sha256: project.source.sha256.clone(),
                output_sha256: output.sha256.clone(),
                mapping_revision: mapping.clone(),
                page_id: project.pages[1].page_id.clone(),
                slide_part: "ppt/slides/slide2.xml".into(),
            }),
            None,
        ),
    )
    .unwrap();
    if !batch {
        return (output, "audio-redo".into());
    }
    let mut output = seed('c', true);
    let mut identity = output.identity.unwrap().value().clone();
    identity["pages"][0]["contentFingerprint"] = json!("e".repeat(64));
    output.identity =
        Some(SavedSourceIdentity::parse(&serde_json::to_vec(&identity).unwrap()).unwrap());
    let page_ids = vec![
        project.pages[1].page_id.clone(),
        project.pages[0].page_id.clone(),
    ];
    db.prepare_source_candidate(
        root,
        &seed('a', false),
        SourceCandidateRequest {
            candidate_id: "audio-batch".into(),
            page_id: project.pages[1].page_id.clone(),
            kind: Kind::StyleBatch,
            expected_source_revision: project.source.revision.clone(),
            expected_teaching_revision: project.teaching_revision.clone(),
            style_batch: Some(StyleBatchScope {
                representative_candidate_id: "audio-redo".into(),
                representative_output_sha256: "b".repeat(64),
                instruction_hash: format!("sha256:{}", "d".repeat(64)),
                page_ids: page_ids.clone(),
            }),
        },
    )
    .unwrap();
    db.stage_source_candidate_with_proofs(
        root,
        &project.project_id,
        "audio-batch",
        parsed(&output),
        (
            None,
            None,
            Some(StyleBatchEvidence {
                protocol: "deckwise-main-style-batch/1".into(),
                source_sha256: project.source.sha256.clone(),
                output_sha256: output.sha256.clone(),
                mapping_revision: mapping,
                targets: page_ids
                    .into_iter()
                    .zip([2, 1])
                    .map(|(page_id, n)| StyleBatchTarget {
                        page_id,
                        slide_part: format!("ppt/slides/slide{n}.xml"),
                    })
                    .collect(),
            }),
        ),
    )
    .unwrap();
    (output, "audio-batch".into())
}

fn add_attention(db: &Database, root: &str, project: &mut CoursewareProject, index: usize) {
    let locked = project.pages[index].locked;
    if locked {
        *project = db
            .set_courseware_page_lock(
                root,
                &project.project_id,
                &project.pages[index].page_id,
                &project.source.revision,
                &project.teaching_revision,
                false,
            )
            .unwrap();
    }
    let identity = db
        .kv_get(
            identities::IDENTITY_NAMESPACE,
            &identities::identity_key(root, &project.project_id, &project.source.sha256).unwrap(),
        )
        .unwrap()
        .unwrap();
    let object_id = identity["pages"][index]["objects"][0]["logicalId"].clone();
    let mut actions = project.pages[index].actions.clone();
    actions[0]["visualCues"] = json!([
        {"id":"highlight", "atMs":0, "endMs":1, "effect":{"type":"highlight", "elementIds":[object_id.clone()]}},
        {"id":"spotlight", "atMs":0, "endMs":1, "effect":{"type":"spotlight", "elementId":object_id}}
    ]);
    *project = db
        .write_courseware_teaching(
            root,
            &TeachingWrite {
                project_id: project.project_id.clone(),
                page_id: project.pages[index].page_id.clone(),
                expected_source_revision: project.source.revision.clone(),
                expected_teaching_revision: project.teaching_revision.clone(),
                actions,
            },
        )
        .unwrap();
    if locked {
        *project = db
            .set_courseware_page_lock(
                root,
                &project.project_id,
                &project.pages[index].page_id,
                &project.source.revision,
                &project.teaching_revision,
                true,
            )
            .unwrap();
    }
}

fn durable_audio_adoption(batch: bool, attention_page: Option<usize>) {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("db.sqlite");
    let (before, receipts, output, pending, original_records, original_identity);
    {
        let db = Database::open(&path).unwrap();
        let (mut project, saved) = fixture(&db, root);
        if let Some(index) = attention_page {
            add_attention(&db, root, &mut project, index);
        }
        (before, receipts) = (project, saved);
        original_identity = db
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(root, &before.project_id, &before.source.sha256).unwrap(),
            )
            .unwrap()
            .unwrap();
        original_records = receipts
            .iter()
            .map(|(id, _, _)| {
                json!(db
                    .get_courseware_tts_audio(root, &before.project_id, PRINCIPAL, id)
                    .unwrap())
            })
            .collect::<Vec<_>>();
        let (parsed, candidate) = stage(&db, root, &before, batch);
        output = parsed;
        let tx = db.conn.unchecked_transaction().unwrap();
        let changes = db.conn.total_changes();
        let mut next = before.clone();
        next.source = CoursewareSource {
            revision: output.sha256.clone(),
            sha256: output.sha256.clone(),
        };
        db.validate_courseware_review_audio(root, &before, &next)
            .unwrap();
        assert_eq!(
            db.conn.total_changes(),
            changes,
            "preflight must execute no database writes"
        );
        tx.rollback().unwrap();
        pending = db
            .prepare_source_adoption(root, &seed('a', false), &candidate)
            .unwrap();
        for ((id, _, _), original) in receipts.iter().zip(&original_records) {
            assert_eq!(
                json!(db
                    .get_courseware_tts_audio(root, &before.project_id, PRINCIPAL, id)
                    .unwrap()),
                *original
            );
        }
    }
    let committed;
    {
        let db = Database::open(&path).unwrap();
        committed = db
            .resolve_source_adoption(root, &output, pending["adoptionId"].as_str().unwrap(), true)
            .unwrap();
        let next: CoursewareProject = serde_json::from_value(committed["project"].clone()).unwrap();
        for index in 0..3 {
            assert_eq!(next.pages[index].actions, before.pages[index].actions);
            assert_eq!(next.pages[index].page_id, before.pages[index].page_id);
            assert_eq!(next.pages[index].locked, before.pages[index].locked);
        }
        assert_ne!(next.source.sha256, before.source.sha256);
        let identity = db
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(root, &before.project_id, &next.source.sha256).unwrap(),
            )
            .unwrap()
            .unwrap();
        for index in 0..3 {
            assert_eq!(
                identity["pages"][index]["logicalId"],
                original_identity["pages"][index]["logicalId"]
            );
        }
        assert_eq!(identity["pages"][2], original_identity["pages"][2]);
        if !batch {
            assert_eq!(identity["pages"][0], original_identity["pages"][0]);
        }
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.get_source_adoption(root, &before.project_id).unwrap(),
        committed
    );
    assert_eq!(
        db.kv_get(
            identities::IDENTITY_NAMESPACE,
            &identities::identity_key(root, &before.project_id, &before.source.sha256).unwrap()
        )
        .unwrap()
        .unwrap(),
        original_identity
    );
    for ((id, audio, intent), original_record) in receipts.into_iter().zip(original_records) {
        let record = db
            .get_courseware_tts_audio(root, &before.project_id, PRINCIPAL, &id)
            .unwrap();
        assert_eq!(json!(record.audio), json!(audio));
        assert_eq!(
            json!(record.adopted_teaching_revision),
            original_record["adoptedTeachingRevision"]
        );
        assert_eq!(record.bound_source.unwrap().sha256, output.sha256);
        assert_eq!(
            db.get_courseware_tts(root, &before.project_id, PRINCIPAL, &id)
                .unwrap()["intent"],
            intent
        );
        let (archived, length) = snapshot_assets::verify(dir.path(), &audio.sha256).unwrap();
        assert_eq!(length, audio.byte_length);
        assert_eq!(
            hex::encode(Sha256::digest(std::fs::read(archived).unwrap())),
            audio.sha256
        );
    }
}

#[test]
fn invalid_attention_cues_and_legacy_audio_still_reject_intact() {
    for extra in [
        json!({"visualCues":[{"id":"cue", "atMs":0, "endMs":1,
            "effect":{"type":"highlight", "elementIds":["unreviewed-target"]}}]}),
        json!({"voice":"legacy-voice"}),
        json!({"audioUrl":"legacy-url"}),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (mut project, _) = fixture(&db, root);
        project.pages[1].actions[0]
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        db.kv_set(
            NAMESPACE,
            &storage_key(root, &project.project_id).unwrap(),
            &json!(project),
        )
        .unwrap();
        let result = db.prepare_source_candidate(
            root,
            &seed('a', false),
            SourceCandidateRequest {
                candidate_id: "unsupported-audio".into(),
                page_id: project.pages[1].page_id.clone(),
                kind: Kind::PagePptx,
                expected_source_revision: project.source.revision.clone(),
                expected_teaching_revision: project.teaching_revision.clone(),
                style_batch: None,
            },
        );
        assert!(result.is_err());
        assert!(db
            .get_source_candidate(root, &project.project_id, "unsupported-audio")
            .is_err());
        assert_eq!(
            json!(db
                .get_courseware_project(root, &project.project_id)
                .unwrap()
                .unwrap()),
            json!(project)
        );
        db.ensure_no_source_adoption(root).unwrap();
    }
}

#[test]
fn redo_preserves_adopted_audio_bytes_receipts_and_pauses_after_restart() {
    durable_audio_adoption(false, None);
}
#[test]
fn representative_batch_preserves_adopted_audio_bytes_receipts_and_locked_peer_after_restart() {
    durable_audio_adoption(true, None);
}

#[test]
fn redo_preserves_peer_attention_cues_and_audio_after_restart() {
    durable_audio_adoption(false, Some(0));
}

#[test]
fn batch_preserves_locked_peer_attention_cues_and_audio_after_restart() {
    durable_audio_adoption(true, Some(2));
}

#[test]
fn verified_fade_preserves_current_page_attention_cues_and_audio_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("db.sqlite");
    let db = Database::open(&path).unwrap();
    let (mut project, _) = fixture(&db, root);
    add_attention(&db, root, &mut project, 0);
    let prepared = db
        .prepare_source_candidate(
            root,
            &seed('a', false),
            SourceCandidateRequest {
                candidate_id: "attention-fade".into(),
                page_id: project.pages[0].page_id.clone(),
                kind: Kind::PageFade,
                expected_source_revision: project.source.revision.clone(),
                expected_teaching_revision: project.teaching_revision.clone(),
                style_batch: None,
            },
        )
        .unwrap();
    let output = seed('b', false);
    db.stage_source_candidate_with_evidence(
        root,
        &project.project_id,
        "attention-fade",
        ParsedOutput {
            sha256: output.sha256.clone(),
            pages: output.pages,
            identity: output.identity.as_ref().map(|i| i.value().clone()),
        },
        Some(FadeEvidence {
            protocol: "deckwise-main-fade/1".into(),
            source_sha256: project.source.sha256.clone(),
            output_sha256: output.sha256.clone(),
            mapping_revision: prepared["mappingRevision"].as_str().unwrap().into(),
            page_id: project.pages[0].page_id.clone(),
            slide_part: "ppt/slides/slide1.xml".into(),
        }),
    )
    .unwrap();
    let pending = db
        .prepare_source_adoption(root, &seed('a', false), "attention-fade")
        .unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    let committed = db
        .resolve_source_adoption(root, &output, pending["adoptionId"].as_str().unwrap(), true)
        .unwrap();
    let next: CoursewareProject = serde_json::from_value(committed["project"].clone()).unwrap();
    for (next, old) in next.pages.iter().zip(&project.pages) {
        assert_eq!(next.actions, old.actions);
    }
    let bound = db
        .kv_get(
            identities::IDENTITY_NAMESPACE,
            &identities::identity_key(root, &project.project_id, &output.sha256).unwrap(),
        )
        .unwrap()
        .unwrap();
    let target = &next.pages[0].actions[0]["visualCues"][0]["effect"]["elementIds"][0];
    assert_eq!(*target, bound["pages"][0]["objects"][0]["logicalId"]);
    assert_ne!(next.teaching_revision, project.teaching_revision);
}

#[test]
fn preserved_attention_requires_valid_original_targets() {
    for change in ["missing", "cross-page", "effect-kind", "timing"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (mut project, _) = fixture(&db, root);
        add_attention(&db, root, &mut project, 0);
        let cue = &mut project.pages[0].actions[0]["visualCues"][0];
        match change {
            "missing" => cue["effect"]["elementIds"] = json!(["missing-target"]),
            "cross-page" => {
                let identity = db
                    .kv_get(
                        identities::IDENTITY_NAMESPACE,
                        &identities::identity_key(
                            root,
                            &project.project_id,
                            &project.source.sha256,
                        )
                        .unwrap(),
                    )
                    .unwrap()
                    .unwrap();
                cue["effect"]["elementIds"] =
                    json!([identity["pages"][1]["objects"][0]["logicalId"]]);
            }
            "effect-kind" => cue["effect"]["type"] = json!("unknown-effect"),
            "timing" => cue["endMs"] = json!(0),
            _ => {}
        }
        db.kv_set(
            NAMESPACE,
            &storage_key(root, &project.project_id).unwrap(),
            &json!(project),
        )
        .unwrap();
        let error = db
            .prepare_source_candidate(
                root,
                &seed('a', false),
                SourceCandidateRequest {
                    candidate_id: "invalid-attention".into(),
                    page_id: project.pages[0].page_id.clone(),
                    kind: Kind::PageFade,
                    expected_source_revision: project.source.revision.clone(),
                    expected_teaching_revision: project.teaching_revision.clone(),
                    style_batch: None,
                },
            )
            .unwrap_err();
        assert!(error.to_string().contains("COURSEWARE_INVALID"));
        assert!(db
            .get_source_candidate(root, &project.project_id, "invalid-attention")
            .is_err());
        assert_eq!(
            json!(db
                .get_courseware_project(root, &project.project_id)
                .unwrap()
                .unwrap()),
            json!(project)
        );
        db.ensure_no_source_adoption(root).unwrap();
    }
}

#[test]
fn rebuilt_attention_requires_explicit_choices_and_survives_adoption_restart_with_audio() {
    for batch in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let path = dir.path().join("db.sqlite");
        let db = Database::open(&path).unwrap();
        let (mut before, receipts) = fixture(&db, root);
        add_attention(&db, root, &mut before, 1);
        add_attention(&db, root, &mut before, 2);
        let original_audio: Vec<Value> = receipts
            .iter()
            .map(|(id, _, _)| {
                json!(db
                    .get_courseware_tts_audio(root, &before.project_id, PRINCIPAL, id)
                    .unwrap())
            })
            .collect();
        let (output, candidate_id) = stage(&db, root, &before, batch);
        let view = db
            .get_source_candidate(root, &before.project_id, &candidate_id)
            .unwrap();
        assert_eq!(view["effectTargets"].as_array().unwrap().len(), 1);
        assert_eq!(view["effectTargets"][0]["pageId"], before.pages[1].page_id);
        assert_eq!(view["effectPages"].as_array().unwrap().len(), 3);
        let old_id = before.pages[1].actions[0]["visualCues"][0]["effect"]["elementIds"][0].clone();
        let binding = json!({"pageIndex":1,"objectId":old_id,"targetIndex":2});
        for invalid in [
            vec![],
            vec![json!({"pageIndex":0,"objectId":old_id,"targetIndex":2})],
            vec![json!({"pageIndex":1,"objectId":"foreign","targetIndex":2})],
            vec![json!({"pageIndex":1,"objectId":old_id,"targetIndex":99})],
            vec![json!({"pageIndex":1,"objectId":old_id,"targetIndex":2,"extra":true})],
            vec![binding.clone(), binding.clone()],
        ] {
            assert!(db
                .prepare_source_adoption_with_path(
                    root,
                    &seed('a', false),
                    &candidate_id,
                    None,
                    &invalid
                )
                .is_err());
            db.ensure_no_source_adoption(root).unwrap();
            assert_eq!(
                json!(db
                    .get_courseware_project(root, &before.project_id)
                    .unwrap()
                    .unwrap()),
                json!(before)
            );
        }
        let pending = db
            .prepare_source_adoption_with_path(
                root,
                &seed('a', false),
                &candidate_id,
                None,
                &[binding.clone()],
            )
            .unwrap();
        assert!(db
            .prepare_source_adoption_with_path(root, &seed('a', false), &candidate_id, None, &[])
            .is_err());
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.prepare_source_adoption_with_path(
                root,
                &seed('a', false),
                &candidate_id,
                None,
                &[binding]
            )
            .unwrap(),
            pending
        );
        db.conn.execute_batch("CREATE TRIGGER attention_commit_failure BEFORE UPDATE ON kv WHEN NEW.ns='coursewareSourceAdoptions.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
        assert!(db
            .resolve_source_adoption(root, &output, pending["adoptionId"].as_str().unwrap(), true)
            .is_err());
        assert_eq!(
            json!(db
                .get_courseware_project(root, &before.project_id)
                .unwrap()
                .unwrap()),
            json!(before)
        );
        assert_eq!(
            db.get_source_adoption(root, &before.project_id).unwrap(),
            pending
        );
        assert!(db
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(root, &before.project_id, &output.sha256).unwrap()
            )
            .unwrap()
            .is_none());
        for ((id, _, _), original) in receipts.iter().zip(&original_audio) {
            let record = db
                .get_courseware_tts_audio(root, &before.project_id, PRINCIPAL, id)
                .unwrap();
            assert_eq!(json!(record), *original);
        }
        db.conn
            .execute_batch("DROP TRIGGER attention_commit_failure")
            .unwrap();
        let committed = db
            .resolve_source_adoption(root, &output, pending["adoptionId"].as_str().unwrap(), true)
            .unwrap();
        let next: CoursewareProject = serde_json::from_value(committed["project"].clone()).unwrap();
        let identity = db
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(root, &before.project_id, &output.sha256).unwrap(),
            )
            .unwrap()
            .unwrap();
        let new_id = identity["pages"][1]["objects"][1]["logicalId"].clone();
        assert_ne!(new_id, old_id);
        let mut expected = before.pages[1].actions.clone();
        expected[0]["visualCues"][0]["effect"]["elementIds"][0] = new_id.clone();
        expected[0]["visualCues"][1]["effect"]["elementId"] = new_id;
        assert_eq!(next.pages[1].actions, expected);
        assert_eq!(next.pages[2].actions, before.pages[2].actions);
        assert_eq!(next.pages[1].review_state, "review");
        assert!(next.pages[2].locked);
        for (id, audio, receipt) in &receipts {
            let record = db
                .get_courseware_tts_audio(root, &before.project_id, PRINCIPAL, id)
                .unwrap();
            assert_eq!(json!(record.audio), json!(audio));
            assert_eq!(record.bound_source.unwrap().sha256, output.sha256);
            assert_eq!(
                db.get_courseware_tts(root, &before.project_id, PRINCIPAL, id)
                    .unwrap()["intent"],
                *receipt
            );
        }
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.get_source_adoption(root, &before.project_id).unwrap(),
            committed
        );
        assert_eq!(
            db.get_source_candidate(root, &before.project_id, &candidate_id)
                .unwrap()["status"],
            "adopted"
        );
    }
}

#[test]
fn candidate_cannot_change_a_preserved_attention_target_or_peer_page() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (mut project, _) = fixture(&db, root);
    add_attention(&db, root, &mut project, 0);
    let prepared = db
        .prepare_source_candidate(
            root,
            &seed('a', false),
            SourceCandidateRequest {
                candidate_id: "changed-attention".into(),
                page_id: project.pages[1].page_id.clone(),
                kind: Kind::PagePptx,
                expected_source_revision: project.source.revision.clone(),
                expected_teaching_revision: project.teaching_revision.clone(),
                style_batch: None,
            },
        )
        .unwrap();
    let mut identity = seed('b', true).identity.unwrap().value().clone();
    identity["pages"][0]["objects"][0]["geometryFingerprint"] = json!("e".repeat(64));
    assert!(db
        .stage_source_candidate_with_proofs(
            root,
            &project.project_id,
            "changed-attention",
            ParsedOutput {
                sha256: "b".repeat(64),
                pages: 3,
                identity: Some(identity),
            },
            (
                None,
                Some(RedoEvidence {
                    protocol: "deckwise-main-redo/1".into(),
                    source_sha256: project.source.sha256.clone(),
                    output_sha256: "b".repeat(64),
                    mapping_revision: prepared["mappingRevision"].as_str().unwrap().into(),
                    page_id: project.pages[1].page_id.clone(),
                    slide_part: "ppt/slides/slide2.xml".into(),
                }),
                None
            )
        )
        .is_err());
    assert_eq!(
        db.get_source_candidate(root, &project.project_id, "changed-attention")
            .unwrap()["status"],
        "preparing"
    );
    assert_eq!(
        json!(db
            .get_courseware_project(root, &project.project_id)
            .unwrap()
            .unwrap()),
        json!(project)
    );
    db.ensure_no_source_adoption(root).unwrap();
}

#[test]
fn invalid_audio_provenance_rejects_before_source_replacement() {
    for case in ["text", "action", "page", "unadopted", "foreign-asset"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (mut project, receipts) = fixture(&db, root);
        match case {
            "text" => project.pages[1].actions[0]["text"] = json!("changed speech"),
            "action" => project.pages[1].actions[0]["id"] = json!("changed-action"),
            "page" => project.pages.swap(0, 1),
            "unadopted" => {
                let mut record = db
                    .get_courseware_tts_audio(root, &project.project_id, PRINCIPAL, &receipts[1].0)
                    .unwrap();
                record.adopted_teaching_revision = None;
                let key = serde_json::to_string(&(
                    storage_key(root, &project.project_id).unwrap(),
                    PRINCIPAL,
                    &receipts[1].0,
                ))
                .unwrap();
                db.kv_set("coursewareTtsAudio.v1", &key, &json!(record))
                    .unwrap();
            }
            "foreign-asset" => {
                project.pages[1].actions[0]["audioAssetId"] =
                    json!(format!("tts-{}", "f".repeat(64)))
            }
            _ => unreachable!(),
        }
        if case == "page" {
            project.pages[0].actions.swap(0, 1);
        } // order mismatch is rejected by the source identity gate.
        db.kv_set(
            NAMESPACE,
            &storage_key(root, &project.project_id).unwrap(),
            &json!(project),
        )
        .unwrap();
        if case == "page" {
            assert!(db
                .prepare_source_candidate(
                    root,
                    &seed('a', false),
                    SourceCandidateRequest {
                        candidate_id: "bad".into(),
                        page_id: project.pages[1].page_id.clone(),
                        kind: Kind::PagePptx,
                        expected_source_revision: project.source.revision.clone(),
                        expected_teaching_revision: project.teaching_revision.clone(),
                        style_batch: None
                    }
                )
                .is_err());
            continue;
        }
        let (_, candidate) = stage(&db, root, &project, false);
        assert!(
            db.prepare_source_adoption(root, &seed('a', false), &candidate)
                .unwrap_err()
                .to_string()
                .starts_with("COURSEWARE_AUDIO_REQUIRED"),
            "{case}"
        );
        assert!(db.get_source_adoption(root, &project.project_id).is_err());
        db.ensure_no_source_adoption(root).unwrap();
        assert_eq!(
            json!(db
                .get_courseware_project(root, &project.project_id)
                .unwrap()
                .unwrap()),
            json!(project)
        );
    }
}

#[test]
fn receipt_or_later_project_failure_rolls_back_rebind_and_keeps_recovery_intent() {
    for namespace in ["coursewareTtsAudio.v1", NAMESPACE] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (project, receipts) = fixture(&db, root);
        let (output, candidate) = stage(&db, root, &project, false);
        let pending = db
            .prepare_source_adoption(root, &seed('a', false), &candidate)
            .unwrap();
        db.conn.execute_batch(&format!("CREATE TRIGGER audio_failure BEFORE UPDATE ON kv WHEN NEW.ns='{namespace}' BEGIN SELECT RAISE(IGNORE); END;")).unwrap();
        assert!(db
            .resolve_source_adoption(root, &output, pending["adoptionId"].as_str().unwrap(), true)
            .is_err());
        for (id, _, _) in receipts {
            assert!(db
                .get_courseware_tts_audio(root, &project.project_id, PRINCIPAL, &id)
                .unwrap()
                .bound_source
                .is_none());
        }
        assert_eq!(
            db.get_source_adoption(root, &project.project_id).unwrap(),
            pending
        );
        assert_eq!(
            json!(db
                .get_courseware_project(root, &project.project_id)
                .unwrap()
                .unwrap()),
            json!(project)
        );
        db.conn.execute_batch("DROP TRIGGER audio_failure").unwrap();
        db.resolve_source_adoption(root, &output, pending["adoptionId"].as_str().unwrap(), true)
            .unwrap();
    }
}
