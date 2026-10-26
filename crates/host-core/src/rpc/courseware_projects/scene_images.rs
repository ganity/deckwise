use super::*;
use crate::db::courseware_projects::tts::{request_hash, Phase, RejectedRequest, Request, TaskRef};
use sha2::{Digest, Sha256};

pub(super) mod assets;

const NAMESPACE: &str = "coursewareSceneImages.v1";
const MAX_INTENTS: usize = 300;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scope {
    session_id: String,
    principal_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    session_id: String,
    principal_key: String,
    plan_sha256: String,
    page_id: String,
    model: String,
    #[serde(default)]
    target: Target,
    #[serde(default)]
    instructions: String,
    reference_intent_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Target {
    VisualMaster {},
    CleanPlate {},
    Layer { name: String },
}

impl Default for Target {
    fn default() -> Self {
        Self::VisualMaster {}
    }
}

impl Target {
    fn valid(&self) -> bool {
        match self {
            Self::Layer { name } => {
                !name.is_empty()
                    && name.encode_utf16().count() <= 80
                    && name.trim() == name
                    && !name.chars().any(char::is_control)
            }
            _ => true,
        }
    }

    fn prompt(&self) -> String {
        match self {
            Self::VisualMaster {} => "Create a clear classroom visual reference. No text, labels, letters or watermarks; slide text is added separately.".into(),
            Self::CleanPlate {} => "Create ONLY a clean, empty environment background for this page. Match the scene's art direction. Remove all teaching objects, characters, foreground props, text, labels, letters and watermarks; these will be added as separate editable objects. Do not render a complete slide.".into(),
            Self::Layer { name } => format!("Create ONLY the isolated foreground asset named {name:?}, in the scene's art direction. Transparent PNG background, visible isolated subject, no surrounding scene, floor, text, labels, letters or watermark. Do not render a complete slide; this asset will be placed as an independent editable object."),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation {
    session_id: String,
    principal_key: String,
    intent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Bind {
    session_id: String,
    principal_key: String,
    intent_id: String,
    task_ref: TaskRef,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reject {
    session_id: String,
    principal_key: String,
    intent_id: String,
    rejected_request: RejectedRequest,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ImageRequest {
    pub(super) kind: String,
    pub(super) model: String,
    pub(super) input: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) reference_image: Option<ReferenceImage>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReferenceImage {
    pub(super) sha256: String,
    pub(super) mime_type: String,
    pub(super) byte_length: usize,
}

impl ReferenceImage {
    pub(super) fn valid(&self) -> bool {
        valid_hash(&self.sha256)
            && matches!(self.mime_type.as_str(), "image/png" | "image/jpeg")
            && (1..=8 * 1024 * 1024).contains(&self.byte_length)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    intent_id: String,
    plan_sha256: String,
    page_id: String,
    #[serde(default)]
    target: Target,
    request: ImageRequest,
    idempotency_key: String,
    request_hash: String,
    phase: Phase,
    task_ref: Option<TaskRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    submission_scope: Option<crate::db::courseware_projects::media_scope::SubmissionScope>,
    #[serde(default)]
    asset: Option<assets::ImageAsset>,
    #[serde(default)]
    selected: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reference_intent_id: Option<String>,
}

fn invalid(message: &str) -> JsonRpcError {
    rpc_err(1002, message, "COURSEWARE_INVALID")
}

fn conflict(message: &str) -> JsonRpcError {
    rpc_err(1008, message, "COURSEWARE_CONFLICT")
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

impl ImageRequest {
    pub(super) fn hash(&self) -> String {
        let plain = Request {
            kind: self.kind.clone(),
            model: self.model.clone(),
            input: self.input.clone(),
            voice: None,
        };
        let Some(reference) = &self.reference_image else {
            return request_hash(&plain);
        };
        let mut canonical = "courseware-media-v1".to_owned();
        for field in [
            Some(self.kind.as_str()),
            Some(self.model.as_str()),
            Some(self.input.as_str()),
            None,
            Some(reference.sha256.as_str()),
            Some(reference.mime_type.as_str()),
            Some(&reference.byte_length.to_string()),
        ] {
            match field {
                Some(value) => {
                    canonical.push_str(&format!(":{}:{}", value.encode_utf16().count(), value))
                }
                None => canonical.push_str(":-1:"),
            }
        }
        hex::encode(Sha256::digest(canonical.as_bytes()))
    }
}

impl Intent {
    fn validate(&self) -> Result<(), JsonRpcError> {
        if self.phase == Phase::Rejected
            && !self
                .submission_scope
                .as_ref()
                .is_some_and(|scope| scope.team_project_id.is_some())
        {
            return Err(invalid("Rejected request has no team scope"));
        }
        if !valid_id(&self.intent_id)
            || !valid_hash(&self.plan_sha256)
            || !valid_id(&self.page_id)
            || !self.target.valid()
            || self.request.kind != "image"
            || !valid_id(&self.request.model)
            || self.request.input.trim().is_empty()
            || self.request.input.encode_utf16().count() > 4000
            || self
                .request
                .reference_image
                .as_ref()
                .is_some_and(|r| !r.valid())
            || self.request.reference_image.is_some() != self.reference_intent_id.is_some()
            || self
                .reference_intent_id
                .as_ref()
                .is_some_and(|id| !valid_id(id))
            || (self.reference_intent_id.is_some()
                && matches!(self.target, Target::VisualMaster {}))
            || uuid::Uuid::parse_str(&self.idempotency_key).is_err()
            || self.request_hash != self.request.hash()
            || (self.phase == Phase::Submitted) != self.task_ref.is_some()
            || self
                .submission_scope
                .as_ref()
                .is_some_and(|scope| !scope.valid() || self.phase == Phase::Prepared)
            || self.task_ref.as_ref().is_some_and(|task| {
                !valid_id(&task.task_id)
                    || task.idempotency_key != self.idempotency_key
                    || task.request_hash != self.request_hash
            })
            || self.asset.as_ref().is_some_and(|asset| {
                !asset.valid() || self.task_ref.as_ref() != Some(&asset.task_ref)
            })
            || (self.selected && self.asset.is_none())
        {
            return Err(invalid("Invalid stored scene image intent"));
        }
        Ok(())
    }

    fn view(&self, current: Option<&str>) -> Value {
        json!({"intent":self,"current":current == Some(self.plan_sha256.as_str())})
    }
}

fn selected_reference<'a>(
    intents: &'a [Intent],
    plan: &str,
    page: &str,
    id: &str,
) -> Result<&'a assets::ImageAsset, JsonRpcError> {
    intents
        .iter()
        .find(|i| {
            i.intent_id == id
                && i.plan_sha256 == plan
                && i.page_id == page
                && i.selected
                && matches!(i.target, Target::VisualMaster {})
        })
        .and_then(|i| i.asset.as_ref())
        .filter(|a| matches!(a.mime_type.as_str(), "image/png" | "image/jpeg"))
        .ok_or_else(|| conflict("Selected reviewed reference image changed or is unsupported"))
}

/// Canvas references pin an owned archive, independently of later scene selection.
pub(super) fn canvas_reference(
    state: &AppState,
    root: &str,
    session_id: &str,
    principal_key: &str,
    intent_id: &str,
    sha256: &str,
) -> Result<(ReferenceImage, std::path::PathBuf, Value), JsonRpcError> {
    let key = storage_key(
        root,
        &Scope {
            session_id: session_id.into(),
            principal_key: principal_key.into(),
        },
    )?;
    let intents = load(state, &key)?;
    let asset = intents
        .iter()
        .find(|i| i.intent_id == intent_id)
        .and_then(|i| i.asset.as_ref())
        .filter(|asset| {
            asset.sha256 == sha256 && matches!(asset.mime_type.as_str(), "image/png" | "image/jpeg")
        })
        .ok_or_else(|| invalid("Canvas reference must be an owned archived PNG or JPEG"))?;
    let (path, length) = crate::courseware::snapshot_assets::verify(&state.data_dir, &asset.sha256)
        .map_err(error)?;
    if length != asset.byte_length as u64 {
        return Err(invalid("Canvas reference length changed"));
    }
    Ok((
        ReferenceImage {
            sha256: asset.sha256.clone(),
            mime_type: asset.mime_type.clone(),
            byte_length: asset.byte_length,
        },
        path,
        serde_json::to_value(asset).map_err(|e| error(e.into()))?,
    ))
}

fn verify_reference(intents: &[Intent], intent: &Intent) -> Result<(), JsonRpcError> {
    if let (Some(id), Some(reference)) =
        (&intent.reference_intent_id, &intent.request.reference_image)
    {
        let asset = selected_reference(intents, &intent.plan_sha256, &intent.page_id, id)?;
        if asset.sha256 != reference.sha256
            || asset.mime_type != reference.mime_type
            || asset.byte_length != reference.byte_length
        {
            return Err(conflict("Selected reviewed reference image changed"));
        }
    }
    Ok(())
}

fn current_plan(state: &AppState, root: &str, scope: &Scope) -> Option<String> {
    let task = state.db.kv_get(TASK_NAMESPACE, &scope.session_id).ok()??;
    if task["taskType"] != "scene" || task.get("generatedPath").is_some() {
        return None;
    }
    let approval = scene_plan::approval(state, root, &scope.session_id).ok()??;
    let sha256 = approval["sha256"].as_str()?;
    scene_plan::read_plan(root, &scope.session_id, sha256).ok()?;
    Some(sha256.to_owned())
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct GenerationProof {
    plan_sha256: String,
    principal_key: String,
    selected_intent_ids: Vec<String>,
}

/// Recheck the exact reviewed inputs under the same Host lock as project initialization/attachment.
pub(super) fn verify_generation(
    state: &AppState,
    root: &str,
    session_id: &str,
    proof: &GenerationProof,
) -> Result<scene_plan::Plan, JsonRpcError> {
    let scope = Scope {
        session_id: session_id.into(),
        principal_key: proof.principal_key.clone(),
    };
    let key = storage_key(root, &scope)?;
    if !valid_hash(&proof.plan_sha256)
        || current_plan(state, root, &scope).as_deref() != Some(&proof.plan_sha256)
        || proof.selected_intent_ids.is_empty()
        || proof.selected_intent_ids.len() > MAX_INTENTS
    {
        return Err(conflict("Reviewed scene generation inputs changed"));
    }
    let plan = scene_plan::read_plan(root, session_id, &proof.plan_sha256)?;
    let intents = load(state, &key)?;
    let selected: Vec<_> = intents
        .iter()
        .filter(|i| i.selected && i.plan_sha256 == proof.plan_sha256)
        .collect();
    let expected: std::collections::HashSet<_> = proof.selected_intent_ids.iter().collect();
    let actual: std::collections::HashSet<_> = selected.iter().map(|i| &i.intent_id).collect();
    if expected.len() != proof.selected_intent_ids.len() || expected != actual {
        return Err(conflict("Reviewed scene asset selection changed"));
    }
    let pages: std::collections::HashSet<_> = (1..=plan.pages.len())
        .map(|index| format!("scene-{index:03}"))
        .collect();
    for page_id in &pages {
        let assets: Vec<_> = selected.iter().filter(|i| &i.page_id == page_id).collect();
        let master = assets
            .iter()
            .find(|i| matches!(i.target, Target::VisualMaster {}));
        let clean = assets
            .iter()
            .find(|i| matches!(i.target, Target::CleanPlate {}));
        if master.is_none()
            || clean.is_none()
            || !assets
                .iter()
                .any(|i| matches!(i.target, Target::Layer { .. }))
            || master.and_then(|i| i.asset.as_ref()).map(|a| &a.sha256)
                == clean.and_then(|i| i.asset.as_ref()).map(|a| &a.sha256)
        {
            return Err(conflict("Each scene page needs separate reviewed reference, background and foreground assets"));
        }
    }
    for intent in selected {
        if !pages.contains(&intent.page_id) {
            return Err(invalid("Selected scene asset has an unknown page"));
        }
        let asset = intent
            .asset
            .as_ref()
            .ok_or_else(|| invalid("Selected scene asset is not archived"))?;
        let (_, length) =
            crate::courseware::snapshot_assets::verify(&state.data_dir, &asset.sha256)
                .map_err(error)?;
        if length != asset.byte_length as u64 {
            return Err(conflict("Selected scene asset length changed"));
        }
    }
    Ok(plan)
}

fn storage_key(root: &str, scope: &Scope) -> Result<String, JsonRpcError> {
    if !valid_hash(&scope.principal_key)
        || scope.session_id.is_empty()
        || scope.session_id.len() > 128
        || !scope
            .session_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err(invalid("Invalid scene image scope"));
    }
    let root = std::fs::canonicalize(root).map_err(|e| error(e.into()))?;
    serde_json::to_string(&(root, &scope.session_id, &scope.principal_key))
        .map_err(|e| error(e.into()))
}

fn load(state: &AppState, key: &str) -> Result<Vec<Intent>, JsonRpcError> {
    let Some(value) = state.db.kv_get(NAMESPACE, key).map_err(error)? else {
        return Ok(Vec::new());
    };
    let intents: Vec<Intent> =
        serde_json::from_value(value).map_err(|_| invalid("Invalid scene image journal"))?;
    if intents.len() > MAX_INTENTS {
        return Err(invalid("Scene image journal exceeds limits"));
    }
    let mut ids = std::collections::HashSet::new();
    let mut selected = std::collections::HashSet::new();
    for intent in &intents {
        intent.validate()?;
        if !ids.insert(&intent.intent_id) {
            return Err(invalid("Duplicate scene image intent"));
        }
        if intent.selected
            && !selected.insert((&intent.plan_sha256, &intent.page_id, &intent.target))
        {
            return Err(invalid("Duplicate selected scene image"));
        }
    }
    Ok(intents)
}

fn save(state: &AppState, key: &str, intents: &[Intent]) -> Result<(), JsonRpcError> {
    let value = serde_json::to_value(intents).map_err(|e| error(e.into()))?;
    state.db.kv_set(NAMESPACE, key, &value).map_err(error)?;
    if state.db.kv_get(NAMESPACE, key).map_err(error)?.as_ref() != Some(&value) {
        return Err(conflict("Scene image intent was not stored"));
    }
    // The paid request must follow the same checked WAL barrier as TTS.
    state.db.source_adoption_barrier().map_err(error)
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    if matches!(
        method,
        "courseware.sceneImage.asset.stage"
            | "courseware.sceneImage.asset.get"
            | "courseware.sceneImage.asset.adopt"
    ) {
        return assets::handle(state, method, params).await;
    }
    let decode = |e: serde_json::Error| rpc_err(1002, e.to_string(), "INVALID_PARAMS");
    let (scope, prepare, operation, binding, rejection) = match method {
        "courseware.sceneImage.prepare" => {
            let p: Prepare = serde_json::from_value(params).map_err(decode)?;
            (
                Scope {
                    session_id: p.session_id.clone(),
                    principal_key: p.principal_key.clone(),
                },
                Some(p),
                None,
                None,
                None,
            )
        }
        "courseware.sceneImage.list" => (
            serde_json::from_value::<Scope>(params).map_err(decode)?,
            None,
            None,
            None,
            None,
        ),
        "courseware.sceneImage.get" | "courseware.sceneImage.begin" => {
            let p: Operation = serde_json::from_value(params).map_err(decode)?;
            (
                Scope {
                    session_id: p.session_id,
                    principal_key: p.principal_key,
                },
                None,
                Some(p.intent_id),
                None,
                None,
            )
        }
        "courseware.sceneImage.bind" => {
            let p: Bind = serde_json::from_value(params).map_err(decode)?;
            (
                Scope {
                    session_id: p.session_id,
                    principal_key: p.principal_key,
                },
                None,
                Some(p.intent_id),
                Some(p.task_ref),
                None,
            )
        }
        "courseware.sceneImage.reject" => {
            let p: Reject = serde_json::from_value(params).map_err(decode)?;
            (
                Scope {
                    session_id: p.session_id,
                    principal_key: p.principal_key,
                },
                None,
                Some(p.intent_id),
                None,
                Some(p.rejected_request),
            )
        }
        _ => return Err(rpc_err(-32601, "Method not found", "METHOD_NOT_FOUND")),
    };
    let state = state.lock().await;
    let root = project_workspace(&state, &scope.session_id)?;
    let key = storage_key(&root, &scope)?;
    let mut intents = load(&state, &key)?;
    let current = current_plan(&state, &root, &scope);
    if let Some(p) = prepare {
        if !valid_hash(&p.plan_sha256)
            || !valid_id(&p.model)
            || current.as_deref() != Some(&p.plan_sha256)
        {
            return Err(conflict("Review and confirm the current scene plan first"));
        }
        let plan = scene_plan::read_plan(&root, &scope.session_id, &p.plan_sha256)?;
        let page = p
            .page_id
            .strip_prefix("scene-")
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|n| p.page_id == format!("scene-{n:03}") && *n > 0)
            .and_then(|n| plan.pages.get(n - 1))
            .ok_or_else(|| invalid("Invalid scene image page"))?;
        if !p.target.valid()
            || p.instructions.encode_utf16().count() > 1200
            || p.instructions
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t')
        {
            return Err(invalid("Invalid scene image target or instructions"));
        }
        let mut prompt = format!(
            "Lesson: {}. Page: {}.\n{}\n{}",
            plan.title,
            page.title,
            page.visual_intent,
            p.target.prompt()
        );
        if !p.instructions.trim().is_empty() {
            prompt.push_str(&format!(
                "\nAdditional requirements: {}",
                p.instructions.trim()
            ));
        }
        let request = ImageRequest {
            kind: "image".into(),
            model: p.model,
            input: prompt,
            reference_image: if let Some(id) = &p.reference_intent_id {
                if matches!(p.target, Target::VisualMaster {}) {
                    return Err(invalid("A visual master cannot reference itself"));
                }
                let asset = selected_reference(&intents, &p.plan_sha256, &p.page_id, id)?;
                Some(ReferenceImage {
                    sha256: asset.sha256.clone(),
                    mime_type: asset.mime_type.clone(),
                    byte_length: asset.byte_length,
                })
            } else {
                None
            },
        };
        if let Some(existing) = intents.iter().find(|i| {
            i.phase != Phase::Rejected
                && i.plan_sha256 == p.plan_sha256
                && i.page_id == p.page_id
                && i.target == p.target
                && i.request_hash == request.hash()
                && i.reference_intent_id == p.reference_intent_id
        }) {
            return Ok(existing.view(current.as_deref()));
        }
        if intents.len() >= MAX_INTENTS {
            return Err(conflict("Scene image journal is full"));
        }
        let intent = Intent {
            intent_id: uuid::Uuid::new_v4().to_string(),
            plan_sha256: p.plan_sha256,
            page_id: p.page_id,
            target: p.target,
            request_hash: request.hash(),
            request,
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            phase: Phase::Prepared,
            task_ref: None,
            submission_scope: None,
            asset: None,
            selected: false,
            reference_intent_id: p.reference_intent_id,
        };
        intent.validate()?;
        let result = intent.view(current.as_deref());
        intents.push(intent);
        save(&state, &key, &intents)?;
        return Ok(result);
    }
    let Some(intent_id) = operation else {
        return Ok(
            json!({"intents":intents.iter().map(|i| i.view(current.as_deref())).collect::<Vec<_>>()}),
        );
    };
    if !valid_id(&intent_id) {
        return Err(invalid("Invalid scene image intent id"));
    }
    let index = intents
        .iter()
        .position(|i| i.intent_id == intent_id)
        .ok_or_else(|| rpc_err(1007, "Scene image intent not found", "COURSEWARE_NOT_FOUND"))?;
    if method == "courseware.sceneImage.begin" {
        verify_reference(&intents, &intents[index])?;
    }
    let intent = &mut intents[index];
    if method == "courseware.sceneImage.begin" {
        if current.as_deref() != Some(&intent.plan_sha256) || intent.phase != Phase::Prepared {
            return Err(conflict(
                "Scene image intent is stale or already begun; query its retained task",
            ));
        }
        intent.submission_scope = Some(
            state
                .db
                .courseware_media_submission_scope(&scope.session_id)
                .map_err(error)?,
        );
        intent.phase = Phase::SubmissionUnknown;
    } else if let Some(rejected) = rejection {
        if intent.phase != Phase::SubmissionUnknown
            || intent.task_ref.is_some()
            || intent.idempotency_key != rejected.idempotency_key
            || intent.request_hash != rejected.request_hash
            || !intent
                .submission_scope
                .as_ref()
                .is_some_and(|scope| scope.team_project_id.is_some())
        {
            return Err(conflict("No matching unbound team submission"));
        }
        intent.phase = Phase::Rejected;
        intent.validate()?;
    } else if let Some(task) = binding {
        if !matches!(intent.phase, Phase::SubmissionUnknown | Phase::Submitted)
            || intent.task_ref.as_ref().is_some_and(|old| old != &task)
        {
            return Err(conflict(
                "Scene image receipt cannot replace the retained request",
            ));
        }
        if intent.task_ref.as_ref() == Some(&task) {
            return Ok(intent.view(current.as_deref()));
        }
        intent.task_ref = Some(task);
        intent.phase = Phase::Submitted;
        intent.validate()?;
    }
    let result = intent.view(current.as_deref());
    if method != "courseware.sceneImage.get" {
        save(&state, &key, &intents)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
