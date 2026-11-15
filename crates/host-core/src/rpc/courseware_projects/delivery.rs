use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    session_id: String,
    principal: String,
    document_id: String,
    #[serde(default)]
    expected: Value,
    #[serde(default)]
    value: Value,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let p: Request = serde_json::from_value(params)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    if p.principal.len() != 64
        || !p.principal.bytes().all(|c| c.is_ascii_hexdigit())
        || p.document_id.is_empty()
        || p.document_id.len() > 128
        || !p
            .document_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        || p.value.to_string().len() > 16384
    {
        return Err(rpc_err(1002, "Invalid delivery state", "INVALID_PARAMS"));
    }
    let state = state.lock().await;
    let root = workspace(&state, &p.session_id)?;
    let key = serde_json::to_string(&(root, p.principal, p.document_id))
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    let current = state
        .db
        .kv_get("courseware_delivery", &key)
        .map_err(error)?
        .unwrap_or(Value::Null);
    if method == "courseware.delivery.write" {
        if current != p.expected {
            return Err(rpc_err(
                1002,
                "Delivery state changed",
                "COURSEWARE_CONFLICT",
            ));
        }
        state
            .db
            .kv_set("courseware_delivery", &key, &p.value)
            .map_err(error)?;
        return Ok(p.value);
    }
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn delivery_journal_survives_restart_and_scopes_cas_by_workspace_principal_and_document()
    {
        let profile = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let app = AppState::open(profile.path()).unwrap();
        let session = sessions::create_session(
            &app.db,
            None,
            Some("agent".into()),
            None,
            None,
            Some(workspace.path().to_string_lossy().into()),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app));
        let key = json!({"sessionId":session.id,"principal":"a".repeat(64),"documentId":"native-document"});
        assert_eq!(
            handle(state.clone(), "courseware.delivery.read", key.clone())
                .await
                .unwrap(),
            Value::Null
        );
        let intent = json!({"pending":{"operationId":"intent-1","sourceHash":"saved-source"}});
        let mut write = key.clone();
        write["expected"] = Value::Null;
        write["value"] = intent.clone();
        assert_eq!(
            handle(state.clone(), "courseware.delivery.write", write.clone())
                .await
                .unwrap(),
            intent
        );
        assert!(handle(state.clone(), "courseware.delivery.write", write)
            .await
            .is_err());
        let mut other = key.clone();
        other["principal"] = json!("b".repeat(64));
        assert_eq!(
            handle(state.clone(), "courseware.delivery.read", other)
                .await
                .unwrap(),
            Value::Null
        );
        let mut forged = key.clone();
        forged["workspace"] = json!("/forged");
        assert_eq!(
            handle(state.clone(), "courseware.delivery.read", forged)
                .await
                .unwrap_err()
                .code,
            1002
        );
        drop(state);
        let restarted = Arc::new(Mutex::new(AppState::open(profile.path()).unwrap()));
        assert_eq!(
            handle(restarted, "courseware.delivery.read", key)
                .await
                .unwrap(),
            intent
        );
    }
}
