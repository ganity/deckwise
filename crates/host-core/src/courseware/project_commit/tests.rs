use super::*;

#[test]
fn workspace_restore_walk_refuses_symlink_components_before_recovery_writes() {
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), workspace.path().join("link")).unwrap();
    assert!(ProjectCommitStore::open_in_workspace(
        workspace.path(),
        &workspace.path().join("link")
    )
    .is_err());
    assert!(!outside.path().join(".deckwise").exists());
    assert!(ProjectCommitStore::open_in_workspace(workspace.path(), outside.path()).is_err());
    let folder = workspace.path().join("nested");
    std::fs::create_dir(&folder).unwrap();
    std::os::unix::fs::symlink(outside.path(), folder.join("link")).unwrap();
    assert!(ProjectCommitStore::open_in_workspace(workspace.path(), &folder.join("link")).is_err());
    assert!(!outside.path().join(".deckwise").exists());
    assert!(
        ProjectCommitStore::open_in_workspace(workspace.path(), &folder)
            .unwrap()
            .current()
            .unwrap()
            .is_none()
    );
}
use std::os::unix::fs::{symlink, MetadataExt};

fn source() -> Vec<u8> {
    std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR")).join(
            "../../packages/courseware-runtime/tests/fixtures/fixed-courseware/lesson-r8.pptx",
        ),
    )
    .unwrap()
}

fn teaching(commit: uuid::Uuid, source: &[u8], text: &str) -> serde_json::Value {
    let hash = digest(source);
    let mut identity: serde_json::Value =
        serde_json::from_slice(include_bytes!("../identity/fixtures/identity.json")).unwrap();
    identity["sourceSha256"] = serde_json::json!(hash);
    identity["mappingRevision"] = serde_json::json!("mapping-1");
    identity["diagnostics"] = serde_json::json!([]);
    identity["pages"][0]["logicalId"] = serde_json::json!("page-1");
    serde_json::json!({
        "schemaVersion":"deckwise-teaching/1", "projectUuid":"b219f446-0cbc-4d35-97cb-fb8bb1a3e365",
        "commitId":commit, "identity":identity, "media":[],
        "project":{"schemaVersion":"deckwise-courseware/1", "projectId":"office-portable",
            "taskType":"scene", "title":"Greetings", "source":{"revision":"r1", "sha256":hash},
            "teachingRevision":"t1", "pages":[{"pageId":"page-1", "locked":false,
                "reviewState":"review", "actions":[{"id":"speech-1", "type":"speech", "text":text}]}]}
    })
}

fn commit(
    store: &mut ProjectCommitStore,
    old: Option<&Revision>,
    source: &[u8],
    text: &str,
) -> Result<Revision> {
    let id = uuid::Uuid::new_v4();
    store.commit(
        old,
        id,
        source,
        &serde_json::to_vec(&teaching(id, source, text))?,
    )
}
fn assert_current(store: &mut ProjectCommitStore, expected: &Revision, source: &[u8], text: &str) {
    let current = store.current().unwrap().unwrap();
    assert_eq!(&current.revision, expected);
    assert_eq!(current.source, source);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&current.teaching).unwrap()["project"]["pages"]
            [0]["actions"][0]["text"],
        text
    );
}

#[test]
fn attachment_checks_baseline_without_replacing_an_edited_source() {
    let directory = tempfile::tempdir().unwrap();
    let source = source();
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    commit(&mut store, None, &source, "Original teaching").unwrap();
    let original = store.attachment_baseline(&digest(&source)).unwrap();
    std::fs::write(directory.path().join(SOURCE), b"native saved source").unwrap();
    assert!(store.current().is_err());
    assert!(store.attachment_baseline(&digest(&source)).is_err());
    assert_eq!(
        store
            .attachment_baseline(&digest(b"native saved source"))
            .unwrap()
            .commit_id,
        original.commit_id
    );
    assert_eq!(
        std::fs::read(directory.path().join(SOURCE)).unwrap(),
        b"native saved source"
    );
    std::fs::write(directory.path().join(TEACHING), b"external teaching edit").unwrap();
    assert!(store
        .attachment_baseline(&digest(b"native saved source"))
        .is_err());
}

