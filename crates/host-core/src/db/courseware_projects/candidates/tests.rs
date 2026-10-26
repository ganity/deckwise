use super::*;
use serde_json::json;

fn fixture() -> (CoursewareProject, SavedProjectSeed, TeachingWrite) {
    let accepted: Value = serde_json::from_slice(include_bytes!(
        "../../../../../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    ))
    .unwrap();
    let project: CoursewareProject = serde_json::from_value(accepted["project"].clone()).unwrap();
    let seed = SavedProjectSeed {
        project_id: project.project_id.clone(),
        sha256: project.source.sha256.clone(),
        pages: project.pages.len(),
        identity: None,
    };
    let producer: Value =
        serde_json::from_slice(include_bytes!("fixtures/b2-narration.json")).unwrap();
    let write = serde_json::from_value(producer["write"].clone()).unwrap();
    (project, seed, write)
}

fn value(project: &CoursewareProject) -> Value {
    serde_json::to_value(project).unwrap()
}

#[test]
fn generated_narration_saves_and_regenerates_without_candidates_and_survives_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("direct.sqlite");
    let db = Database::open(&path).unwrap();
    let (project, seed, write) = fixture();
    db.create_courseware_project(root, &project).unwrap();
    let saved = db
        .save_generated_narration(root, &seed, &project, &write)
        .unwrap();
    assert_eq!(saved.pages[0].actions, write.actions);
    assert_eq!(value(&saved)["pages"][1], value(&project)["pages"][1]);
    assert!(db
        .save_generated_narration(root, &seed, &project, &write)
        .is_err());
    let mut next = write.clone();
    next.expected_teaching_revision = saved.teaching_revision.clone();
    next.actions[0]["text"] = json!("Regenerated narration");
    let regenerated = db
        .save_generated_narration(root, &seed, &saved, &next)
        .unwrap();
    assert_eq!(regenerated.pages[0].actions, next.actions);
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM kv WHERE ns=?1", [CANDIDATES], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM kv WHERE ns=?1",
                [HISTORY_NAMESPACE],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        2
    );
    drop(db);
    assert_eq!(
        value(
            &Database::open(&path)
                .unwrap()
                .get_courseware_project(root, &seed.project_id)
                .unwrap()
                .unwrap()
        ),
        value(&regenerated)
    );
}

#[test]
fn direct_narration_preserves_current_teaching_when_validation_or_history_write_fails() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&dir.path().join("direct.sqlite")).unwrap();
    let (project, seed, write) = fixture();
    db.create_courseware_project(root, &project).unwrap();
    let mut forged = project.clone();
    forged.title.push_str(" changed");
    assert!(db
        .save_generated_narration(root, &seed, &forged, &write)
        .is_err());
    let mut unsupported = write.clone();
    unsupported.actions[0]["audioAssetId"] = json!("unverified");
    assert!(db
        .save_generated_narration(root, &seed, &project, &unsupported)
        .is_err());
    let mut mismatch = write.clone();
    mismatch.expected_teaching_revision = "wrong".into();
    assert!(db
        .save_generated_narration(root, &seed, &project, &mismatch)
        .is_err());
    let mut locked = project.clone();
    locked.pages[0].locked = true;
    db.conn
        .execute(
            "UPDATE kv SET value_json=?1 WHERE ns=?2",
            params![serde_json::to_string(&locked).unwrap(), NAMESPACE],
        )
        .unwrap();
    assert!(db
        .save_generated_narration(root, &seed, &locked, &write)
        .is_err());
    db.conn
        .execute(
            "UPDATE kv SET value_json=?1 WHERE ns=?2",
            params![serde_json::to_string(&project).unwrap(), NAMESPACE],
        )
        .unwrap();
    db.conn.execute_batch("CREATE TRIGGER fail_history BEFORE INSERT ON kv WHEN NEW.ns='coursewareHistory.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(db
        .save_generated_narration(root, &seed, &project, &write)
        .is_err());
    db.conn.execute_batch("DROP TRIGGER fail_history").unwrap();
    db.conn.execute_batch("CREATE TRIGGER fail_teaching BEFORE UPDATE ON kv WHEN NEW.ns='coursewareProjects.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(db
        .save_generated_narration(root, &seed, &project, &write)
        .is_err());
    assert_eq!(
        db.conn
            .query_row(
                "SELECT count(*) FROM kv WHERE ns=?1",
                [HISTORY_NAMESPACE],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        value(
            &db.get_courseware_project(root, &seed.project_id)
                .unwrap()
                .unwrap()
        ),
        value(&project)
    );
}

