use super::*;
use crate::courseware::SavedProjectSeed;
use serde_json::json;

#[test]
fn portable_media_reuse_is_page_action_text_and_source_bound_without_provider_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().to_str().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    let seed = SavedProjectSeed {
        project_id: "office-portable-media".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity),
    };
    let project = db
        .open_identified_courseware_project(workspace, &seed)
        .unwrap();
    let mut content = db
        .portable_courseware_content(
            workspace,
            &seed,
            &project.source.revision,
            &project.teaching_revision,
        )
        .unwrap();
    for (prefix, mime, hash) in [
        ("tts", "audio/wav", "a".repeat(64)),
        ("music", "audio/mpeg", "b".repeat(64)),
        ("video", "video/mp4", "c".repeat(64)),
    ] {
        content.media.push(Media {
            id: format!("{prefix}-{hash}"),
            path: format!("media/{hash}.bin"),
            sha256: hash,
            mime_type: mime.into(),
            byte_length: 100,
            duration_ms: 1000,
        });
    }
    content.project.pages[0].actions = vec![
        json!({"id":"speech", "type":"speech", "text":"Hello!", "audioAssetId":content.media[0].id}),
        json!({"id":"music", "type":"audio_clip", "audioAssetId":content.media[1].id}),
        json!({"id":"video", "type":"video_clip", "videoAssetId":content.media[2].id}),
    ];
    let mut repeated = content.clone();
    let target = repeated.identity["pages"][0]["objects"][0]["logicalId"].clone();
    repeated.project.pages[0].actions[0]["visualCues"] = json!([{
        "id":"entrance", "atMs":0, "endMs":600,
        "effect":{"type":"element_animation","elementId":target,"effect":"fadeIn"}
    }]);
    repeated.project.pages[0].actions.push(json!({
        "id":"speech-again", "type":"speech", "text":"Hello again!", "audioAssetId":repeated.media[0].id,
        "visualCues":[{"id":"pulse-again", "atMs":0, "endMs":600,
            "effect":{"type":"element_animation","elementId":target,"effect":"pulse"}}]
    }));
    repeated.validate(repeated.commit_id, &seed.sha256).unwrap();
    repeated.project.pages[0].actions.last_mut().unwrap()["visualCues"][0]["effect"]["effect"] =
        json!("fadeIn");
    assert!(repeated.validate(repeated.commit_id, &seed.sha256).is_err());
    let fresh = tempfile::tempdir().unwrap();
    let restored_db = Database::open_in_dir(fresh.path()).unwrap();
    let root = fresh.path().to_str().unwrap();
    let mut project = restored_db
        .restore_portable_courseware_content(root, &seed, &content)
        .unwrap();
    let page = project.pages[0].page_id.clone();
    for (action, asset) in ["speech", "music", "video"].into_iter().zip(&content.media) {
        assert_eq!(
            serde_json::to_value(
                restored_db
                    .portable_courseware_media(root, &project.project_id, &page, action)
                    .unwrap()
                    .unwrap()
            )
            .unwrap(),
            serde_json::to_value(asset).unwrap()
        );
        assert!(restored_db
            .portable_courseware_media(root, &project.project_id, "other-page", action)
            .unwrap()
            .is_none());
    }
    {
        let _tx = restored_db.conn.unchecked_transaction().unwrap();
        let mut next = project.clone();
        next.source.sha256 = "f".repeat(64);
        next.source.revision = next.source.sha256.clone();
        restored_db
            .rebind_courseware_review_audio(root, &project, &next)
            .unwrap();
        restored_db
            .validate_courseware_review_audio(root, &project, &next)
            .unwrap();
        next.pages[0].actions[0]["text"] = json!("Different sentence with an old media reference");
        assert!(restored_db
            .rebind_courseware_review_audio(root, &project, &next)
            .is_err());
        assert!(restored_db
            .validate_courseware_review_audio(root, &project, &next)
            .is_err());
        next = project.clone();
        next.pages[0].actions[1]["audioAssetId"] = json!(format!("music-{}", "e".repeat(64)));
        assert!(restored_db
            .rebind_courseware_review_audio(root, &project, &next)
            .is_err());
    }
    project.pages[0].actions[0]["text"] = json!("Different speech");
    project.pages[0].actions[1]["audioAssetId"] = json!(format!("music-{}", "d".repeat(64)));
    restored_db
        .kv_set(
            NAMESPACE,
            &storage_key(root, &project.project_id).unwrap(),
            &serde_json::to_value(&project).unwrap(),
        )
        .unwrap();
    assert!(restored_db
        .portable_courseware_media(root, &project.project_id, &page, "speech")
        .unwrap()
        .is_none());
    assert!(restored_db
        .portable_courseware_media(root, &project.project_id, &page, "music")
        .unwrap()
        .is_none());
    assert!(restored_db
        .portable_courseware_media(root, &project.project_id, &page, "video")
        .unwrap()
        .is_some());
    project.source.sha256 = "d".repeat(64);
    restored_db
        .kv_set(
            NAMESPACE,
            &storage_key(root, &project.project_id).unwrap(),
            &serde_json::to_value(&project).unwrap(),
        )
        .unwrap();
    assert!(restored_db
        .portable_courseware_media(root, &project.project_id, &page, "video")
        .is_err());

    let mut mismatch = content.clone();
    mismatch.project_uuid = uuid::Uuid::new_v4();
    mismatch.identity["pages"][0]["objects"][0]["geometryFingerprint"] = json!("f".repeat(64));
    assert!(restored_db
        .restore_portable_courseware_content(root, &seed, &mismatch)
        .is_err());
    assert!(restored_db
        .get_courseware_project(root, &format!("portable-{}", mismatch.project_uuid))
        .unwrap()
        .is_none());
}