#[test]
fn round_trip_teaching_only_commit_preserves_source_and_cas_rejects_stale_writes() {
    let directory = tempfile::tempdir().unwrap();
    let source = source();
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    assert!(store.current().unwrap().is_none());
    let first = commit(&mut store, None, &source, "Hello").unwrap();
    let inode = std::fs::metadata(directory.path().join(SOURCE))
        .unwrap()
        .ino();
    let next = commit(&mut store, Some(&first), &source, "Goodbye").unwrap();
    assert_eq!(
        std::fs::metadata(directory.path().join(SOURCE))
            .unwrap()
            .ino(),
        inode
    );
    assert!(commit(&mut store, Some(&first), &source, "stale").is_err());
    assert!(commit(&mut store, None, &source, "not new").is_err());
    assert_current(&mut store, &next, &source, "Goodbye");
    drop(store);
    let mut reopened = ProjectCommitStore::open(directory.path()).unwrap();
    assert_current(&mut reopened, &next, &source, "Goodbye");
    assert!(reopened
        .metadata
        .read("pending.json", MAX_JOURNAL)
        .unwrap()
        .is_none());
}

#[test]
fn every_commit_boundary_recovers_an_entire_previous_or_next_pair_after_restart() {
    let original = source();
    let mut changed = original.clone();
    changed.extend_from_slice(b"new saved source");
    for initial in [true, false] {
        for stop in 1..=10 {
            let directory = tempfile::tempdir().unwrap();
            let mut store = ProjectCommitStore::open(directory.path()).unwrap();
            let previous = if initial {
                None
            } else {
                Some(commit(&mut store, None, &original, "old").unwrap())
            };
            store.boundaries = 0;
            store.fail_after = Some(stop);
            assert!(
                commit(&mut store, previous.as_ref(), &changed, "new").is_err(),
                "boundary {stop}"
            );
            drop(store);
            let mut reopened = ProjectCommitStore::open(directory.path()).unwrap();
            let current = reopened.current().unwrap();
            if stop < 3 {
                if let Some(previous) = previous {
                    assert_current(&mut reopened, &previous, &original, "old");
                } else {
                    assert!(current.is_none());
                }
            } else {
                let current = current.unwrap();
                assert_eq!(current.source, changed, "boundary {stop}");
                assert_eq!(
                    serde_json::from_slice::<serde_json::Value>(&current.teaching).unwrap()
                        ["project"]["pages"][0]["actions"][0]["text"],
                    "new"
                );
                assert_current(&mut reopened, &current.revision, &changed, "new");
            }
        }
    }
}

#[test]
fn serializes_writers_across_independent_handles_and_does_not_replace_external_edits() {
    let directory = tempfile::tempdir().unwrap();
    let source = source();
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    assert!(ProjectCommitStore::open(directory.path()).is_err());
    let first = commit(&mut store, None, &source, "old").unwrap();
    std::fs::write(directory.path().join(SOURCE), b"external change").unwrap();
    assert!(commit(&mut store, Some(&first), &source, "new").is_err());
    assert!(store.current().is_err());
    drop(store);
    let mut reopened = ProjectCommitStore::open(directory.path()).unwrap();
    assert!(reopened.current().is_err());
    assert_eq!(
        std::fs::read(directory.path().join(SOURCE)).unwrap(),
        b"external change"
    );
}

#[test]
fn external_changes_during_partial_commit_block_recovery_before_replacing_either_file() {
    for target in [SOURCE, TEACHING] {
        let directory = tempfile::tempdir().unwrap();
        let source = source();
        let mut store = ProjectCommitStore::open(directory.path()).unwrap();
        let old = commit(&mut store, None, &source, "old").unwrap();
        store.boundaries = 0;
        store.fail_after = Some(5);
        let mut changed = source.clone();
        changed.extend_from_slice(b"new");
        assert!(commit(&mut store, Some(&old), &changed, "new").is_err());
        drop(store);
        std::fs::write(directory.path().join(target), b"foreign").unwrap();
        let before =
            [SOURCE, TEACHING].map(|name| std::fs::read(directory.path().join(name)).unwrap());
        assert!(ProjectCommitStore::open(directory.path()).is_err());
        assert_eq!(
            before,
            [SOURCE, TEACHING].map(|name| std::fs::read(directory.path().join(name)).unwrap())
        );
    }
}

