use super::*;
use sha2::Digest;
use std::io::Read;

const NAMESPACE: &str = "coursewareScenePlans.v1";
const MAX_BYTES: u64 = 256 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApproveParams {
    session_id: String,
    sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Plan {
    pub(super) title: String,
    pub(super) pages: Vec<Page>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Page {
    pub(super) title: String,
    visible_text: Vec<String>,
    pub(super) visual_intent: String,
    pub(super) narration: String,
}

impl Page {
    pub(super) fn source_hash(&self) -> Result<String, JsonRpcError> {
        // Match Main's hash of the ordered {title,visibleText,visualIntent,narration} object.
        let bytes = serde_json::to_vec(self).map_err(|e| error(e.into()))?;
        Ok(format!(
            "sha256:{}",
            hex::encode(sha2::Sha256::digest(bytes))
        ))
    }
}

fn invalid(message: impl Into<String>) -> JsonRpcError {
    rpc_err(1002, message, "COURSEWARE_INVALID")
}

pub(super) fn key(root: &str, session_id: &str) -> Result<String, JsonRpcError> {
    let root = std::fs::canonicalize(root).map_err(|e| error(e.into()))?;
    serde_json::to_string(&(root, session_id)).map_err(|e| error(e.into()))
}

pub(super) fn has_approval(
    state: &AppState,
    root: &str,
    session_id: &str,
) -> Result<bool, JsonRpcError> {
    Ok(state
        .db
        .kv_get(NAMESPACE, &key(root, session_id)?)
        .map_err(error)?
        .is_some())
}

pub(super) fn read_plan(
    root: &str,
    session_id: &str,
    expected: &str,
) -> Result<Plan, JsonRpcError> {
    let root = std::fs::canonicalize(root).map_err(|e| error(e.into()))?;
    let path = root.join(format!(".deckwise-ppt/scenes/{session_id}/plan.json"));
    if std::fs::canonicalize(&path).map_err(|e| invalid(e.to_string()))? != path {
        return Err(invalid("Scene plan left its Chat directory"));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(&path).map_err(|e| invalid(e.to_string()))?;
    if !file
        .metadata()
        .map_err(|e| invalid(e.to_string()))?
        .is_file()
    {
        return Err(invalid("Scene plan must be a file"));
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        if std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
            .map_err(|e| invalid(e.to_string()))?
            != path
        {
            return Err(invalid("Scene plan location changed"));
        }
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| invalid(e.to_string()))?;
    if bytes.len() > MAX_BYTES as usize {
        return Err(invalid("Scene course plan exceeds limits"));
    }
    if hex::encode(sha2::Sha256::digest(&bytes)) != expected {
        return Err(rpc_err(
            1008,
            "Scene plan changed; review it again",
            "COURSEWARE_CONFLICT",
        ));
    }
    if std::fs::canonicalize(&path).map_err(|e| invalid(e.to_string()))? != path {
        return Err(invalid("Scene plan location changed"));
    }
    let plan: Plan = serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))?;
    let bounded =
        |text: &str, max: usize| !text.trim().is_empty() && text.encode_utf16().count() <= max;
    if !bounded(&plan.title, 200)
        || plan.pages.is_empty()
        || plan.pages.len() > 30
        || plan.pages.iter().any(|page| {
            !bounded(&page.title, 200)
                || !bounded(&page.visual_intent, 1000)
                || !bounded(&page.narration, 2500)
                || page.visible_text.len() > 6
                || page.visible_text.iter().any(|text| !bounded(text, 160))
        })
    {
        return Err(invalid("Invalid scene course plan"));
    }
    Ok(plan)
}

pub(super) fn approval(
    state: &AppState,
    root: &str,
    session_id: &str,
) -> Result<Option<Value>, JsonRpcError> {
    state
        .db
        .kv_get(NAMESPACE, &key(root, session_id)?)
        .map_err(error)
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let deserialize = |e: serde_json::Error| rpc_err(1002, e.to_string(), "INVALID_PARAMS");
    let (session_id, sha256) = if method == "courseware.scenePlan.approve" {
        let p: ApproveParams = serde_json::from_value(params).map_err(deserialize)?;
        if p.sha256.len() != 64
            || !p
                .sha256
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        {
            return Err(invalid("Invalid scene plan hash"));
        }
        (p.session_id, Some(p.sha256))
    } else {
        let p: TaskGetParams = serde_json::from_value(params).map_err(deserialize)?;
        (p.session_id, None)
    };
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err(invalid("Invalid scene course session"));
    }
    let state = state.lock().await;
    let root = project_workspace(&state, &session_id)?;
    let task = state
        .db
        .kv_get(TASK_NAMESPACE, &session_id)
        .map_err(error)?
        .ok_or_else(|| invalid("Select a scene task first"))?;
    if task["taskType"] != "scene" || (sha256.is_some() && task.get("generatedPath").is_some()) {
        return Err(invalid("Scene approval requires an ungenerated scene task"));
    }
    let key = key(&root, &session_id)?;
    let current = state.db.kv_get(NAMESPACE, &key).map_err(error)?;
    let Some(sha256) = sha256 else {
        return Ok(json!({"approval":current}));
    };
    let plan = read_plan(&root, &session_id, &sha256)?;
    let next = json!({"sha256":sha256, "plan":plan, "educationContext":task["educationContext"]});
    if current.as_ref() != Some(&next) {
        state.db.kv_set(NAMESPACE, &key, &next).map_err(error)?;
        if state.db.kv_get(NAMESPACE, &key).map_err(error)?.as_ref() != Some(&next) {
            return Err(rpc_err(1000, "Scene approval was not stored", "INTERNAL"));
        }
    }
    Ok(json!({"approval":next}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scene_plan_approval_pins_reviewed_bytes_and_survives_restart() {
        use sha2::Digest;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
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
                .kv_set(
                    TASK_NAMESPACE,
                    id,
                    &json!({"taskType":"scene", "educationContext":null}),
                )
                .unwrap();
        }
        let path = root.join(format!(".deckwise-ppt/scenes/{}/plan.json", session.id));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let plan = json!({"title":"Shapes", "pages":[{"title":"Circle", "visibleText":["Circle"],
            "visualIntent":"A round flower", "narration":"A circle. Good!"}]});
        let bytes = serde_json::to_vec(&plan).unwrap();
        let sha256 = hex::encode(sha2::Sha256::digest(&bytes));
        std::fs::write(&path, &bytes).unwrap();
        let state = Arc::new(Mutex::new(app));
        let (tx, _rx) = mpsc::unbounded_channel();
        let approve = json!({"sessionId":session.id, "sha256":sha256});
        let saved = crate::rpc::handle_request(
            state.clone(),
            "courseware.scenePlan.approve",
            approve.clone(),
            tx.clone(),
        )
        .await
        .unwrap();
        assert_eq!(saved["approval"]["sha256"], sha256);
        assert_eq!(saved["approval"]["plan"], plan);
        assert_eq!(
            crate::rpc::handle_request(
                state.clone(),
                "courseware.scenePlan.approve",
                approve.clone(),
                tx.clone()
            )
            .await
            .unwrap(),
            saved
        );
        assert_eq!(
            crate::rpc::handle_request(
                state.clone(),
                "courseware.scenePlan.get",
                json!({"sessionId":peer.id}),
                tx.clone()
            )
            .await
            .unwrap(),
            json!({"approval":null})
        );
        for change in [
            json!({"sessionId":session.id, "taskType":"plain"}),
            json!({"sessionId":session.id, "taskType":"scene", "educationContext":{"schoolStage":"kindergarten"}}),
        ] {
            assert_eq!(
                crate::rpc::handle_request(
                    state.clone(),
                    "courseware.task.set",
                    change,
                    tx.clone()
                )
                .await
                .unwrap_err()
                .code,
                1008
            );
        }
        crate::rpc::handle_request(
            state.clone(),
            "courseware.task.set",
            json!({"sessionId":session.id, "taskType":"scene"}),
            tx.clone(),
        )
        .await
        .unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({"title":"Changed", "pages":plan["pages"]})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            crate::rpc::handle_request(
                state.clone(),
                "courseware.scenePlan.approve",
                approve.clone(),
                tx.clone()
            )
            .await
            .unwrap_err()
            .code,
            1008
        );
        assert_eq!(
            crate::rpc::handle_request(
                state.clone(),
                "courseware.scenePlan.get",
                json!({"sessionId":session.id}),
                tx.clone()
            )
            .await
            .unwrap(),
            saved
        );
        drop(state);
        let mut reopened = AppState::open(dir.path()).unwrap();
        reopened.handshook = true;
        let state = Arc::new(Mutex::new(reopened));
        assert_eq!(
            crate::rpc::handle_request(
                state.clone(),
                "courseware.scenePlan.get",
                json!({"sessionId":session.id}),
                tx.clone()
            )
            .await
            .unwrap(),
            saved
        );
        let mut forged = approve;
        forged["path"] = json!(path);
        assert_eq!(
            crate::rpc::handle_request(state, "courseware.scenePlan.approve", forged, tx)
                .await
                .unwrap_err()
                .code,
            1002
        );
    }

    fn hash(bytes: &[u8]) -> String {
        hex::encode(sha2::Sha256::digest(bytes))
    }

    #[test]
    fn approval_revalidates_content_limits_and_unknown_fields() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(".deckwise-ppt/scenes/chat-a/plan.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let good = json!({"title":"Shapes", "pages":[{"title":"Circle", "visibleText":["Circle"],
            "visualIntent":"A flower", "narration":"Good!"}]});
        let mut variants = vec![json!({}), json!({"title":"Shapes", "pages":[]})];
        for (field, value) in [
            ("title", json!(" ")),
            ("path", json!("/outside")),
            ("pages", json!([{"title":"Missing fields"}])),
            ("title", json!("x".repeat(201))),
        ] {
            let mut changed = good.clone();
            changed[field] = value;
            variants.push(changed);
        }
        let mut emoji = good.clone();
        emoji["pages"][0]["narration"] = json!("😀".repeat(1251));
        variants.push(emoji);
        for variant in variants {
            let bytes = serde_json::to_vec(&variant).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            assert_eq!(
                read_plan(root.path().to_str().unwrap(), "chat-a", &hash(&bytes))
                    .unwrap_err()
                    .code,
                1002
            );
        }
        for bytes in [vec![b'x'; MAX_BYTES as usize + 1], vec![255], b"{".to_vec()] {
            std::fs::write(&path, &bytes).unwrap();
            assert!(read_plan(root.path().to_str().unwrap(), "chat-a", &hash(&bytes)).is_err());
        }
        let bytes = serde_json::to_vec(&good).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            read_plan(root.path().to_str().unwrap(), "chat-a", &hash(&bytes))
                .unwrap()
                .title,
            "Shapes"
        );
    }

    #[test]
    fn source_hash_matches_main_json_with_unicode_and_control_characters() {
        let page: Page = serde_json::from_value(
            json!({"title":"苹果与梨 😀", "visibleText":["Apple", "梨 <&>"],
            "visualIntent":"分层\n前景", "narration":"Good job! 苹果。"}),
        )
        .unwrap();
        assert_eq!(
            page.source_hash().unwrap(),
            "sha256:53189ad924861bd6c42e7112eb48effd735afc5abaeb573d78fa34623376a308"
        );
    }

    #[cfg(unix)]
    #[test]
    fn approval_rejects_cross_chat_and_directory_symlinks() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let peer = root.path().join(".deckwise-ppt/scenes/chat-b");
        let own = root.path().join(".deckwise-ppt/scenes/chat-a");
        std::fs::create_dir_all(&peer).unwrap();
        std::fs::create_dir(&own).unwrap();
        std::fs::write(peer.join("plan.json"), b"{}").unwrap();
        symlink(peer.join("plan.json"), own.join("plan.json")).unwrap();
        assert!(read_plan(root.path().to_str().unwrap(), "chat-a", &hash(b"{}")).is_err());
        std::fs::remove_dir_all(&own).unwrap();
        symlink(&peer, &own).unwrap();
        assert!(read_plan(root.path().to_str().unwrap(), "chat-a", &hash(b"{}")).is_err());
    }
}
