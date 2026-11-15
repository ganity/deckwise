use super::*;

const NAMESPACE: &str = "coursewareMediaRelay.v1";
const MAX_BYTES: usize = 24 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    principal_key: String,
    key: String,
    #[serde(default)]
    expected_revision: Option<u64>,
    #[serde(default)]
    value: Option<Value>,
}

fn valid(p: &Params) -> bool {
    p.principal_key.len() == 64
        && p.principal_key
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && (p.key.starts_with("task:") || p.key.starts_with("candidate:"))
        && p.key.len() <= 110
        && p.key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b":._-".contains(&c))
        && p.value
            .as_ref()
            .is_none_or(|v| v.is_object() && v.to_string().len() <= MAX_BYTES)
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let p: Params = serde_json::from_value(params)
        .map_err(|_| rpc_err(1002, "Invalid media journal", "INVALID_PARAMS"))?;
    if !valid(&p)
        || (method.ends_with(".write") && (p.value.is_none() || p.expected_revision.is_none()))
    {
        return Err(rpc_err(1002, "Invalid media journal", "INVALID_PARAMS"));
    }
    let state = state.lock().await;
    let key = format!("{}:{}", p.principal_key, p.key);
    let current = state.db.kv_get(NAMESPACE, &key).map_err(error)?;
    if method.ends_with(".read") {
        return Ok(current.unwrap_or(Value::Null));
    }
    let revision = current
        .as_ref()
        .and_then(|v| v.get("revision"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if p.expected_revision != Some(revision) {
        return Err(rpc_err(
            1002,
            "Media journal changed",
            "COURSEWARE_MEDIA_JOURNAL_CONFLICT",
        ));
    }
    let next = json!({"revision": revision + 1, "value": p.value});
    state.db.kv_set(NAMESPACE, &key, &next).map_err(error)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn journal_is_principal_scoped_and_bounded() {
        let mut p = Params {
            principal_key: "a".repeat(64),
            key: "task:receipt-1".into(),
            expected_revision: Some(0),
            value: Some(json!({"kind":"tts"})),
        };
        assert!(valid(&p));
        p.key = "../../auth".into();
        assert!(!valid(&p));
        p.key = "task:x".into();
        p.principal_key = "../".into();
        assert!(!valid(&p));
        p.principal_key = "a".repeat(64);
        p.value = Some(json!([1]));
        assert!(!valid(&p));
    }
}