#[test]
fn corrupt_or_unknown_journals_and_missing_objects_never_replace_public_files() {
    for failure in [
        "truncated",
        "unknown",
        "extra",
        "object",
        "missing",
        "index",
    ] {
        let directory = tempfile::tempdir().unwrap();
        let source = source();
        let mut store = ProjectCommitStore::open(directory.path()).unwrap();
        let old = commit(&mut store, None, &source, "old").unwrap();
        store.boundaries = 0;
        store.fail_after = Some(3);
        assert!(commit(&mut store, Some(&old), &source, "new").is_err());
        let pending = store
            .metadata
            .read("pending.json", MAX_JOURNAL)
            .unwrap()
            .unwrap();
        let mut value: serde_json::Value = serde_json::from_slice(&pending).unwrap();
        match failure {
            "truncated" => store.metadata.replace("pending.json", b"{").unwrap(),
            "unknown" => {
                value["version"] = 2.into();
                store
                    .metadata
                    .replace("pending.json", &serde_json::to_vec(&value).unwrap())
                    .unwrap();
            }
            "extra" => {
                value["secret"] = "not allowed".into();
                store
                    .metadata
                    .replace("pending.json", &serde_json::to_vec(&value).unwrap())
                    .unwrap();
            }
            "object" | "missing" => {
                let name = format!("{}.json", value["next"]["teachingSha256"].as_str().unwrap());
                if failure == "missing" {
                    store.objects.remove(&name).unwrap();
                } else {
                    store.objects.replace(&name, b"corrupt").unwrap();
                }
            }
            "index" => {
                let mut other = old;
                other.commit_id = uuid::Uuid::new_v4();
                store
                    .metadata
                    .replace("current.json", &serde_json::to_vec(&other).unwrap())
                    .unwrap();
            }
            _ => unreachable!(),
        }
        let before =
            [SOURCE, TEACHING].map(|name| std::fs::read(directory.path().join(name)).unwrap());
        drop(store);
        assert!(
            ProjectCommitStore::open(directory.path()).is_err(),
            "{failure}"
        );
        assert_eq!(
            before,
            [SOURCE, TEACHING].map(|name| std::fs::read(directory.path().join(name)).unwrap())
        );
    }
}

#[test]
fn symlinks_and_non_regular_files_are_rejected_without_touching_outside_files() {
    let source = source();
    for entry in [
        ".deckwise",
        ".deckwise/writer.lock",
        ".deckwise/objects",
        ".deckwise/pending.json",
        ".deckwise/current.json",
        SOURCE,
        TEACHING,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("untouched");
        std::fs::write(&target, b"outside").unwrap();
        if entry != ".deckwise" {
            std::fs::create_dir(directory.path().join(".deckwise")).unwrap();
        }
        let external = if [".deckwise", ".deckwise/objects"].contains(&entry) {
            outside.path()
        } else {
            &target
        };
        symlink(external, directory.path().join(entry)).unwrap();
        let result = ProjectCommitStore::open(directory.path());
        if let Ok(mut store) = result {
            assert!(commit(&mut store, None, &source, "new").is_err(), "{entry}");
        }
        assert_eq!(std::fs::read(&target).unwrap(), b"outside");
    }
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join(SOURCE)).unwrap();
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    assert!(commit(&mut store, None, &source, "new").is_err());
}

#[test]
fn directory_copy_reopens_without_original_path_and_torn_unpublished_files_are_ignored() {
    let original = tempfile::tempdir().unwrap();
    let source = source();
    let mut store = ProjectCommitStore::open(original.path()).unwrap();
    let committed = commit(&mut store, None, &source, "portable").unwrap();
    store
        .objects
        .create("abandoned.tmp", b"partial archive write")
        .unwrap();
    store
        .metadata
        .create("abandoned.tmp", b"partial journal write")
        .unwrap();
    drop(store);
    let copied = tempfile::tempdir().unwrap();
    for entry in walkdir::WalkDir::new(original.path()).min_depth(1) {
        let entry = entry.unwrap();
        let output = copied
            .path()
            .join(entry.path().strip_prefix(original.path()).unwrap());
        if entry.file_type().is_dir() {
            std::fs::create_dir(&output).unwrap();
        } else {
            std::fs::copy(entry.path(), output).unwrap();
        }
    }
    drop(original);
    let mut reopened = ProjectCommitStore::open(copied.path()).unwrap();
    assert_current(&mut reopened, &committed, &source, "portable");
}

