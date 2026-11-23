use super::*;
use sha2::{Digest, Sha256};

fn invalid(message: impl std::fmt::Display) -> JsonRpcError {
    rpc_err(1002, message.to_string(), "COURSEWARE_MATERIAL_INVALID")
}

const NAMESPACE: &str = "coursewareMaterials.v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    session_id: String,
    #[serde(default)]
    source_id: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    parser: Option<String>,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let p: Params = serde_json::from_value(params).map_err(invalid)?;
    let state = state.lock().await;
    let root = project_workspace(&state, &p.session_id)?;
    if state
        .db
        .kv_get(TASK_NAMESPACE, &p.session_id)
        .map_err(error)?
        .is_none()
    {
        return Err(invalid(
            "Select a courseware task before recording materials",
        ));
    }
    if method == "courseware.material.verifyInline" {
        let text = p.text.as_deref().unwrap_or_default();
        if text.trim().is_empty()
            || text.len() > 2 * 1024 * 1024
            || p.name.is_some()
            || p.parser.is_some()
            || p.source_id.is_some()
        {
            return Err(invalid("Supply inline material text for this session"));
        }
        let quoted = text.replace("\r\n", "\n");
        let mut candidates = state
            .db
            .conn()
            .prepare_cached(
                "SELECT id FROM messages WHERE session_id = ?1 AND role = 'user'
             AND instr(replace(text, char(13)||char(10), char(10)), ?2) > 0 ORDER BY seq DESC",
            )
            .map_err(|e| error(e.into()))?;
        let ids = candidates
            .query_map(rusqlite::params![p.session_id, quoted], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|e| error(e.into()))?;
        for id in ids {
            let id = id.map_err(|e| error(e.into()))?;
            // The transcript carries the origin of agent-to-agent deliveries that also have the user role.
            let options = sessions::SessionReadOptions {
                message_around: Some(id.clone()),
                message_limit: Some(1),
                ..Default::default()
            };
            let session = sessions::get_session_with_options(&state.db, &p.session_id, options)
                .map_err(error)?;
            if session.is_some_and(|s| {
                s.messages.iter().any(|m| {
                    m.id == id
                        && m.role == "user"
                        && m.session_message.is_none()
                        && m.parent_tool_call_id.is_none()
                        && m.content.replace("\r\n", "\n").contains(&quoted)
                })
            }) {
                return Ok(json!({"supplied": true}));
            }
        }
        return Ok(json!({"supplied": false}));
    }
    let key = format!(
        "{}:{}",
        hex::encode(Sha256::digest(root.as_bytes())),
        p.session_id
    );
    let mut saved = state
        .db
        .kv_get(NAMESPACE, &key)
        .map_err(error)?
        .unwrap_or_else(|| json!({"version":1,"sources":[]}));
    if saved["version"] != 1 || !saved["sources"].is_array() {
        return Err(invalid("Unsupported material record version"));
    }
    if method == "courseware.material.record" {
        let text = p.text.ok_or_else(|| invalid("Material text is required"))?;
        let name = p.name.ok_or_else(|| invalid("Material name is required"))?;
        let parser = p
            .parser
            .ok_or_else(|| invalid("Material parser is required"))?;
        if p.source_id.is_some()
            || text.trim().is_empty()
            || text.len() > 2 * 1024 * 1024
            || text.contains('\0')
            || name.is_empty()
            || name.len() > 1000
            || name.contains(['/', '\\'])
            || !matches!(parser.as_str(), "document-service/1" | "utf8/1")
        {
            return Err(invalid("Invalid extracted material"));
        }
        let sha256 = hex::encode(Sha256::digest(text.as_bytes()));
        let source = json!({"sourceId":sha256,"text":text,"name":name,"parser":parser,"byteLength":text.len()});
        let sources = saved["sources"]
            .as_array_mut()
            .ok_or_else(|| invalid("Invalid material record"))?;
        if let Some(previous) = sources.iter().find(|s| s["sourceId"] == sha256) {
            if previous["text"] != source["text"] {
                return Err(invalid("Immutable material differs"));
            }
            return Ok(json!({"sourceId":sha256}));
        }
        if sources.len() >= 16 {
            return Err(invalid("Material count limit reached"));
        }
        sources.push(source);
        if serde_json::to_vec(&saved).map_err(invalid)?.len() > 8 * 1024 * 1024 {
            return Err(invalid("Material budget exceeded"));
        }
        state.db.kv_set(NAMESPACE, &key, &saved).map_err(error)?;
        if state.db.kv_get(NAMESPACE, &key).map_err(error)?.as_ref() != Some(&saved) {
            return Err(invalid("Material record was not stored"));
        }
        return Ok(json!({"sourceId":sha256}));
    }
    if p.text.is_some() || p.name.is_some() || p.parser.is_some() {
        return Err(invalid("Unexpected material read parameters"));
    }
    let sources = saved["sources"]
        .as_array()
        .ok_or_else(|| invalid("Invalid material record"))?;
    if method == "courseware.material.read" {
        let source = sources
            .iter()
            .find(|s| Some(s["sourceId"].as_str().unwrap_or_default()) == p.source_id.as_deref())
            .ok_or_else(|| invalid("Material is unavailable in this task"))?;
        return Ok(source.clone());
    }
    if method != "courseware.material.list" || p.source_id.is_some() {
        return Err(invalid("Invalid material operation"));
    }
    Ok(
        json!({"sources":sources.iter().map(|s| json!({"sourceId":s["sourceId"],"name":s["name"],"parser":s["parser"],"byteLength":s["byteLength"]})).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn materials_are_immutable_scoped_bounded_and_survive_database_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let app = AppState::open(dir.path()).unwrap();
        let root = dir.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let session = sessions::create_session(
            &app.db,
            None,
            None,
            None,
            None,
            Some(root.to_string_lossy().into()),
        )
        .unwrap();
        let peer = sessions::create_session(
            &app.db,
            None,
            None,
            None,
            None,
            Some(root.to_string_lossy().into()),
        )
        .unwrap();
        for id in [&session.id, &peer.id] {
            app.db
                .kv_set(TASK_NAMESPACE, id, &json!({"taskType":"import"}))
                .unwrap();
        }
        for (role, content) in [
            ("user", "My supplied script:\r\nFirst line.\r\nSecond line."),
            ("assistant", "Invented draft."),
        ] {
            let msg = serde_json::from_value(
                json!({"id":role,"role":role,"content":content,"createdAt":"2026-11-20T00:00:00Z"}),
            )
            .unwrap();
            sessions::append_message(&app.db, &session.id, &msg, None).unwrap();
        }
        let state = Arc::new(Mutex::new(app));
        for (owner, quote, expected) in [
            (&session.id, "First line.\nSecond line.", true),
            (&session.id, "Invented draft.", false),
            (&peer.id, "First line.", false),
        ] {
            let verified = handle(
                state.clone(),
                "courseware.material.verifyInline",
                json!({"sessionId":owner, "text":quote}),
            )
            .await
            .unwrap();
            assert_eq!(verified["supplied"], expected);
        }
        let source = json!({"sessionId":session.id,"name":"script.txt","text":"P1: Hello 1.25 kg.","parser":"utf8/1"});
        let first = handle(state.clone(), "courseware.material.record", source.clone())
            .await
            .unwrap();
        assert_eq!(
            handle(state.clone(), "courseware.material.record", source)
                .await
                .unwrap(),
            first
        );
        assert!(handle(
            state.clone(),
            "courseware.material.read",
            json!({"sessionId":peer.id,"sourceId":first["sourceId"]})
        )
        .await
        .is_err());
        assert!(handle(
            state.clone(),
            "courseware.material.record",
            json!({"sessionId":session.id,"name":"../secret","text":"Text","parser":"utf8/1"})
        )
        .await
        .is_err());
        drop(state);
        let reopened = Arc::new(Mutex::new(AppState::open(dir.path()).unwrap()));
        let read = handle(
            reopened.clone(),
            "courseware.material.read",
            json!({"sessionId":session.id,"sourceId":first["sourceId"]}),
        )
        .await
        .unwrap();
        assert_eq!(read["text"], "P1: Hello 1.25 kg.");
        let listed = handle(
            reopened,
            "courseware.material.list",
            json!({"sessionId":session.id}),
        )
        .await
        .unwrap();
        assert_eq!(listed["sources"].as_array().unwrap().len(), 1);
        assert!(listed["sources"][0].get("text").is_none());
    }
}
