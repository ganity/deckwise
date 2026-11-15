use super::*;

#[test]
fn portable_teaching_media_copy_reopens_without_original_directory_or_database() {
    let original = tempfile::tempdir().unwrap();
    let copied = tempfile::tempdir().unwrap();
    let source = source();
    let id = uuid::Uuid::new_v4();
    let (content, asset, bytes) = with_media(id, &source);
    let encoded = serde_json::to_vec(&content).unwrap();
    let mut store = ProjectCommitStore::open(original.path()).unwrap();
    assert!(
        store.commit(None, id, &source, &encoded).is_err(),
        "media must be durable first"
    );
    assert!(store.index().unwrap().is_none());
    assert!(store.archive_media(&asset, b"wrong bytes").is_err());
    store.archive_media(&asset, &bytes).unwrap();
    store.archive_media(&asset, &bytes).unwrap();
    let revision = store.commit(None, id, &source, &encoded).unwrap();
    drop(store);
    for entry in walkdir::WalkDir::new(original.path()).min_depth(1) {
        let entry = entry.unwrap();
        let output = copied
            .path()
            .join(entry.path().strip_prefix(original.path()).unwrap());
        if entry.file_type().is_dir() {
            std::fs::create_dir(output).unwrap();
        } else {
            std::fs::copy(entry.path(), output).unwrap();
        }
    }
    drop(original);
    let mut reopened = ProjectCommitStore::open(copied.path()).unwrap();
    let actual = reopened.current().unwrap().unwrap();
    assert_eq!(actual.revision, revision);
    assert_eq!(actual.source, source);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&actual.teaching).unwrap(),
        content
    );
    assert_eq!(
        std::fs::read(copied.path().join(&asset.path)).unwrap(),
        bytes
    );
    std::fs::write(copied.path().join(&asset.path), b"tampered media").unwrap();
    assert!(reopened.current().is_err());
    drop(reopened);
    assert!(ProjectCommitStore::open(copied.path())
        .unwrap()
        .current()
        .is_err());
}

#[test]
fn portable_schema_rejects_private_fields_broken_bindings_paths_and_timing_before_any_commit() {
    use serde_json::json;
    let directory = tempfile::tempdir().unwrap();
    let source = source();
    let id = uuid::Uuid::new_v4();
    let (content, asset, bytes) = with_media(id, &source);
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    store.archive_media(&asset, &bytes).unwrap();
    let cases = [
        ("/schemaVersion", json!("deckwise-teaching/2")),
        ("/projectUuid", json!(uuid::Uuid::nil())),
        ("/commitId", json!(uuid::Uuid::new_v4())),
        ("/project/source/sha256", json!("a".repeat(64))),
        ("/project/pages/0/pageId", json!("wrong-page")),
        ("/identity/mappingRevision", json!(null)),
        ("/identity/pages/0/objects/0/type", json!("unsupported")),
        ("/project/pages/0/actions/0/audioAssetId", json!("missing")),
        ("/project/pages/0/actions/0/text", json!(null)),
        (
            "/project/pages/0/actions/0/source",
            json!("private-service"),
        ),
        ("/project/pages/0/actions/0/pauseAfterMs", json!(30001)),
        ("/project/pages/0/actions/0/visualCues/0/endMs", json!(5956)),
        ("/project/pages/0/actions/0/visualCues/0/atMs", json!(500)),
        (
            "/project/pages/0/actions/0/visualCues/0/effect/elementIds/0",
            json!("foreign-object"),
        ),
        ("/project/pages/0/actions/1/stepIndex", json!(1)),
        (
            "/project/pages/0/actions/1/sourceSha256",
            json!("a".repeat(64)),
        ),
        ("/project/pages/0/actions/2/durationMs", json!(30001)),
        ("/project/pages/0/actions/2/type", json!("private-request")),
        (
            "/project/pages/0/actions/3/checkpointKind",
            json!("automatic-private-gate"),
        ),
        ("/media/0/path", json!("../outside.wav")),
        (
            "/media/0/path",
            json!("https://example.invalid/audio?signature=private"),
        ),
        ("/media/0/mimeType", json!("video/mp4")),
        ("/media/0/byteLength", json!(1)),
        ("/media/0/durationMs", json!(0)),
    ];
    for (pointer, bad) in cases {
        let mut changed = content.clone();
        *changed.pointer_mut(pointer).unwrap() = bad;
        assert!(
            store
                .commit(None, id, &source, &serde_json::to_vec(&changed).unwrap())
                .is_err(),
            "{pointer}"
        );
        assert!(store.index().unwrap().is_none(), "{pointer}");
        assert!(!directory.path().join(SOURCE).exists());
    }
    for pointer in [
        "",
        "/project",
        "/project/pages/0",
        "/project/pages/0/actions/0",
        "/identity",
        "/media/0",
    ] {
        let mut changed = content.clone();
        changed
            .pointer_mut(pointer)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert("principalKey".into(), json!("private"));
        assert!(
            store
                .commit(None, id, &source, &serde_json::to_vec(&changed).unwrap())
                .is_err(),
            "private at {pointer}"
        );
    }
    // Optional fields must reject explicit null rather than silently losing it on a round trip.
    for field in [
        "audioAssetId",
        "source",
        "pauseAfterMs",
        "visualCues",
        "attention",
    ] {
        let mut changed = content.clone();
        changed["project"]["pages"][0]["actions"][0][field] = json!(null);
        assert!(
            store
                .commit(None, id, &source, &serde_json::to_vec(&changed).unwrap())
                .is_err(),
            "null {field}"
        );
    }
}

