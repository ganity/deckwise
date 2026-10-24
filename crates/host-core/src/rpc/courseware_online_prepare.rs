//! Private, durable receipts for explicitly requested Owner online preparation.
use super::*;

const NAMESPACE: &str = "coursewareOnlinePrepare.v1";
const TASK_NAMESPACE: &str = "coursewareTask.v1";
const MAX_SOURCE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_SAFE_EPOCH: u64 = 9_007_199_254_740_990;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    UploadPending,
    Uploaded,
    StartPending,
    Started,
    Bound,
}

impl Phase {
    fn next(self) -> Option<Self> {
        match self {
            Self::UploadPending => Some(Self::Uploaded),
            Self::Uploaded => Some(Self::StartPending),
            Self::StartPending => Some(Self::Started),
            Self::Started => Some(Self::Bound),
            Self::Bound => None,
        }
    }
}

fn nullable_revision<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TeachingPins {
    project_id: String,
    teaching_revision: String,
    mapping_revision: String,
    payload_sha256: String,
}

impl TeachingPins {
    fn valid(&self) -> bool {
        [
            &self.project_id,
            &self.teaching_revision,
            &self.mapping_revision,
        ]
        .into_iter()
        .all(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id != "."
                && id != ".."
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        }) && hash(&self.payload_sha256)
    }
}

fn teaching_pins<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<TeachingPins>, D::Error> {
    TeachingPins::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Selection {
    project_id: String,
    request_id: String,
    expected_epoch: u64,
    #[serde(deserialize_with = "nullable_revision")]
    expected_source_revision: Option<String>,
    source_sha256: String,
    byte_length: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "teaching_pins"
    )]
    teaching: Option<TeachingPins>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    project_id: String,
    request_id: String,
    expected_epoch: u64,
    #[serde(deserialize_with = "nullable_revision")]
    expected_source_revision: Option<String>,
    source_sha256: String,
    byte_length: u64,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "teaching_pins"
    )]
    teaching: Option<TeachingPins>,
    phase: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    uploaded_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_epoch: Option<u64>,
}

impl Receipt {
    fn selection(&self) -> Selection {
        Selection {
            project_id: self.project_id.clone(),
            request_id: self.request_id.clone(),
            expected_epoch: self.expected_epoch,
            expected_source_revision: self.expected_source_revision.clone(),
            source_sha256: self.source_sha256.clone(),
            byte_length: self.byte_length,
            teaching: self.teaching.clone(),
        }
    }
}

