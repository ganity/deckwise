use super::super::scene_images::assets::ImageAsset;
use super::super::scene_images::{
    canvas_reference as scene_reference, ImageRequest, ReferenceImage,
};
use super::*;
use crate::db::courseware_projects::tts::{Phase, RejectedRequest, TaskRef};

mod assets;

const JOURNAL: &str = "coursewareMediaCanvasImages.v1";
const MAX_INTENTS: usize = 300;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    session_id: String,
    principal_key: String,
    intent_id: Option<String>,
    expected_revision: Option<String>,
    draft_id: Option<String>,
    expected_draft_revision: Option<u64>,
    model: Option<String>,
    task_ref: Option<TaskRef>,
    asset: Option<ImageAsset>,
    bytes_base64: Option<String>,
    rejected_request: Option<RejectedRequest>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    intent_id: String,
    draft: Draft,
    request: ImageRequest,
    idempotency_key: String,
    request_hash: String,
    phase: Phase,
    task_ref: Option<TaskRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    submission_scope: Option<crate::db::courseware_projects::media_scope::SubmissionScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    asset: Option<ImageAsset>,
}

fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

impl Intent {
    fn validate(&self) -> Result<(), JsonRpcError> {
        if self.phase == Phase::Rejected && !self.submission_scope.as_ref().is_some_and(|scope| scope.team_project_id.is_some()) {
            return Err(invalid("Rejected request has no team scope"));
        }
        let sample = Document {
            version: 1,
            project_id: "validation".into(),
            revision: 0,
            viewport: Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 1.0,
            },
            drafts: vec![self.draft.clone()],
        };
        super::validate(&sample, "validation")?;
        if !id(&self.intent_id)
            || self.draft.kind != "image"
            || self.draft.references.len() > 1
            || self.request.kind != "image"
            || !id(&self.request.model)
            || self.request.input != self.draft.prompt
            || self.request.input.trim().is_empty()
            || self.request.input.encode_utf16().count() > 4000
            || self.request.reference_image.is_some() != !self.draft.references.is_empty()
            || self
                .request
                .reference_image
                .as_ref()
                .is_some_and(|reference| {
                    !reference.valid() || self.draft.references[0].revision != reference.sha256
                })
            || uuid::Uuid::parse_str(&self.idempotency_key).is_err()
            || self.request_hash != self.request.hash()
            || (self.phase == Phase::Submitted) != self.task_ref.is_some()
            || self.submission_scope.as_ref().is_some_and(|scope| {
                !scope.valid() || self.phase == Phase::Prepared
            })
            || self.task_ref.as_ref().is_some_and(|task| {
                !id(&task.task_id)
                    || task.idempotency_key != self.idempotency_key
                    || task.request_hash != self.request_hash
            })
            || self.asset.as_ref().is_some_and(|asset| {
                !asset.valid()
                    || self.phase != Phase::Submitted
                    || self.task_ref.as_ref() != Some(&asset.task_ref)
            })
        {
            return Err(invalid("Invalid saved canvas image intent"));
        }
        Ok(())
    }

    fn current(&self, canvas: Option<&Stored>) -> bool {
        canvas
            .and_then(|canvas| {
                canvas
                    .document
                    .drafts
                    .iter()
                    .find(|draft| draft.id == self.draft.id)
            })
            .is_some_and(|draft| {
                draft.revision == self.draft.revision
                    && draft.kind == self.draft.kind
                    && draft.prompt == self.draft.prompt
                    && draft.title == self.draft.title
                    && serde_json::to_value(&draft.references).ok()
                        == serde_json::to_value(&self.draft.references).ok()
            })
    }

    fn view(&self, canvas: Option<&Stored>) -> Value {
        json!({ "intent": self, "current": self.current(canvas) })
    }
}

fn load(state: &AppState, key: &str) -> Result<Vec<Intent>, JsonRpcError> {
    let Some(value) = state.db.kv_get(JOURNAL, key).map_err(error)? else {
        return Ok(Vec::new());
    };
    let intents: Vec<Intent> =
        serde_json::from_value(value).map_err(|_| invalid("Invalid canvas image journal"))?;
    if intents.len() > MAX_INTENTS {
        return Err(invalid("Canvas image journal exceeds limits"));
    }
    let mut ids = std::collections::HashSet::new();
    let mut keys = std::collections::HashSet::new();
    for intent in &intents {
        intent.validate()?;
        if !ids.insert(&intent.intent_id) || !keys.insert(&intent.idempotency_key) {
            return Err(invalid("Duplicate canvas image intent"));
        }
    }
    Ok(intents)
}