#[test]
fn portable_project_identity_cannot_change_on_an_existing_commit() {
    let directory = tempfile::tempdir().unwrap();
    let source = source();
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    let old = commit(&mut store, None, &source, "old").unwrap();
    for field in ["uuid", "legacy"] {
        let id = uuid::Uuid::new_v4();
        let mut content = teaching(id, &source, "new");
        if field == "uuid" {
            content["projectUuid"] = serde_json::json!(uuid::Uuid::new_v4());
        } else {
            content["project"]["projectId"] = serde_json::json!("another-project");
        }
        assert!(store
            .commit(
                Some(&old),
                id,
                &source,
                &serde_json::to_vec(&content).unwrap()
            )
            .is_err());
        assert_current(&mut store, &old, &source, "old");
    }
}

#[test]
fn malformed_but_hash_consistent_pending_teaching_never_replaces_public_source() {
    let directory = tempfile::tempdir().unwrap();
    let source = source();
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    let old = commit(&mut store, None, &source, "old").unwrap();
    let id = uuid::Uuid::new_v4();
    let mut changed_source = source.clone();
    changed_source.extend_from_slice(b"new source bytes");
    let mut content = teaching(id, &changed_source, "new");
    content["project"]["pages"][0]["actions"][0]["principalKey"] = serde_json::json!("private");
    let bytes = serde_json::to_vec(&content).unwrap();
    let next = Revision {
        version: 1,
        commit_id: id,
        source_sha256: store.archive(&changed_source, "pptx", MAX_SOURCE).unwrap(),
        teaching_sha256: store.archive(&bytes, "json", MAX_TEACHING).unwrap(),
    };
    store
        .metadata
        .publish(
            "pending.json",
            &serde_json::to_vec(&Pending {
                version: 1,
                previous: Some(old.clone()),
                next,
            })
            .unwrap(),
        )
        .unwrap();
    drop(store);
    assert!(ProjectCommitStore::open(directory.path()).is_err());
    assert_eq!(
        std::fs::read(directory.path().join(SOURCE)).unwrap(),
        source
    );
    let actual: serde_json::Value =
        serde_json::from_slice(&std::fs::read(directory.path().join(TEACHING)).unwrap()).unwrap();
    assert_eq!(actual["project"]["pages"][0]["actions"][0]["text"], "old");
}