impl From<Selection> for Receipt {
    fn from(selection: Selection) -> Self {
        Self {
            project_id: selection.project_id,
            request_id: selection.request_id,
            expected_epoch: selection.expected_epoch,
            expected_source_revision: selection.expected_source_revision,
            source_sha256: selection.source_sha256,
            byte_length: selection.byte_length,
            teaching: selection.teaching,
            phase: Phase::UploadPending,
            uploaded_revision: None,
            session_epoch: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GetParams {
    session_id: String,
    principal_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BeginParams {
    session_id: String,
    principal_key: String,
    selection: Selection,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdvanceParams {
    session_id: String,
    principal_key: String,
    request_id: String,
    expected_phase: Phase,
    phase: Phase,
    uploaded_revision: Option<String>,
    session_epoch: Option<u64>,
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.hyphenated().to_string() == value)
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_selection(selection: &Selection) -> bool {
    canonical_uuid(&selection.project_id)
        && canonical_uuid(&selection.request_id)
        && selection.expected_epoch <= MAX_SAFE_EPOCH
        && selection
            .expected_source_revision
            .as_deref()
            .is_none_or(canonical_uuid)
        && hash(&selection.source_sha256)
        && (1..=MAX_SOURCE_BYTES).contains(&selection.byte_length)
        && selection.teaching.as_ref().is_none_or(TeachingPins::valid)
}

fn invalid(error: impl ToString) -> JsonRpcError {
    rpc_err(1002, error.to_string(), "INVALID_PARAMS")
}

fn conflict(error: anyhow::Error) -> JsonRpcError {
    rpc_err(
        1008,
        error.to_string(),
        "COURSEWARE_ONLINE_PREPARE_CONFLICT",
    )
}

fn scope(state: &AppState, session: &str, principal: &str) -> Result<String, JsonRpcError> {
    if !canonical_uuid(session) || !hash(principal) {
        return Err(invalid("Invalid online preparation scope"));
    }
    let workspace = resolve_persisted_project_workspace(state, session)?
        .ok_or_else(|| invalid("A persisted project session is required"))?;
    serde_json::to_string(&(workspace, session, principal)).map_err(invalid)
}

fn load(db: &crate::db::Database, key: &str) -> anyhow::Result<Option<Receipt>> {
    let Some(value) = db.kv_get(NAMESPACE, key)? else {
        return Ok(None);
    };
    let receipt: Receipt = serde_json::from_value(value)?;
    anyhow::ensure!(
        valid_selection(&receipt.selection()),
        "Invalid stored online preparation selection"
    );
    let uploaded = receipt
        .uploaded_revision
        .as_deref()
        .is_some_and(canonical_uuid);
    let epoch = receipt.session_epoch == Some(receipt.expected_epoch + 1);
    anyhow::ensure!(
        match receipt.phase {
            Phase::UploadPending =>
                receipt.uploaded_revision.is_none() && receipt.session_epoch.is_none(),
            Phase::Uploaded | Phase::StartPending => uploaded && receipt.session_epoch.is_none(),
            Phase::Started | Phase::Bound => uploaded && epoch,
        },
        "Invalid stored online preparation phase"
    );
    Ok(Some(receipt))
}

fn task(db: &crate::db::Database, session: &str, project: &str) -> anyhow::Result<Value> {
    let task = db
        .kv_get(TASK_NAMESPACE, session)?
        .ok_or_else(|| anyhow!("Select a courseware task first"))?;
    anyhow::ensure!(
        matches!(
            task.get("taskType").and_then(Value::as_str),
            Some("plain" | "scene" | "import")
        ),
        "Invalid courseware task"
    );
    anyhow::ensure!(
        task.get("teamProjectId").is_none_or(|team| team == project),
        "Courseware task is already bound to another team project"
    );
    Ok(task)
}

fn store(db: &crate::db::Database, key: &str, receipt: &Receipt) -> anyhow::Result<Value> {
    let value = serde_json::to_value(receipt)?;
    db.kv_set(NAMESPACE, key, &value)?;
    Ok(value)
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "courseware.onlinePrepare.get" => {
            let p: GetParams = serde_json::from_value(params).map_err(invalid)?;
            let state = state.lock().await;
            let key = scope(&state, &p.session_id, &p.principal_key)?;
            let receipt = load(&state.db, &key).map_err(conflict)?;
            Ok(json!({ "receipt": receipt }))
        }
        "courseware.onlinePrepare.begin" => {
            let p: BeginParams = serde_json::from_value(params).map_err(invalid)?;
            if !valid_selection(&p.selection) {
                return Err(invalid("Invalid online preparation selection"));
            }
            let state = state.lock().await;
            let key = scope(&state, &p.session_id, &p.principal_key)?;
            (|| -> anyhow::Result<Value> {
                let tx = state.db.conn().unchecked_transaction()?;
                task(&state.db, &p.session_id, &p.selection.project_id)?;
                if let Some(current) = load(&state.db, &key)? {
                    if current.request_id == p.selection.request_id {
                        anyhow::ensure!(
                            current.selection() == p.selection,
                            "Online preparation selection changed"
                        );
                        tx.commit()?;
                        state.db.source_adoption_barrier()?;
                        return Ok(serde_json::to_value(current)?);
                    }
                    anyhow::ensure!(
                        current.phase == Phase::Bound,
                        "Online preparation result is unknown; recover the existing receipt first"
                    );
                }
                let receipt = Receipt::from(p.selection);
                let value = store(&state.db, &key, &receipt)?;
                tx.commit()?;
                state.db.source_adoption_barrier()?;
                Ok(value)
            })()
            .map_err(conflict)
        }
        "courseware.onlinePrepare.advance" => {
            let has_null = ["uploadedRevision", "sessionEpoch"]
                .iter()
                .any(|name| params.get(*name).is_some_and(Value::is_null));
            let p: AdvanceParams = serde_json::from_value(params).map_err(invalid)?;
            if has_null
                || !canonical_uuid(&p.request_id)
                || p.expected_phase.next() != Some(p.phase)
                || p.uploaded_revision
                    .as_deref()
                    .is_some_and(|id| !canonical_uuid(id))
                || p.session_epoch
                    .is_some_and(|epoch| epoch == 0 || epoch > MAX_SAFE_EPOCH + 1)
            {
                return Err(invalid("Invalid online preparation transition"));
            }
            let state = state.lock().await;
            let key = scope(&state, &p.session_id, &p.principal_key)?;
            (|| -> anyhow::Result<Value> {
                let tx = state.db.conn().unchecked_transaction()?;
                let mut current = load(&state.db, &key)?
                    .ok_or_else(|| anyhow!("Online preparation receipt not found"))?;
                anyhow::ensure!(
                    current.request_id == p.request_id,
                    "Online preparation request changed"
                );
                anyhow::ensure!(
                    current.phase == p.expected_phase || current.phase == p.phase,
                    "Online preparation phase changed"
                );
                let mut bound = task(&state.db, &p.session_id, &current.project_id)?;
                if p.phase == Phase::Uploaded {
                    let revision = p
                        .uploaded_revision
                        .as_ref()
                        .ok_or_else(|| anyhow!("Uploaded source revision is required"))?;
                    anyhow::ensure!(
                        current
                            .uploaded_revision
                            .as_ref()
                            .is_none_or(|saved| saved == revision),
                        "Uploaded source revision changed"
                    );
                    current.uploaded_revision = Some(revision.clone());
                } else {
                    anyhow::ensure!(
                        p.uploaded_revision
                            .as_ref()
                            .is_none_or(
                                |revision| current.uploaded_revision.as_ref() == Some(revision)
                            ),
                        "Uploaded source revision changed"
                    );
                }
                if p.phase == Phase::Started {
                    anyhow::ensure!(
                        p.session_epoch == Some(current.expected_epoch + 1),
                        "Started session epoch differs from expected epoch plus one"
                    );
                    current.session_epoch = p.session_epoch;
                } else {
                    anyhow::ensure!(
                        p.session_epoch
                            .is_none_or(|epoch| current.session_epoch == Some(epoch)),
                        "Session epoch changed or arrived before start"
                    );
                }
                current.phase = p.phase;
                if p.phase == Phase::Bound {
                    bound["teamProjectId"] = json!(current.project_id);
                    state.db.kv_set(TASK_NAMESPACE, &p.session_id, &bound)?;
                }
                let value = store(&state.db, &key, &current)?;
                tx.commit()?;
                state.db.source_adoption_barrier()?;
                Ok(value)
            })()
            .map_err(conflict)
        }
        _ => Err(invalid("Unknown online preparation method")),
    }
}

#[cfg(test)]
mod tests;
