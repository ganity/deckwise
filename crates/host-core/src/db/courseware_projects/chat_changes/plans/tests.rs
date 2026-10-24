use super::*;

fn project(db: &Database, root: &str) -> CoursewareProject {
    let raw: Value = serde_json::from_slice(include_bytes!(
        "../../../../../../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    ))
    .unwrap();
    let project: CoursewareProject = serde_json::from_value(raw["project"].clone()).unwrap();
    db.create_courseware_project(root, &project).unwrap();
    project
}

fn plan(project: &CoursewareProject) -> Plan {
    Plan {
        tool_call_id: "plan-1".into(),
        page_id: project.pages[0].page_id.clone(),
        page_number: 1,
        edit_generation: 1,
        items: vec![
            PlanItem {
                tool_name: "ppt_add_slide_text".into(),
                label: "Change page text".into(),
            },
            PlanItem {
                tool_name: "ppt_propose_page_narration".into(),
                label: "Also update narration".into(),
            },
        ],
    }
}

fn request<'a>(call: &'a str, name: &'a str, args: &'a Value) -> OperationRequest<'a> {
    OperationRequest {
        session_id: "chat-1",
        turn_id: "turn-1",
        tool_call_id: call,
        tool_name: name,
        args,
    }
}

#[test]
fn declared_chat_plan_survives_partial_failure_and_never_rewrites_legacy_records() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let p = project(&db, root);
    let plan = plan(&p);
    let args = json!({});
    let receipt = db
        .declare_courseware_chat_plan(
            root,
            &p.project_id,
            request("plan-1", "ppt_record_change_plan", &args),
            &plan,
            &p.source.revision,
            &p.teaching_revision,
        )
        .unwrap();
    let before = db.courseware_chat_change_context(root, &p).unwrap();
    assert_eq!(before[0]["plan"]["items"][1]["status"], "not-recorded");
    assert!(before[0]["operations"].as_array().unwrap().is_empty());
    assert!(db
        .prepare_courseware_chat_change(
            root,
            &p.project_id,
            request("plan-1", "ppt_add_slide_text", &args)
        )
        .is_err());
    assert_eq!(
        db.conn
            .query_row("SELECT count(*) FROM kv WHERE ns=?1", [CHANGES], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
    assert!(db
        .declare_courseware_chat_plan(
            root,
            &p.project_id,
            request("plan-1", "ppt_record_change_plan", &args),
            &plan,
            &p.source.revision,
            &p.teaching_revision
        )
        .is_err());
    let native = db
        .prepare_courseware_chat_change(
            root,
            &p.project_id,
            request("native-1", "ppt_add_slide_text", &args),
        )
        .unwrap();
    db.finish_courseware_chat_change(
        &native,
        json!({"state":"acknowledged","saved":false,"page":1}),
    )
    .unwrap();
    let current = db.courseware_chat_change_context(root, &p).unwrap();
    assert_eq!(current[0]["changeGroupId"], receipt["changeGroupId"]);
    assert_eq!(current[0]["plan"]["items"][0]["status"], "native-unsaved");
    assert_eq!(current[0]["plan"]["items"][1]["status"], "not-recorded");
    let args = json!({"baseline":{"pageId":plan.page_id}});
    let narration = db
        .prepare_courseware_chat_change(
            root,
            &p.project_id,
            request("narration-1", "ppt_propose_page_narration", &args),
        )
        .unwrap();
    db.finish_courseware_chat_change(
        &narration,
        json!({"state":"uncertain","saved":false,"errorCode":"TOOL_ABORTED"}),
    )
    .unwrap();
    let before_restart = db.courseware_chat_change_context(root, &p).unwrap();
    assert_eq!(before_restart[0]["plan"]["items"][1]["status"], "unknown");
    assert_eq!(
        json!(db
            .get_courseware_project(root, &p.project_id)
            .unwrap()
            .unwrap()),
        json!(p)
    );
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(
        db.courseware_chat_change_context(root, &p).unwrap(),
        before_restart
    );
}

#[test]
fn declared_chat_plan_checks_baseline_scope_and_atomic_persistence() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let p = project(&db, root);
    let base = plan(&p);
    let args = json!({});
    for case in ["unknown-tool", "empty", "label", "too-many"] {
        let mut plan = base.clone();
        match case {
            "unknown-tool" => plan.items[0].tool_name = "ppt_execute_js".into(),
            "empty" => plan.items.clear(),
            "label" => plan.items[0].label = "x".repeat(201),
            _ => plan.items = vec![plan.items[0].clone(); 21],
        }
        assert!(db
            .declare_courseware_chat_plan(
                root,
                &p.project_id,
                request("plan-1", "ppt_record_change_plan", &args),
                &plan,
                &p.source.revision,
                &p.teaching_revision
            )
            .is_err());
    }
    assert!(db
        .declare_courseware_chat_plan(
            root,
            &p.project_id,
            request("plan-1", "ppt_record_change_plan", &args),
            &base,
            "stale",
            &p.teaching_revision
        )
        .is_err());
    let mut invalid = base.clone();
    invalid.page_id = p.pages[1].page_id.clone();
    assert!(db
        .declare_courseware_chat_plan(
            root,
            &p.project_id,
            request("plan-1", "ppt_record_change_plan", &args),
            &invalid,
            &p.source.revision,
            &p.teaching_revision
        )
        .is_err());
    db.conn.execute_batch("CREATE TRIGGER fail_plan BEFORE INSERT ON kv WHEN NEW.ns='coursewareChatPlannedChanges.v1' BEGIN SELECT RAISE(ABORT,'fixture plan failure'); END;").unwrap();
    assert!(db
        .declare_courseware_chat_plan(
            root,
            &p.project_id,
            request("plan-1", "ppt_record_change_plan", &args),
            &base,
            &p.source.revision,
            &p.teaching_revision
        )
        .is_err());
    assert!(db
        .courseware_chat_change_context(root, &p)
        .unwrap()
        .is_empty());
    db.conn.execute_batch("DROP TRIGGER fail_plan;").unwrap();
    let pending = db
        .prepare_courseware_chat_change(
            root,
            &p.project_id,
            request("native", "ppt_add_slide_text", &args),
        )
        .unwrap();
    assert!(db
        .declare_courseware_chat_plan(
            root,
            &p.project_id,
            request("plan-1", "ppt_record_change_plan", &args),
            &base,
            &p.source.revision,
            &p.teaching_revision
        )
        .is_err());
    db.finish_courseware_chat_change(
        &pending,
        json!({"state":"acknowledged","page":2,"saved":false}),
    )
    .unwrap();
    assert!(db.courseware_chat_change_context(root, &p).unwrap()[0]
        .get("plan")
        .is_none());
}