#[test]
fn duplicate_nodes_assets_and_unreferenced_media_cannot_enter_portable_content() {
    let source = source();
    let id = uuid::Uuid::new_v4();
    let (content, _, _) = with_media(id, &source);
    for kind in [
        "node",
        "checkpoint",
        "asset",
        "unused",
        "hash",
        "cue",
        "binding",
        "metadata",
    ] {
        let mut changed = content.clone();
        match kind {
            "node" => {
                let duplicate = changed["project"]["pages"][0]["actions"][0].clone();
                changed["project"]["pages"][0]["actions"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "checkpoint" => {
                let mut duplicate = changed["project"]["pages"][0]["actions"][3].clone();
                duplicate["id"] = serde_json::json!("other-wait");
                changed["project"]["pages"][0]["actions"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "asset" => {
                let duplicate = changed["media"][0].clone();
                changed["media"].as_array_mut().unwrap().push(duplicate);
            }
            "unused" => {
                changed["project"]["pages"][0]["actions"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("audioAssetId");
            }
            "hash" => {
                changed["media"][0]["id"] = serde_json::json!(format!("tts-{}", "a".repeat(64)));
            }
            "cue" => {
                let duplicate =
                    changed["project"]["pages"][0]["actions"][0]["visualCues"][0].clone();
                changed["project"]["pages"][0]["actions"][0]["visualCues"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "metadata" => {
                let mut duplicate = changed["media"][0].clone();
                duplicate["id"] = serde_json::json!("same-bytes");
                duplicate["durationMs"] = serde_json::json!(1);
                changed["media"].as_array_mut().unwrap().push(duplicate);
            }
            "binding" => {
                let mut duplicate = changed["project"]["pages"][0]["actions"][1].clone();
                duplicate["id"] = serde_json::json!("step-2");
                changed["project"]["pages"][0]["actions"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            _ => unreachable!(),
        }
        assert!(
            Teaching::parse(&serde_json::to_vec(&changed).unwrap(), id, &digest(&source)).is_err(),
            "{kind}"
        );
    }
}

#[test]
fn portable_node_union_round_trips_without_requiring_finished_audio_or_ready_pages() {
    use serde_json::json;
    let source = source();
    let id = uuid::Uuid::new_v4();
    let (mut content, asset, _) = with_media(id, &source);
    let target = content["identity"]["pages"][0]["objects"][0]["logicalId"].clone();
    let target2 = content["identity"]["pages"][0]["objects"][1]["logicalId"].clone();
    let music_id = format!("music-{}", asset.sha256);
    let mut music = serde_json::to_value(&asset).unwrap();
    music["id"] = json!(music_id);
    content["media"].as_array_mut().unwrap().push(music);
    let video_hash = "b".repeat(64);
    let video_id = format!("video-{video_hash}");
    content["media"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":video_id,
        "path":format!("media/{video_hash}.bin"), "sha256":video_hash, "mimeType":"video/mp4",
        "byteLength":128, "durationMs":1200}));
    content["project"]["pages"][0]["actions"][0]["visualCues"].as_array_mut().unwrap().extend([
        json!({"id":"spot", "atMs":500, "endMs":1000, "effect":{"type":"spotlight","elementId":target}}),
        json!({"id":"motion", "atMs":1000, "endMs":1500, "effect":{"type":"element_animation","elementId":target2, "effect":"pulse"}}),
    ]);
    content["project"]["pages"][0]["actions"].as_array_mut().unwrap().extend([
        json!({"id":"draft", "type":"speech", "text":"", "attention":{"type":"highlight", "objectIds":[target]}}),
        json!({"id":"music", "type":"audio_clip", "audioAssetId":music_id}),
        json!({"id":"video", "type":"video_clip", "videoAssetId":video_id}),
        json!({"id":"summary", "type":"interaction_checkpoint", "checkpointId":"summary-1", "checkpointKind":"chapter_summary",
            "chapterId":"chapter-1", "chapterTitle":"Greetings", "question":"How do we greet?",
            "referenceAnswer":{"summary":"Say hello!", "keyPoints":["Hello!"]}, "context":{"chapterSummary":"Greeting practice", "sourceSceneIds":["page-1"]}}),
    ]);
    let parsed =
        Teaching::parse(&serde_json::to_vec(&content).unwrap(), id, &digest(&source)).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), content);
}

#[test]
fn portable_media_symlink_cannot_read_or_replace_an_outside_file() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let source = source();
    let id = uuid::Uuid::new_v4();
    let (content, asset, bytes) = with_media(id, &source);
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    let target = outside.path().join("audio.wav");
    std::fs::write(&target, &bytes).unwrap();
    symlink(&target, directory.path().join(&asset.path)).unwrap();
    assert!(store.archive_media(&asset, &bytes).is_err());
    assert!(store
        .commit(None, id, &source, &serde_json::to_vec(&content).unwrap())
        .is_err());
    assert!(store.index().unwrap().is_none());
    assert_eq!(std::fs::read(target).unwrap(), bytes);
}

#[test]
fn project_copy_creates_a_new_directory_without_overwriting_existing_copies() {
    let workspace = tempfile::tempdir().unwrap();
    let source = source();
    let id = uuid::Uuid::new_v4();
    let value = teaching(id, &source, "Copy me");
    let content =
        Teaching::parse(&serde_json::to_vec(&value).unwrap(), id, &digest(&source)).unwrap();
    let path = ProjectCommitStore::create_copy(workspace.path(), &content, &source, |_| {
        panic!("No media expected")
    })
    .unwrap();
    let mut copy = ProjectCommitStore::open(&path).unwrap();
    let baseline = copy.current().unwrap().unwrap();
    assert_eq!(baseline.source, source);
    assert!(ProjectCommitStore::create_copy(
        workspace.path(),
        &content,
        &source,
        |_| unreachable!()
    )
    .is_err());
    assert_eq!(copy.current().unwrap().unwrap().teaching, baseline.teaching);
}

#[test]
fn project_copy_refuses_a_symlinked_parent_and_does_not_write_outside_the_workspace() {
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let source = source();
    let id = uuid::Uuid::new_v4();
    let value = teaching(id, &source, "Copy me");
    let content =
        Teaching::parse(&serde_json::to_vec(&value).unwrap(), id, &digest(&source)).unwrap();
    symlink(outside.path(), workspace.path().join("courseware-copies")).unwrap();
    assert!(ProjectCommitStore::create_copy(
        workspace.path(),
        &content,
        &source,
        |_| unreachable!()
    )
    .is_err());
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}