#[test]
fn rejects_oversized_or_invalid_new_content_before_publishing_a_journal() {
    let directory = tempfile::tempdir().unwrap();
    let source = source();
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    for (input, teaching) in [
        (vec![], b"{}".to_vec()),
        (source.clone(), b"bad json".to_vec()),
        (source.clone(), vec![b' '; MAX_TEACHING as usize + 1]),
    ] {
        assert!(store
            .commit(None, uuid::Uuid::new_v4(), &input, &teaching)
            .is_err());
    }
    assert!(store
        .commit(None, uuid::Uuid::nil(), &source, b"{}")
        .is_err());
    assert!(store.current().unwrap().is_none());
    assert!(store
        .metadata
        .read("pending.json", MAX_JOURNAL)
        .unwrap()
        .is_none());
}

#[test]
fn published_index_does_not_authorize_overwriting_an_external_revert() {
    let directory = tempfile::tempdir().unwrap();
    let original = source();
    let mut changed = original.clone();
    changed.extend_from_slice(b"next source");
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    let old = commit(&mut store, None, &original, "old").unwrap();
    store.boundaries = 0;
    store.fail_after = Some(8);
    assert!(commit(&mut store, Some(&old), &changed, "new").is_err());
    drop(store);
    std::fs::write(directory.path().join(SOURCE), &original).unwrap();
    assert!(ProjectCommitStore::open(directory.path()).is_err());
    assert_eq!(
        std::fs::read(directory.path().join(SOURCE)).unwrap(),
        original
    );
}

#[test]
fn process_probe() {
    let Some(root) = std::env::var_os("DECKWISE_COMMIT_PROCESS_ROOT") else {
        return;
    };
    let mode = std::env::var("DECKWISE_COMMIT_PROCESS_MODE").unwrap();
    let opened = ProjectCommitStore::open(Path::new(&root));
    if mode == "blocked" {
        assert!(opened.is_err());
        return;
    }
    let mut store = opened.unwrap();
    if mode == "open" {
        return;
    }
    let previous = store.current().unwrap().unwrap().revision;
    store.boundaries = 0;
    store.fail_after = Some(mode.parse().unwrap());
    let mut next_source = source();
    next_source.extend_from_slice(b"child saved source");
    commit(&mut store, Some(&previous), &next_source, "child next").unwrap();
    panic!("crash probe did not exit at the requested boundary");
}

fn child(root: &Path, mode: &str, crash: bool) -> std::process::Output {
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "courseware::project_commit::tests::process_probe",
            "--nocapture",
        ])
        .env("DECKWISE_COMMIT_PROCESS_ROOT", root)
        .env("DECKWISE_COMMIT_PROCESS_MODE", mode);
    if crash {
        command.env("DECKWISE_COMMIT_CRASH_PROBE", "1");
    }
    command.output().unwrap()
}

