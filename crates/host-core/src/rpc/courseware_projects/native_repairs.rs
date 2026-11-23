use super::*;
use std::collections::BTreeMap;

const NAMESPACE: &str = "coursewareNativeRepairs.v1";
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    session_id: String,
    project_id: String,
    source_path: String,
    expected_revision: Option<u64>,
    failures: Option<BTreeMap<String, String>>,
    narration: Option<NarrationBudget>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NarrationBudget {
    turn_id: String,
    pages: BTreeMap<String, NarrationAttempt>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NarrationAttempt {
    attempts: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let p: Params = serde_json::from_value(params)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    let invalid = || rpc_err(1002, "Invalid native repair state", "INVALID_PARAMS");
    if p.project_id.is_empty()
        || p.project_id.len() > 200
        || p.failures.as_ref().is_some_and(|f| {
            f.len() > 1000
                || f.iter().any(|(id, message)| {
                    id.is_empty() || id.len() > 200 || message.is_empty() || message.len() > 2000
                })
        })
        || p.narration.as_ref().is_some_and(|budget| {
            budget.turn_id.is_empty()
                || budget.turn_id.len() > 200
                || budget.pages.len() > 1000
                || budget.pages.iter().any(|(key, attempt)| {
                    key.len() != 64
                        || !key
                            .bytes()
                            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                        || attempt.attempts > 3
                        || attempt
                            .error
                            .as_ref()
                            .is_some_and(|e| e.is_empty() || e.len() > 8000)
                        || attempt.code.as_ref().is_some_and(|c| {
                            !c.starts_with(|v: char| v.is_ascii_uppercase())
                                || c.len() > 100
                                || !c.bytes().all(|v| {
                                    v.is_ascii_uppercase() || v.is_ascii_digit() || v == b'_'
                                })
                        })
                })
        })
    {
        return Err(invalid());
    }
    let state = state.lock().await;
    let root = project_workspace(&state, &p.session_id)?;
    let path = crate::workspace::resolve_in_workspace(Path::new(&root), &p.source_path)
        .map_err(|_| invalid())?;
    if path != Path::new(&p.source_path) || !p.source_path.to_ascii_lowercase().ends_with(".pptx") {
        return Err(invalid());
    }
    let task = state
        .db
        .kv_get(TASK_NAMESPACE, &p.session_id)
        .map_err(error)?
        .ok_or_else(invalid)?;
    if task
        .get("generatedPath")
        .and_then(Value::as_str)
        .or_else(|| task.get("importPath").and_then(Value::as_str))
        != Some(p.source_path.as_str())
    {
        return Err(invalid());
    }
    let key = serde_json::to_string(&(&root, &p.session_id, &p.source_path, &p.project_id))
        .map_err(|_| invalid())?;
    let current = state
        .db
        .kv_get(NAMESPACE, &key)
        .map_err(error)?
        .unwrap_or(json!({"revision":0,"failures":{}}));
    if method.ends_with(".read") {
        if p.expected_revision.is_some() || p.failures.is_some() || p.narration.is_some() {
            return Err(invalid());
        }
        return Ok(current);
    }
    let revision = current["revision"].as_u64().ok_or_else(invalid)?;
    if p.expected_revision != Some(revision) {
        return Err(rpc_err(
            1008,
            "Native repair state changed",
            "COURSEWARE_CONFLICT",
        ));
    }
    let failures = p.failures.ok_or_else(invalid)?;
    let mut next =
        json!({"revision":revision.checked_add(1).ok_or_else(invalid)?,"failures":failures});
    if let Some(narration) = p.narration {
        next["narration"] = serde_json::to_value(narration).map_err(|_| invalid())?;
    } else if let Some(narration) = current.get("narration") {
        next["narration"] = narration.clone();
    }
    state.db.kv_set(NAMESPACE, &key, &next).map_err(error)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn native_repairs_survive_restart_reject_stale_writes_and_isolate_documents() {
        let profile = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("lesson.pptx");
        std::fs::write(&path, b"fixture").unwrap();
        let app = AppState::open(profile.path()).unwrap();
        let session = sessions::create_session(
            &app.db,
            None,
            Some("agent".into()),
            None,
            None,
            Some(root.to_string_lossy().into()),
        )
        .unwrap();
        app.db
            .kv_set(TASK_NAMESPACE, &session.id, &json!({"generatedPath":path}))
            .unwrap();
        let key = json!({"sessionId":session.id,"projectId":"native-lesson","sourcePath":path});
        let state = Arc::new(Mutex::new(app));
        assert_eq!(
            handle(state.clone(), "courseware.nativeRepairs.read", key.clone())
                .await
                .unwrap()["revision"],
            0
        );
        let mut write = key.clone();
        write["expectedRevision"] = json!(0);
        write["failures"] = json!({"page1":"Required repair pending"});
        write["narration"] = json!({"turnId":"turn-1","pages": {"a".repeat(64): {"attempts":3}}});
        let saved = handle(
            state.clone(),
            "courseware.nativeRepairs.write",
            write.clone(),
        )
        .await
        .unwrap();
        assert!(handle(
            state.clone(),
            "courseware.nativeRepairs.write",
            write.clone()
        )
        .await
        .is_err());
        assert!(handle(
            state.clone(),
            "courseware.nativeRepairs.read",
            write.clone()
        )
        .await
        .is_err());
        let mut other = key.clone();
        other["projectId"] = json!("native-other");
        assert_eq!(
            handle(state.clone(), "courseware.nativeRepairs.read", other)
                .await
                .unwrap()["revision"],
            0
        );
        let mut outside = key.clone();
        outside["sourcePath"] = json!(profile.path().join("outside.pptx"));
        assert!(
            handle(state.clone(), "courseware.nativeRepairs.read", outside)
                .await
                .is_err()
        );
        drop(state);
        let restarted = Arc::new(Mutex::new(AppState::open(profile.path()).unwrap()));
        assert_eq!(
            handle(
                restarted.clone(),
                "courseware.nativeRepairs.read",
                key.clone()
            )
            .await
            .unwrap(),
            saved
        );
        write["expectedRevision"] = json!(1);
        write["failures"] = json!({});
        for narration in [
            json!({"turnId":"","pages":{}}),
            json!({"turnId":"turn-1","pages":{"invalid":{"attempts":1}}}),
            json!({"turnId":"turn-1","pages":{"a".repeat(64):{"attempts":4}}}),
        ] {
            let mut invalid_write = write.clone();
            invalid_write["narration"] = narration;
            assert!(handle(
                restarted.clone(),
                "courseware.nativeRepairs.write",
                invalid_write
            )
            .await
            .is_err());
        }
        write.as_object_mut().unwrap().remove("narration");
        assert_eq!(
            handle(restarted.clone(), "courseware.nativeRepairs.write", write)
                .await
                .unwrap()["revision"],
            2
        );
        let cleared = handle(restarted, "courseware.nativeRepairs.read", key)
            .await
            .unwrap();
        assert_eq!(cleared["failures"], json!({}));
        assert_eq!(cleared["narration"], saved["narration"]);
    }
}