#[test]
fn database_copy_preserves_scene_semantics_image_locks_and_their_identity_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().to_str().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let identity = SavedSourceIdentity::parse(include_bytes!(
        "../../../courseware/identity/fixtures/identity.json"
    ))
    .unwrap();
    let seed = SavedProjectSeed {
        project_id: "office-copy-metadata".into(),
        sha256: identity.value()["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(identity.clone()),
    };
    let project = db
        .open_identified_courseware_project_with_metadata(root, &seed, "scene", None)
        .unwrap();
    let mapping = json!({"pages":[{"slideId":"scene-001", "sourceHash":format!("sha256:{}", "a".repeat(64)),
        "slidePart":"ppt/slides/slide1.xml", "elements":identity.value()["pages"][0]["objects"].as_array().unwrap().iter().enumerate().map(|(i,o)| json!({
            "elementId":format!("Object {i}"), "objectName":format!("Object {i}"), "sourceShapeId":o["sourceShapeId"],
            "type":if o["type"] == "image" {"image_layer"} else {"native_shape"},
            "semanticRole":"classroom character", "spokenAliases":["Monkey"], "regenerationPrompt":"A waving monkey"
        })).collect::<Vec<_>>() }]});
    db.initialize_generated_scene_objects(
        root,
        &project,
        &serde_json::from_value(mapping.clone()).unwrap(),
    )
    .unwrap();
    let context = db
        .courseware_project_context(root, &project.project_id)
        .unwrap();
    let object = &context["savedObjects"]["pages"][0]["objects"][3];
    let copied = db
        .portable_courseware_content(
            root,
            &seed,
            &project.source.revision,
            &project.teaching_revision,
        )
        .unwrap();
    let proof = &copied.identity["pages"][0]["objects"][3];
    let locks = json!({"revision":"locks-1", "images":[{
        "pageId":project.pages[0].page_id, "objectId":object["objectId"], "sourceSha256":project.source.sha256,
        "mappingRevision":copied.identity["mappingRevision"], "contentFingerprint":proof["contentFingerprint"], "geometryFingerprint":proof["geometryFingerprint"],
        "image":{"sourceShapeId":proof["sourceShapeId"], "assetSha256":"a".repeat(64), "pictureSha256":"b".repeat(64), "zIndex":3}
    }]});
    db.kv_set(
        "coursewareAssetLocks.v1",
        &storage_key(root, &project.project_id).unwrap(),
        &locks,
    )
    .unwrap();
    let content = db
        .portable_courseware_content(
            root,
            &seed,
            &project.source.revision,
            &project.teaching_revision,
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(content.asset_locks.as_ref().unwrap()).unwrap(),
        locks
    );
    assert_eq!(
        serde_json::to_value(&content.scene_objects.as_ref().unwrap().mapping).unwrap(),
        mapping
    );
    assert_eq!(
        db.get_courseware_project(root, &project.project_id)
            .unwrap()
            .unwrap()
            .teaching_revision,
        project.teaching_revision
    );
    let value = serde_json::to_value(&content).unwrap();
    let reopened = Teaching::parse(
        &serde_json::to_vec(&value).unwrap(),
        content.commit_id,
        &seed.sha256,
    )
    .unwrap();
    assert_eq!(serde_json::to_value(reopened).unwrap(), value);
    for (pointer, bad) in [
        ("/assetLocks/images/0/image/sourceShapeId", json!("wrong")),
        ("/assetLocks/images/0/mappingRevision", json!("stale")),
        (
            "/sceneObjects/mapping/pages/0/elements/0/sourceShapeId",
            json!("123"),
        ),
        (
            "/sceneObjects/originalIdentity/diagnostics",
            json!([{"code":"private", "message":"/private/path"}]),
        ),
    ] {
        let mut changed = value.clone();
        *changed.pointer_mut(pointer).unwrap() = bad;
        assert!(
            Teaching::parse(
                &serde_json::to_vec(&changed).unwrap(),
                content.commit_id,
                &seed.sha256
            )
            .is_err(),
            "{pointer}"
        );
    }

    let fresh = tempfile::tempdir().unwrap();
    let restored_db = Database::open_in_dir(fresh.path()).unwrap();
    let workspace = fresh.path().to_str().unwrap();
    let restored = restored_db
        .restore_portable_courseware_content(workspace, &seed, &content)
        .unwrap();
    assert_ne!(restored.project_id, project.project_id);
    let restored_context = restored_db
        .courseware_project_context(workspace, &restored.project_id)
        .unwrap();
    assert_eq!(restored_context["mapping"], context["mapping"]);
    assert_eq!(restored_context["sceneObjects"], context["sceneObjects"]);
    assert_eq!(
        serde_json::to_value(
            restored_db
                .courseware_asset_locks(workspace, &restored.project_id)
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        locks
    );

    let before = restored.teaching_revision.clone();
    let edited = restored_db
        .set_courseware_page_lock(
            workspace,
            &restored.project_id,
            &restored.pages[0].page_id,
            &restored.source.revision,
            &before,
            true,
        )
        .unwrap();
    let reopened = restored_db
        .restore_portable_courseware_content(workspace, &seed, &content)
        .unwrap();
    assert_eq!(
        serde_json::to_value(reopened).unwrap(),
        serde_json::to_value(&edited).unwrap()
    );

    let mut changed = content.clone();
    changed.commit_id = uuid::Uuid::new_v4();
    changed.project.title = "A different copy with the same UUID".into();
    assert!(restored_db
        .restore_portable_courseware_content(workspace, &seed, &changed)
        .is_err());
    assert_eq!(
        restored_db
            .get_courseware_project(workspace, &restored.project_id)
            .unwrap()
            .unwrap()
            .teaching_revision,
        edited.teaching_revision
    );

    let other = tempfile::tempdir().unwrap();
    let empty = Database::open_in_dir(other.path()).unwrap();
    let mut conflict = content.clone();
    conflict.scene_objects.as_mut().unwrap().original_identity["mappingRevision"] =
        json!("different-origin");
    conflict.validate(conflict.commit_id, &seed.sha256).unwrap();
    assert!(empty
        .restore_portable_courseware_content(other.path().to_str().unwrap(), &seed, &conflict)
        .is_err());
    assert!(empty
        .get_courseware_project(other.path().to_str().unwrap(), &restored.project_id)
        .unwrap()
        .is_none());
    assert!(empty
        .kv_get(
            identities::IDENTITY_NAMESPACE,
            &identities::identity_key(
                other.path().to_str().unwrap(),
                &restored.project_id,
                &seed.sha256
            )
            .unwrap()
        )
        .unwrap()
        .is_none());
}