fn canvas_reference(
    state: &AppState,
    root: &str,
    session_id: &str,
    principal_key: &str,
    asset_id: &str,
    sha256: &str,
) -> Result<(ReferenceImage, std::path::PathBuf, Value), JsonRpcError> {
    if let Some(intent_id) = asset_id.strip_prefix("canvas-image:") {
        if !id(intent_id) || !hash(sha256) {
            return Err(invalid("Invalid canvas image reference"));
        }
        let key = serde_json::to_string(&(root, session_id, principal_key))
            .map_err(|e| error(e.into()))?;
        let intents = load(state, &key)?;
        let intent = intents
            .iter()
            .find(|intent| intent.intent_id == intent_id)
            .ok_or_else(|| invalid("Canvas reference must be an owned archived PNG or JPEG"))?;
        return assets::reference(state, intent, sha256);
    }
    scene_reference(state, root, session_id, principal_key, asset_id, sha256)
}

fn save(state: &AppState, key: &str, intents: &[Intent]) -> Result<(), JsonRpcError> {
    let value = serde_json::to_value(intents).map_err(|e| error(e.into()))?;
    state.db.kv_set(JOURNAL, key, &value).map_err(error)?;
    if state.db.kv_get(JOURNAL, key).map_err(error)?.as_ref() != Some(&value) {
        return Err(invalid("Canvas image intent was not stored"));
    }
    state.db.source_adoption_barrier().map_err(error)
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let mut fields = vec!["sessionId", "principalKey"];
    match method {
        "courseware.mediaCanvas.image.prepare" => fields.extend([
            "intentId",
            "expectedRevision",
            "draftId",
            "expectedDraftRevision",
            "model",
        ]),
        "courseware.mediaCanvas.image.list" => {}
        "courseware.mediaCanvas.image.get"
        | "courseware.mediaCanvas.image.begin"
        | "courseware.mediaCanvas.image.reference"
        | "courseware.mediaCanvas.image.asset.get" => fields.push("intentId"),
        "courseware.mediaCanvas.image.bind" => fields.extend(["intentId", "taskRef"]),
        "courseware.mediaCanvas.image.reject" => fields.extend(["intentId", "rejectedRequest"]),
        "courseware.mediaCanvas.image.asset.stage" | "courseware.mediaCanvas.image.asset.restore" => {
            fields.extend(["intentId", "asset", "bytesBase64"])
        }
        _ => return Err(invalid("Unsupported canvas image operation")),
    }
    if !params.as_object().is_some_and(|object| {
        object.len() == fields.len()
            && fields
                .iter()
                .all(|field| object.get(*field).is_some_and(|value| !value.is_null()))
    }) {
        return Err(invalid("Invalid canvas image parameters"));
    }
    let p: Params =
        serde_json::from_value(params).map_err(|_| invalid("Invalid canvas image parameters"))?;
    if !id(&p.session_id) || !hash(&p.principal_key) {
        return Err(invalid("Invalid canvas image scope"));
    }
    let state = state.lock().await;
    let root = project_workspace(&state, &p.session_id)?;
    let root = std::fs::canonicalize(root).map_err(|e| error(e.into()))?;
    let root_text = root
        .to_str()
        .ok_or_else(|| invalid("Invalid workspace encoding"))?;
    let project_id = format!("canvas:{}", p.session_id);
    let canvas_key =
        serde_json::to_string(&(&root, &p.session_id, &project_id)).map_err(|e| error(e.into()))?;
    let key = serde_json::to_string(&(&root, &p.session_id, &p.principal_key))
        .map_err(|e| error(e.into()))?;
    let canvas = super::load(&state, &canvas_key, &project_id)?;
    let mut intents = load(&state, &key)?;
    if method == "courseware.mediaCanvas.image.list" {
        return Ok(
            json!({ "intents": intents.iter().map(|intent| intent.view(canvas.as_ref())).collect::<Vec<_>>() }),
        );
    }
    let intent_id = p
        .intent_id
        .as_deref()
        .filter(|value| id(value))
        .ok_or_else(|| invalid("Invalid canvas intent ID"))?;
    if matches!(
        method,
        "courseware.mediaCanvas.image.prepare" | "courseware.mediaCanvas.image.begin"
    ) {
        if crate::sessions::session_mode(&state.db, &p.session_id)
            .map_err(error)?
            .as_deref()
            != Some("agent")
        {
            return Err(rpc_err(
                1003,
                "Canvas generation requires Agent mode",
                "PERMISSION_DENIED",
            ));
        }
        if !state
            .db
            .kv_get(TASK_NAMESPACE, &p.session_id)
            .map_err(error)?
            .and_then(|task| task["taskType"].as_str().map(str::to_owned))
            .is_some_and(|kind| ["plain", "scene", "import"].contains(&kind.as_str()))
        {
            return Err(invalid("Select a courseware task before generating images"));
        }
    }
    if method == "courseware.mediaCanvas.image.prepare" {
        let canvas = canvas.as_ref().ok_or_else(conflict)?;
        let draft = canvas
            .document
            .drafts
            .iter()
            .find(|draft| Some(&draft.id) == p.draft_id.as_ref())
            .ok_or_else(conflict)?;
        if Some(&canvas.revision) != p.expected_revision.as_ref()
            || Some(draft.revision) != p.expected_draft_revision
        {
            return Err(conflict());
        }
        if draft.kind != "image"
            || draft.references.len() > 1
            || draft.prompt.trim().is_empty()
            || draft.prompt.encode_utf16().count() > 4000
        {
            return Err(invalid("Image generation requires a nonempty prompt up to 4000 characters and at most one reference"));
        }
        let model = p
            .model
            .filter(|model| id(model))
            .ok_or_else(|| invalid("Invalid image model"))?;
        let request = ImageRequest {
            kind: "image".into(),
            model,
            input: draft.prompt.clone(),
            reference_image: draft
                .references
                .first()
                .map(|reference| {
                    canvas_reference(
                        &state,
                        root_text,
                        &p.session_id,
                        &p.principal_key,
                        &reference.asset_id,
                        &reference.revision,
                    )
                    .map(|(reference, _, _)| reference)
                })
                .transpose()?,
        };
        if let Some(existing) = intents.iter().find(|intent| intent.intent_id == intent_id) {
            if existing.draft.id != draft.id
                || existing.draft.revision != draft.revision
                || existing.request_hash != request.hash()
                || !existing.current(Some(canvas))
            {
                return Err(conflict());
            }
            return Ok(existing.view(Some(canvas)));
        }
        if intents.len() >= MAX_INTENTS {
            return Err(invalid("Canvas image journal is full"));
        }
        let intent = Intent {
            intent_id: intent_id.into(),
            draft: draft.clone(),
            request_hash: request.hash(),
            request,
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            phase: Phase::Prepared,
            task_ref: None,
            submission_scope: None,
            asset: None,
        };
        intent.validate()?;
        let view = intent.view(Some(canvas));
        intents.push(intent);
        save(&state, &key, &intents)?;
        return Ok(view);
    }
    let index = intents
        .iter()
        .position(|intent| intent.intent_id == intent_id)
        .ok_or_else(|| {
            rpc_err(
                1007,
                "Canvas image intent not found",
                "COURSEWARE_NOT_FOUND",
            )
        })?;
    if matches!(method, "courseware.mediaCanvas.image.asset.stage" | "courseware.mediaCanvas.image.asset.restore") {
        assets::stage(
            &state,
            &mut intents[index],
            p.asset.ok_or_else(|| invalid("Image asset is required"))?,
            &p.bytes_base64
                .ok_or_else(|| invalid("Image bytes are required"))?,
            method == "courseware.mediaCanvas.image.asset.restore",
        )?;
        save(&state, &key, &intents)?;
        return assets::files(&state, &intents[index], canvas.as_ref());
    }
    if method == "courseware.mediaCanvas.image.asset.get" {
        return assets::files(&state, &intents[index], canvas.as_ref());
    }
    let intent = &mut intents[index];
    if method == "courseware.mediaCanvas.image.reference" {
        let reference = intent
            .draft
            .references
            .first()
            .ok_or_else(|| invalid("Image intent has no reference"))?;
        let (actual, path, asset) = canvas_reference(
            &state,
            root_text,
            &p.session_id,
            &p.principal_key,
            &reference.asset_id,
            &reference.revision,
        )?;
        if intent.request.reference_image.as_ref() != Some(&actual) {
            return Err(conflict());
        }
        return Ok(json!({ "path": path, "reference": actual, "asset": asset }));
    }
    if method == "courseware.mediaCanvas.image.begin" {
        if !intent.current(canvas.as_ref()) || intent.phase != Phase::Prepared {
            return Err(conflict());
        }
        if let Some(reference) = intent.draft.references.first() {
            canvas_reference(
                &state,
                root_text,
                &p.session_id,
                &p.principal_key,
                &reference.asset_id,
                &reference.revision,
            )?;
        }
        intent.submission_scope = Some(
            state.db.courseware_media_submission_scope(&p.session_id).map_err(error)?,
        );
        intent.phase = Phase::SubmissionUnknown;
    } else if method == "courseware.mediaCanvas.image.reject" {
        let rejected = p.rejected_request.ok_or_else(|| invalid("Missing rejected request"))?;
        if intent.phase != Phase::SubmissionUnknown || intent.task_ref.is_some()
            || intent.idempotency_key != rejected.idempotency_key || intent.request_hash != rejected.request_hash
            || !intent.submission_scope.as_ref().is_some_and(|scope| scope.team_project_id.is_some()) {
            return Err(conflict());
        }
        intent.phase = Phase::Rejected;
        intent.validate()?;
    } else if let Some(task) = p.task_ref {
        if !matches!(intent.phase, Phase::SubmissionUnknown | Phase::Submitted)
            || intent.task_ref.as_ref().is_some_and(|old| old != &task)
        {
            return Err(conflict());
        }
        intent.task_ref = Some(task);
        intent.phase = Phase::Submitted;
        intent.validate()?;
    }
    let view = intent.view(canvas.as_ref());
    if method != "courseware.mediaCanvas.image.get" {
        save(&state, &key, &intents)?;
    }
    Ok(view)
}

#[cfg(test)]
mod assets_tests;
#[cfg(test)]
mod reference_tests;
#[cfg(test)]
mod tests;