#[test]
fn b2_proposal_survives_restart_and_only_explicit_adoption_changes_teaching() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let (project, seed, write) = fixture();
    let path = dir.path().join("pi.sqlite");
    let receipt;
    {
        let db = Database::open(&path).unwrap();
        db.create_courseware_project(root, &project).unwrap();
        receipt = db
            .stage_narration_candidate(root, &seed, "candidate-1", &write)
            .unwrap();
        assert_eq!(receipt["status"], "needs-review");
        assert_eq!(receipt["audioReady"], false);
        assert_eq!(
            db.stage_narration_candidate(root, &seed, "candidate-1", &write)
                .unwrap(),
            receipt
        );
        assert_eq!(
            value(
                &db.get_courseware_project(root, &seed.project_id)
                    .unwrap()
                    .unwrap()
            ),
            value(&project)
        );
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.get_narration_candidate(root, &seed.project_id, "candidate-1")
            .unwrap(),
        receipt
    );
    let next = db
        .adopt_narration_candidate(root, &seed, "candidate-1")
        .unwrap();
    assert_eq!(next.pages[0].actions, write.actions);
    assert_eq!(next.pages[0].review_state, "review");
    assert_eq!(value(&next)["pages"][1], value(&project)["pages"][1]);
    assert_eq!(value(&next)["source"], value(&project)["source"]);
    assert_eq!(
        value(&next)["educationContext"],
        value(&project)["educationContext"]
    );
    assert_eq!(next.pages[0].page_id, project.pages[0].page_id);
    assert_ne!(next.teaching_revision, project.teaching_revision);
    assert_eq!(
        db.get_narration_candidate(root, &seed.project_id, "candidate-1")
            .unwrap()["status"],
        "adopted"
    );
    assert!(db
        .adopt_narration_candidate(root, &seed, "candidate-1")
        .is_err());
    assert!(db
        .reject_narration_candidate(root, &seed.project_id, "candidate-1")
        .is_err());
    let archived: String = db
        .conn
        .query_row(
            "SELECT value_json FROM kv WHERE ns=?1",
            [HISTORY_NAMESPACE],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&archived).unwrap(),
        value(&project)
    );
    drop(db);
    assert_eq!(
        value(
            &Database::open(&path)
                .unwrap()
                .get_courseware_project(root, &seed.project_id)
                .unwrap()
                .unwrap()
        ),
        value(&next)
    );
}

#[test]
fn source_teaching_locks_policy_and_workspace_fence_pending_candidates() {
    for change in ["source", "teaching", "lock", "policy", "workspace"] {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        let (project, mut seed, write) = fixture();
        db.create_courseware_project(root, &project).unwrap();
        db.stage_narration_candidate(root, &seed, "candidate-1", &write)
            .unwrap();
        if change == "source" {
            seed.sha256 = "b".repeat(64);
        }
        if change == "teaching" {
            db.write_courseware_teaching(root, &write).unwrap();
        }
        if change == "lock" {
            db.set_courseware_page_lock(
                root,
                &seed.project_id,
                &write.page_id,
                &write.expected_source_revision,
                &write.expected_teaching_revision,
                true,
            )
            .unwrap();
        }
        if change == "policy" {
            let mut changed = project.clone();
            changed.education_context.as_mut().unwrap().grade = Some("different".into());
            db.kv_set(
                NAMESPACE,
                &storage_key(root, &seed.project_id).unwrap(),
                &value(&changed),
            )
            .unwrap();
        }
        let before = value(
            &db.get_courseware_project(root, &seed.project_id)
                .unwrap()
                .unwrap(),
        );
        let target = if change == "workspace" {
            "/another/workspace"
        } else {
            root
        };
        assert!(
            db.adopt_narration_candidate(target, &seed, "candidate-1")
                .is_err(),
            "{change}"
        );
        assert_eq!(
            value(
                &db.get_courseware_project(root, &seed.project_id)
                    .unwrap()
                    .unwrap()
            ),
            before
        );
        assert_eq!(
            db.get_narration_candidate(root, &seed.project_id, "candidate-1")
                .unwrap()["status"],
            "needs-review"
        );
        assert!(db
            .get_narration_candidate("/another/workspace", &seed.project_id, "candidate-1")
            .is_err());
        assert!(db
            .reject_narration_candidate("/another/workspace", &seed.project_id, "candidate-1")
            .is_err());
    }
}

