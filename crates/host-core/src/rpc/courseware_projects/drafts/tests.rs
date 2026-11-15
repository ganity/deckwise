use super::*;

#[tokio::test]
async fn old_source_draft_follows_verified_identity_recovery_and_obsolete_saved_draft_is_retired() {
    let dir = tempfile::tempdir().unwrap();
    let state = Arc::new(Mutex::new(AppState::open(dir.path()).unwrap()));
    let root = dir
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let (session, project, seed) = {
        let s = state.lock().await;
        let session =
            sessions::create_session(&s.db, None, None, None, None, Some(root.clone())).unwrap();
        let mut raw: Value = serde_json::from_slice(include_bytes!(
            "../../../courseware/identity/fixtures/identity.json"
        ))
        .unwrap();
        for (i, object) in raw["pages"][0]["objects"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            object["sourceObjectName"] = json!(format!("object-{i}"));
        }
        let seed = crate::courseware::SavedProjectSeed {
            project_id: "office-draft".into(),
            sha256: raw["sourceSha256"].as_str().unwrap().into(),
            pages: 1,
            identity: Some(
                crate::courseware::identity::SavedSourceIdentity::parse(
                    &serde_json::to_vec(&raw).unwrap(),
                )
                .unwrap(),
            ),
        };
        let project =
            s.db.open_identified_courseware_project(&root, &seed)
                .unwrap();
        (session, project, seed)
    };
    let args = json!({"sessionId":session.id, "projectId":project.project_id, "pageId":project.pages[0].page_id});
    let mut set = args.clone();
    set["expectedRevision"] = Value::Null;
    set["draft"] = json!({"baseline":project, "actions":[{"id":"speech", "type":"speech", "text":"Keep my edit"}], "instruction":""});
    handle(state.clone(), "courseware.teachingDraft.set", set)
        .await
        .unwrap();
    let next = {
        let s = state.lock().await;
        let mut raw = seed.identity.unwrap().value().clone();
        raw["sourceSha256"] = json!("b".repeat(64));
        let updated = crate::courseware::SavedProjectSeed {
            sha256: "b".repeat(64),
            identity: Some(
                crate::courseware::identity::SavedSourceIdentity::parse(
                    &serde_json::to_vec(&raw).unwrap(),
                )
                .unwrap(),
            ),
            ..seed
        };
        s.db.open_identified_courseware_project(&root, &updated)
            .unwrap()
    };
    let recovered = handle(state.clone(), "courseware.teachingDraft.get", args.clone())
        .await
        .unwrap();
    assert_eq!(
        recovered["draft"]["baseline"],
        serde_json::to_value(&next).unwrap()
    );
    assert_eq!(recovered["draft"]["actions"][0]["text"], "Keep my edit");
    {
        let s = state.lock().await;
        s.db.write_courseware_teaching(
            &root,
            &crate::db::courseware_projects::TeachingWrite {
                project_id: next.project_id,
                page_id: next.pages[0].page_id.clone(),
                expected_source_revision: next.source.revision,
                expected_teaching_revision: next.teaching_revision,
                actions: serde_json::from_value(recovered["draft"]["actions"].clone()).unwrap(),
            },
        )
        .unwrap();
    }
    let saved = handle(state.clone(), "courseware.teachingDraft.get", args)
        .await
        .unwrap();
    assert_eq!(saved["draft"], Value::Null);
}
