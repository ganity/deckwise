use super::*;
use crate::rpc::handle_request;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn audio_rpc_enforces_ownership_bytes_and_restart_safe_adoption() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let raw: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    )))
    .unwrap();
    let project = serde_json::from_value(raw["project"].clone()).unwrap();
    app.db
        .create_courseware_project(root.to_str().unwrap(), &project)
        .unwrap();
    let session = sessions::create_session(
        &app.db,
        None,
        None,
        None,
        None,
        Some(root.to_string_lossy().into()),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _rx) = mpsc::unbounded_channel();
    let selection = json!({"intentId":"intent","principalKey":"a".repeat(64),"projectId":"course-01", "pageId":"fixture-page-1","actionId":"narration-0","expectedSourceRevision":"R8", "expectedTeachingRevision":"T8","model":"courseware-tts-v1","voice":null});
    let scope = json!({"sessionId":session.id,"projectId":"course-01","principalKey":"a".repeat(64),"intentId":"intent"});
    let prepared = handle_request(
        state.clone(),
        "courseware.tts.prepare",
        json!({"sessionId":session.id,"selection":selection}),
        tx.clone(),
    )
    .await
    .unwrap();
    handle_request(
        state.clone(),
        "courseware.tts.begin",
        scope.clone(),
        tx.clone(),
    )
    .await
    .unwrap();
    let task = json!({"taskId":"task","idempotencyKey":prepared["intent"]["idempotencyKey"],"requestHash":prepared["intent"]["requestHash"]});
    let mut binding = scope.clone();
    binding["taskRef"] = task.clone();
    handle_request(state.clone(), "courseware.tts.bind", binding, tx.clone())
        .await
        .unwrap();
    // Synthetic PCM fixture; codec decoding belongs to Main, not this Host boundary test.
    let mut bytes = vec![0_u8; 1644];
    bytes[..4].copy_from_slice(b"RIFF");
    bytes[4..8].copy_from_slice(&1636_u32.to_le_bytes());
    bytes[8..16].copy_from_slice(b"WAVEfmt ");
    bytes[16..20].copy_from_slice(&16_u32.to_le_bytes());
    bytes[20..22].copy_from_slice(&1_u16.to_le_bytes());
    bytes[22..24].copy_from_slice(&1_u16.to_le_bytes());
    bytes[24..28].copy_from_slice(&8000_u32.to_le_bytes());
    bytes[28..32].copy_from_slice(&16000_u32.to_le_bytes());
    bytes[32..34].copy_from_slice(&2_u16.to_le_bytes());
    bytes[34..36].copy_from_slice(&16_u16.to_le_bytes());
    bytes[36..40].copy_from_slice(b"data");
    bytes[40..44].copy_from_slice(&1600_u32.to_le_bytes());
    let hash = hex::encode(Sha256::digest(&bytes));
    let mut stage = scope.clone();
    stage["audio"] = json!({"taskRef":task,"sha256":hash,"mimeType":"audio/wav","byteLength":bytes.len(),"durationMs":100});
    stage["bytesBase64"] = json!(STANDARD.encode(&bytes));
    for field in [
        "workspace",
        "path",
        "principalKey",
        "bytesBase64",
        "task",
        "hash",
        "mime",
        "length",
        "duration",
    ] {
        let mut forged = stage.clone();
        match field {
            "workspace" | "path" => forged[field] = json!(root),
            "principalKey" => forged[field] = json!("b".repeat(64)),
            "bytesBase64" => forged[field] = json!("not base64!"),
            "task" => forged["audio"]["taskRef"]["taskId"] = json!("foreign"),
            "hash" => forged["audio"]["sha256"] = json!("b".repeat(64)),
            "mime" => forged["audio"]["mimeType"] = json!("audio/mpeg"),
            "length" => forged["audio"]["byteLength"] = json!(bytes.len() + 1),
            _ => forged["audio"]["durationMs"] = json!(0),
        }
        assert!(
            handle_request(
                state.clone(),
                "courseware.tts.audio.stage",
                forged,
                tx.clone()
            )
            .await
            .is_err(),
            "{field}"
        );
        assert!(handle_request(
            state.clone(),
            "courseware.tts.audio.get",
            scope.clone(),
            tx.clone()
        )
        .await
        .is_err());
    }
    let saved = handle_request(
        state.clone(),
        "courseware.tts.audio.stage",
        stage.clone(),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(saved["audioReady"], false);
    assert_eq!(saved["adoptedTeachingRevision"], Value::Null);
    assert_eq!(saved["asset"]["id"], format!("tts-{hash}"));
    let archived = Path::new(saved["path"].as_str().unwrap());
    assert!(archived.starts_with(dir.path()));
    assert_eq!(std::fs::read(archived).unwrap(), bytes);
    assert_eq!(
        state
            .lock()
            .await
            .db
            .get_courseware_project(root.to_str().unwrap(), "course-01")
            .unwrap()
            .unwrap()
            .teaching_revision,
        "T8"
    );
    drop(state);
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let state = Arc::new(Mutex::new(app));
    assert_eq!(
        handle_request(
            state.clone(),
            "courseware.tts.audio.get",
            scope.clone(),
            tx.clone()
        )
        .await
        .unwrap(),
        saved
    );
    let mut adopt = scope.clone();
    adopt["expectedTeachingRevision"] = json!("stale");
    adopt["expectedAudioAssetId"] = Value::Null;
    assert!(handle_request(
        state.clone(),
        "courseware.tts.audio.adopt",
        adopt.clone(),
        tx.clone()
    )
    .await
    .is_err());
    adopt["expectedTeachingRevision"] = json!("T8");
    let adopted = handle_request(
        state.clone(),
        "courseware.tts.audio.adopt",
        adopt.clone(),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        adopted["project"]["pages"][0]["actions"][0]["audioAssetId"],
        format!("tts-{hash}")
    );
    assert_eq!(
        handle_request(
            state.clone(),
            "courseware.tts.audio.adopt",
            adopt.clone(),
            tx.clone()
        )
        .await
        .unwrap(),
        adopted
    );
    assert_eq!(adopted["audioReady"], false);
    std::fs::write(archived, b"corrupted").unwrap();
    for (method, params) in [
        ("courseware.tts.audio.get", scope),
        ("courseware.tts.audio.stage", stage),
        ("courseware.tts.audio.adopt", adopt),
    ] {
        assert!(handle_request(state.clone(), method, params, tx.clone())
            .await
            .is_err());
    }
    assert_eq!(std::fs::read(archived).unwrap(), b"corrupted");
    assert_eq!(
        state
            .lock()
            .await
            .db
            .get_courseware_project(root.to_str().unwrap(), "course-01")
            .unwrap()
            .unwrap()
            .teaching_revision,
        adopted["project"]["teachingRevision"].as_str().unwrap()
    );
}