#[test]
fn rejection_is_idempotent_and_neither_regenerates_nor_applies_a_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (project, seed, mut write) = fixture();
    db.create_courseware_project(root, &project).unwrap();
    db.stage_narration_candidate(root, &seed, "candidate-1", &write)
        .unwrap();
    write.actions[0]["text"] = json!("Different proposal");
    assert!(db
        .stage_narration_candidate(root, &seed, "candidate-1", &write)
        .is_err());
    let rejected = db
        .reject_narration_candidate(root, &seed.project_id, "candidate-1")
        .unwrap();
    assert_eq!(rejected["status"], "rejected");
    assert_eq!(
        db.reject_narration_candidate(root, &seed.project_id, "candidate-1")
            .unwrap(),
        rejected
    );
    let (_, _, original) = fixture();
    assert_eq!(
        db.stage_narration_candidate(root, &seed, "candidate-1", &original)
            .unwrap(),
        rejected
    );
    assert!(db
        .adopt_narration_candidate(root, &seed, "candidate-1")
        .is_err());
    assert_eq!(
        value(
            &db.get_courseware_project(root, &seed.project_id)
                .unwrap()
                .unwrap()
        ),
        value(&project)
    );
}

#[test]
fn invalid_or_unsupported_target_data_never_stages_or_discards_actions() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (project, seed, write) = fixture();
    db.create_courseware_project(root, &project).unwrap();
    for action in [
        json!({"id":"x","type":"speech","text":"a","audioAssetId":"asset"}),
        json!({"id":"x","type":"highlight"}),
        json!({"id":"x","type":"speech","text":"a","pauseAfterMs":-1}),
        json!({"id":"x","type":"speech","text":"a","pauseAfterMs":0.5}),
        json!({"id":"x","type":"speech","text":"a","pauseAfterMs":30001}),
        json!({"id":"x","type":"speech","text":"a".repeat(32001)}),
    ] {
        let mut invalid = write.clone();
        invalid.actions = vec![action];
        assert!(db
            .stage_narration_candidate(root, &seed, "invalid", &invalid)
            .is_err());
    }
    let mut invalid = write.clone();
    invalid.page_id = project.pages[1].page_id.clone();
    assert!(db
        .stage_narration_candidate(root, &seed, "locked", &invalid)
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_LOCKED"));
    let mut oversized = write.clone();
    oversized.actions = (0..70)
        .map(|i| json!({"id":format!("speech-{i}"),"type":"speech","text":"a".repeat(32000)}))
        .collect();
    assert!(db
        .stage_narration_candidate(root, &seed, "oversized", &oversized)
        .is_err());
    let mut effects = write.clone();
    effects.actions[0]["visualCues"] = json!([]);
    db.write_courseware_teaching(root, &effects).unwrap();
    let current = db
        .get_courseware_project(root, &seed.project_id)
        .unwrap()
        .unwrap();
    let mut valid = write;
    valid.expected_teaching_revision = current.teaching_revision.clone();
    assert!(db
        .stage_narration_candidate(root, &seed, "unsafe-replacement", &valid)
        .is_err());
    assert_eq!(
        value(
            &db.get_courseware_project(root, &seed.project_id)
                .unwrap()
                .unwrap()
        ),
        value(&current)
    );
    let count: i64 = db
        .conn
        .query_row("SELECT COUNT(*) FROM kv WHERE ns=?1", [CANDIDATES], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn stages_and_adopts_only_the_bounded_teacher_continue_checkpoint_shape() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (project, seed, mut write) = fixture();
    db.create_courseware_project(root, &project).unwrap();
    write.actions = vec![
        json!({"id":"continue-1","type":"interaction_checkpoint","checkpointId":"continue-1","checkpointKind":"teacher_continue"}),
    ];
    let staged = db
        .stage_narration_candidate(root, &seed, "teacher-wait", &write)
        .unwrap();
    assert_eq!(staged["status"], "needs-review");
    let adopted = db
        .adopt_narration_candidate(root, &seed, "teacher-wait")
        .unwrap();
    assert_eq!(adopted.pages[0].actions, write.actions);
    let mut invalid = write;
    invalid.expected_teaching_revision = adopted.teaching_revision;
    invalid.actions = vec![
        json!({"id":"continue-2","type":"interaction_checkpoint","checkpointId":"continue-2","checkpointKind":"teacher_continue","question":"extra"}),
    ];
    assert!(db
        .stage_narration_candidate(root, &seed, "bad-teacher-wait", &invalid)
        .is_err());
}

#[test]
fn candidate_status_failure_rolls_back_project_and_history_together() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let (project, seed, write) = fixture();
    db.create_courseware_project(root, &project).unwrap();
    let pending = db
        .stage_narration_candidate(root, &seed, "candidate-1", &write)
        .unwrap();
    db.conn.execute_batch("CREATE TRIGGER candidate_failure BEFORE UPDATE ON kv WHEN NEW.ns='coursewareNarrationCandidates.v1' BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(db
        .adopt_narration_candidate(root, &seed, "candidate-1")
        .is_err());
    assert_eq!(
        value(
            &db.get_courseware_project(root, &seed.project_id)
                .unwrap()
                .unwrap()
        ),
        value(&project)
    );
    assert_eq!(
        db.get_narration_candidate(root, &seed.project_id, "candidate-1")
            .unwrap(),
        pending
    );
    let count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM kv WHERE ns=?1",
            [HISTORY_NAMESPACE],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    db.conn
        .execute_batch("DROP TRIGGER candidate_failure")
        .unwrap();
    db.conn.execute_batch("CREATE TRIGGER candidate_ignore BEFORE UPDATE ON kv WHEN NEW.ns='coursewareNarrationCandidates.v1' BEGIN SELECT RAISE(IGNORE); END;").unwrap();
    assert!(db
        .adopt_narration_candidate(root, &seed, "candidate-1")
        .unwrap_err()
        .to_string()
        .starts_with("COURSEWARE_CONFLICT"));
    assert_eq!(
        value(
            &db.get_courseware_project(root, &seed.project_id)
                .unwrap()
                .unwrap()
        ),
        value(&project)
    );
    let count: i64 = db
        .conn
        .query_row(
            "SELECT COUNT(*) FROM kv WHERE ns=?1",
            [HISTORY_NAMESPACE],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(
        db.get_narration_candidate(root, &seed.project_id, "candidate-1")
            .unwrap(),
        pending
    );
    db.conn
        .execute_batch("DROP TRIGGER candidate_ignore")
        .unwrap();
    db.adopt_narration_candidate(root, &seed, "candidate-1")
        .unwrap();
}

#[test]
fn saved_page_candidates_survive_peer_narration_adoption_but_reject_target_edits() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&dir.path().join("db.sqlite")).unwrap();
    let (mut project, seed, first) = fixture();
    project.pages[1].locked = false;
    project.pages[1].actions.clear();
    db.create_courseware_project(root, &project).unwrap();
    let mut second = first.clone();
    second.page_id = project.pages[1].page_id.clone();
    db.stage_scoped_narration_candidate(root, &seed, "saved-first", &first, true)
        .unwrap();
    db.stage_scoped_narration_candidate(root, &seed, "saved-second", &second, true)
        .unwrap();
    let adopted = db
        .adopt_narration_candidate(root, &seed, "saved-first")
        .unwrap();
    assert_eq!(
        db.get_narration_candidate(root, &seed.project_id, "saved-second")
            .unwrap()["stale"],
        false
    );
    let final_project = db
        .adopt_narration_candidate(root, &seed, "saved-second")
        .unwrap();
    assert_eq!(final_project.pages[0].actions, adopted.pages[0].actions);
    assert_eq!(final_project.pages[1].actions, second.actions);
    let mut third = second.clone();
    third.expected_teaching_revision = final_project.teaching_revision.clone();
    db.stage_scoped_narration_candidate(root, &seed, "saved-target", &third, true)
        .unwrap();
    third.actions = vec![];
    db.write_courseware_teaching(root, &third).unwrap();
    assert_eq!(
        db.get_narration_candidate(root, &seed.project_id, "saved-target")
            .unwrap()["stale"],
        true
    );
    assert!(db
        .adopt_narration_candidate(root, &seed, "saved-target")
        .is_err());
}

#[test]
fn direct_narration_drops_old_speech_audio_and_effects_but_preserves_music() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open(&dir.path().join("direct.sqlite")).unwrap();
    let (mut project, seed, write) = fixture();
    project.pages[0].actions = vec![
        json!({"id":"old", "type":"speech", "text":"Previous explanation", "audioAssetId":format!("tts-{}", "a".repeat(64)), "visualCues":[{"id":"old-focus","atMs":0,"endMs":1000,"effect":{"type":"highlight","elementIds":["old-object"]}}]}),
        json!({"id":"music", "type":"audio_clip", "audioAssetId":format!("music-{}", "b".repeat(64))}),
    ];
    db.create_courseware_project(root, &project).unwrap();
    let saved = db
        .save_generated_narration(root, &seed, &project, &write)
        .unwrap();
    assert_eq!(
        saved.pages[0]
            .actions
            .iter()
            .find(|action| action["type"] == "audio_clip"),
        Some(&project.pages[0].actions[1])
    );
    assert!(saved.pages[0]
        .actions
        .iter()
        .filter(|action| action["type"] == "speech")
        .all(|action| action.get("audioAssetId").is_none() && action.get("visualCues").is_none()));
}