#[test]
fn os_lock_excludes_another_process_and_is_released_when_owner_exits() {
    let directory = tempfile::tempdir().unwrap();
    let store = ProjectCommitStore::open(directory.path()).unwrap();
    let output = child(directory.path(), "blocked", false);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    drop(store);
    let output = child(directory.path(), "open", false);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn actual_process_exit_at_each_commit_boundary_recovers_consistently() {
    for stop in 1..=10 {
        let directory = tempfile::tempdir().unwrap();
        let original = source();
        let mut store = ProjectCommitStore::open(directory.path()).unwrap();
        let old = commit(&mut store, None, &original, "old").unwrap();
        drop(store);
        let output = child(directory.path(), &stop.to_string(), true);
        assert_eq!(
            output.status.code(),
            Some(72),
            "boundary {stop}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut reopened = ProjectCommitStore::open(directory.path()).unwrap();
        if stop < 3 {
            assert_current(&mut reopened, &old, &original, "old");
        } else {
            let mut next = original;
            next.extend_from_slice(b"child saved source");
            let current = reopened.current().unwrap().unwrap();
            assert_current(&mut reopened, &current.revision, &next, "child next");
        }
    }
}

#[test]
fn an_external_save_into_the_capture_gap_is_preserved_and_never_replaced() {
    let directory = tempfile::tempdir().unwrap();
    let original = source();
    let mut changed = original.clone();
    changed.extend_from_slice(b"new source");
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    let old = commit(&mut store, None, &original, "old").unwrap();
    store.boundaries = 0;
    store.fail_after = Some(4);
    assert!(commit(&mut store, Some(&old), &changed, "new").is_err());
    assert!(!directory.path().join(SOURCE).exists());
    store
        .root
        .create(SOURCE, b"external save won the race")
        .unwrap();
    assert!(store.root.publish(SOURCE, &changed).is_err());
    let journal: Pending = serde_json::from_slice(
        &store
            .metadata
            .read("pending.json", MAX_JOURNAL)
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    let backup = format!("{}-{SOURCE}", journal.next.commit_id);
    assert_eq!(
        store.displaced.read(&backup, MAX_SOURCE).unwrap().unwrap(),
        original
    );
    drop(store);
    assert!(ProjectCommitStore::open(directory.path()).is_err());
    assert_eq!(
        std::fs::read(directory.path().join(SOURCE)).unwrap(),
        b"external save won the race"
    );
}

#[test]
fn retained_predecessor_keeps_late_writes_from_an_existing_external_file_descriptor() {
    let directory = tempfile::tempdir().unwrap();
    let original = source();
    let mut changed = original.clone();
    changed.extend_from_slice(b"next source");
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    let old = commit(&mut store, None, &original, "old").unwrap();
    let mut external = OpenOptions::new()
        .write(true)
        .open(directory.path().join(SOURCE))
        .unwrap();
    let next = commit(&mut store, Some(&old), &changed, "new").unwrap();
    external.write_all(b"late external save").unwrap();
    external.sync_all().unwrap();
    assert_current(&mut store, &next, &changed, "new");
    let retained = store
        .displaced
        .read(&format!("{}-{SOURCE}", next.commit_id), MAX_SOURCE)
        .unwrap()
        .unwrap();
    assert!(retained.starts_with(b"late external save"));
}

#[test]
fn corrupt_previous_archive_is_not_hidden_by_a_new_commit() {
    let directory = tempfile::tempdir().unwrap();
    let original = source();
    let mut store = ProjectCommitStore::open(directory.path()).unwrap();
    let old = commit(&mut store, None, &original, "old").unwrap();
    store
        .objects
        .replace(&format!("{}.json", old.teaching_sha256), b"corrupt")
        .unwrap();
    assert!(commit(&mut store, Some(&old), &original, "new").is_err());
    assert_eq!(store.index().unwrap(), Some(old));
    assert!(store
        .metadata
        .read("pending.json", MAX_JOURNAL)
        .unwrap()
        .is_none());
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &std::fs::read(directory.path().join(TEACHING)).unwrap()
        )
        .unwrap()["project"]["pages"][0]["actions"][0]["text"],
        "old"
    );
}

fn with_media(id: uuid::Uuid, source: &[u8]) -> (serde_json::Value, Media, Vec<u8>) {
    let bytes = std::fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/courseware-runtime/tests/fixtures/fixed-courseware/page-1.wav"),
    )
    .unwrap();
    let hash = digest(&bytes);
    let asset = Media {
        id: format!("tts-{hash}"),
        path: format!("media/{hash}.bin"),
        sha256: hash,
        mime_type: "audio/wav".into(),
        byte_length: bytes.len() as u64,
        duration_ms: 5955,
    };
    let mut content = teaching(id, source, "Hello!");
    let target = content["identity"]["pages"][0]["objects"][0]["logicalId"].clone();
    content["media"] = serde_json::json!([asset]);
    content["project"]["pages"][0]["locked"] = serde_json::json!(true);
    content["project"]["pages"][0]["actions"] = serde_json::json!([
        {"id":"speech-1","type":"speech","text":"Hello!", "audioAssetId":asset.id, "source":"generated", "pauseAfterMs":0,
         "visualCues":[{"id":"cue-1", "atMs":0,"endMs":500,
            "effect":{"type":"highlight", "elementIds":[target]}}]},
        {"id":"step-1","type":"native_animation","version":1,"sourceSha256":digest(source),"stepIndex":0},
        {"id":"pause-1","type":"delay","durationMs":200},
        {"id":"wait-1","type":"interaction_checkpoint","checkpointId":"teacher-1","checkpointKind":"teacher_continue"},
        {"id":"slot-1","type":"video_slot","prompt":"A greeting animation"}
    ]);
    (content, asset, bytes)
}

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