#[test]
fn declared_chat_plan_does_not_count_other_pages_or_one_execution_twice() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let p = project(&db, root);
    let mut plan = plan(&p);
    plan.items[1] = plan.items[0].clone();
    let args = json!({});
    db.declare_courseware_chat_plan(
        root,
        &p.project_id,
        request("plan-1", "ppt_record_change_plan", &args),
        &plan,
        &p.source.revision,
        &p.teaching_revision,
    )
    .unwrap();
    for (id, page) in [("foreign-page", 2), ("current-page", 1)] {
        let pending = db
            .prepare_courseware_chat_change(
                root,
                &p.project_id,
                request(id, "ppt_add_slide_text", &args),
            )
            .unwrap();
        db.finish_courseware_chat_change(
            &pending,
            json!({"state":"acknowledged","page":page,"saved":false}),
        )
        .unwrap();
    }
    let view = db.courseware_chat_change_context(root, &p).unwrap();
    let items = &view[0]["plan"]["items"];
    assert_eq!(items[0]["toolCallId"], "current-page");
    assert_eq!(items[1]["status"], "not-recorded");
}

#[test]
fn declared_chat_plan_tracks_real_narration_proposal_and_explicit_adoption() {
    use crate::courseware::SavedProjectSeed;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_str().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let p = project(&db, root);
    let mut plan = plan(&p);
    plan.items.remove(0);
    let args = json!({});
    db.declare_courseware_chat_plan(
        root,
        &p.project_id,
        request("plan-1", "ppt_record_change_plan", &args),
        &plan,
        &p.source.revision,
        &p.teaching_revision,
    )
    .unwrap();
    let raw: Value = serde_json::from_slice(include_bytes!(
        "../../candidates/fixtures/b2-narration.json"
    ))
    .unwrap();
    let write: TeachingWrite = serde_json::from_value(raw["write"].clone()).unwrap();
    let seed = SavedProjectSeed {
        project_id: p.project_id.clone(),
        sha256: p.source.sha256.clone(),
        pages: p.pages.len(),
        identity: None,
    };
    let args = json!({"baseline":{"pageId":plan.page_id}});
    let pending = db
        .prepare_courseware_chat_change(
            root,
            &p.project_id,
            request("narration", "ppt_propose_page_narration", &args),
        )
        .unwrap();
    db.stage_narration_candidate(root, &seed, "narration-1", &write)
        .unwrap();
    db.finish_courseware_chat_change(
        &pending,
        json!({"state":"acknowledged","saved":false,"candidateId":"narration-1"}),
    )
    .unwrap();
    assert_eq!(
        db.courseware_chat_change_context(root, &p).unwrap()[0]["plan"]["items"][0]["status"],
        "needs-review"
    );
    let adopted = db
        .adopt_narration_candidate(root, &seed, "narration-1")
        .unwrap();
    assert_eq!(
        db.courseware_chat_change_context(root, &adopted).unwrap()[0]["plan"]["items"][0]["status"],
        "adopted"
    );
}
