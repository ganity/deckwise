use super::*;
use crate::db::courseware_projects::{
    media_scope::SubmissionScope,
    tts::{Phase, RejectedRequest, TaskRef},
};
use sha2::{Digest, Sha256};
use crate::db::courseware_projects::music::JOURNAL;

mod assets;
mod adoption;

const MAX_INTENTS: usize = 300;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MusicOptions {
    title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tags: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    negative_tags: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instrumental: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Request {
    #[serde(rename = "music")]
    Music {
        model: String,
        input: String,
        music: MusicOptions,
    },
    #[serde(rename = "music-export")]
    Export { model: String, input: String },
}

impl Request {
    fn valid(&self) -> bool {
        match self {
            Self::Music {
                model,
                input,
                music,
            } => {
                id(model)
                    && text(&music.title, 100)
                    && input.encode_utf16().count() <= 4000
                    && (music.instrumental == Some(true) || !input.trim().is_empty())
                    && [&music.tags, &music.negative_tags]
                        .iter()
                        .all(|v| v.as_ref().is_none_or(|v| v.encode_utf16().count() <= 1000))
            }
            Self::Export { model, input } => id(model) && candidate_id(input),
        }
    }

    fn hash(&self) -> String {
        let (kind, model, input) = match self {
            Self::Music { model, input, .. } => ("music", model, input),
            Self::Export { model, input } => ("music-export", model, input),
        };
        let mut fields = vec![Some(kind), Some(model), Some(input), None];
        let instrumental;
        if let Self::Music { music, .. } = self {
            instrumental = music.instrumental.map(|v| v.to_string());
            fields.extend([
                Some("courseware-music-options-v1"),
                Some(&music.title),
                music.tags.as_deref(),
                music.negative_tags.as_deref(),
                instrumental.as_deref(),
            ]);
        }
        let mut canonical = "courseware-media-v1".to_owned();
        for field in fields {
            match field {
                Some(v) => canonical.push_str(&format!(":{}:{}", v.encode_utf16().count(), v)),
                None => canonical.push_str(":-1:"),
            }
        }
        hex::encode(Sha256::digest(canonical.as_bytes()))
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Candidate {
    candidate_id: String,
    order: usize,
    state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    exportable: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    intent_id: String,
    draft: Draft,
    request: Request,
    idempotency_key: String,
    request_hash: String,
    phase: Phase,
    task_ref: Option<TaskRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    submission_scope: Option<SubmissionScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_intent_id: Option<String>,
    #[serde(default)]
    candidates: Vec<Candidate>,
    #[serde(default)]
    ready: bool,
    #[serde(default)]
    previews: Vec<assets::Preview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    asset: Option<assets::Asset>,
}

fn id(v: &str) -> bool {
    !v.is_empty()
        && v.len() <= 128
        && v != "."
        && v != ".."
        && v.bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
}
fn hash(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn text(v: &str, max: usize) -> bool {
    !v.trim().is_empty() && v.encode_utf16().count() <= max
}
fn candidate_id(v: &str) -> bool {
    uuid::Uuid::parse_str(v).is_ok_and(|parsed| parsed.to_string() == v)
}

fn candidates_valid(candidates: &[Candidate], ready: bool) -> bool {
    let mut ids = std::collections::HashSet::new();
    candidates.len() <= 16
        && candidates.iter().enumerate().all(|(order, c)| {
            candidate_id(&c.candidate_id)
                && ids.insert(&c.candidate_id)
                && c.order == order
                && ["pending", "processing", "completed", "failed"].contains(&c.state.as_str())
                && c.duration_ms
                    .is_none_or(|duration| duration <= MAX_SAFE_INTEGER)
                && c.exportable == (ready && c.state == "completed")
        })
        && (!ready
            || (candidates.iter().any(|c| c.state == "completed")
                && candidates
                    .iter()
                    .all(|c| ["completed", "failed"].contains(&c.state.as_str()))))
}

impl Intent {
    fn validate(&self) -> Result<(), JsonRpcError> {
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
        let request_matches = match &self.request {
            Request::Music { input, music, .. } => {
                self.source_intent_id.is_none()
                    && *input == self.draft.prompt
                    && music.title == self.draft.title
                    && self.asset.is_none()
            }
            Request::Export { .. } => {
                self.source_intent_id
                    .as_ref()
                    .is_some_and(|v| id(v) && v != &self.intent_id)
                    && self.candidates.is_empty()
                    && self.previews.is_empty()
                    && !self.ready
            }
        };
        if !id(&self.intent_id)
            || self.draft.kind != "music"
            || !self.draft.references.is_empty()
            || !self.request.valid()
            || !request_matches
            || uuid::Uuid::parse_str(&self.idempotency_key).is_err()
            || self.request_hash != self.request.hash()
            || (self.phase == Phase::Submitted) != self.task_ref.is_some()
            || self
                .submission_scope
                .as_ref()
                .is_some_and(|scope| !scope.valid() || self.phase == Phase::Prepared)
            || self.phase == Phase::Rejected
                && !self
                    .submission_scope
                    .as_ref()
                    .is_some_and(|scope| scope.team_project_id.is_some())
            || self.task_ref.as_ref().is_some_and(|task| {
                !id(&task.task_id)
                    || task.idempotency_key != self.idempotency_key
                    || task.request_hash != self.request_hash
            })
            || !candidates_valid(&self.candidates, self.ready)
            || (!self.candidates.is_empty() || !self.previews.is_empty() || self.asset.is_some())
                && self.phase != Phase::Submitted
            || self.asset.as_ref().is_some_and(|asset| {
                !asset.valid() || self.task_ref.as_ref() != Some(&asset.task_ref)
            })
        {
            return Err(invalid("Invalid saved canvas music intent"));
        }
        let mut ids = std::collections::HashSet::new();
        for preview in &self.previews {
            if !ids.insert(&preview.candidate_id)
                || !preview.asset.valid()
                || self.task_ref.as_ref() != Some(&preview.asset.task_ref)
                || !self.ready
                || !self.candidates.iter().any(|candidate| {
                    candidate.candidate_id == preview.candidate_id && candidate.state == "completed"
                })
            {
                return Err(invalid("Invalid saved music preview"));
            }
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
                    && draft.title == self.draft.title
                    && draft.prompt == self.draft.prompt
                    && serde_json::to_value(&draft.references).ok()
                        == serde_json::to_value(&self.draft.references).ok()
            })
    }
    fn view(&self, canvas: Option<&Stored>) -> Value {
        json!({ "intent": self, "current": self.current(canvas) })
    }
}

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
    music: Option<MusicOptions>,
    source_intent_id: Option<String>,
    candidate_id: Option<String>,
    task_ref: Option<TaskRef>,
    rejected_request: Option<RejectedRequest>,
    candidates: Option<Vec<Candidate>>,
    ready: Option<bool>,
    asset: Option<assets::Asset>,
    bytes_base64: Option<String>,
}

fn load(state: &AppState, key: &str) -> Result<Vec<Intent>, JsonRpcError> {
    let intents: Vec<Intent> = state
        .db
        .kv_get(JOURNAL, key)
        .map_err(error)?
        .map(serde_json::from_value)
        .transpose()
        .map_err(|_| invalid("Invalid canvas music journal"))?
        .unwrap_or_default();
    if intents.len() > MAX_INTENTS {
        return Err(invalid("Canvas music journal exceeds limits"));
    }
    let mut ids = std::collections::HashSet::new();
    let mut keys = std::collections::HashSet::new();
    for intent in &intents {
        intent.validate()?;
        if !ids.insert(&intent.intent_id) || !keys.insert(&intent.idempotency_key) {
            return Err(invalid("Duplicate canvas music intent"));
        }
        if let Some(source_id) = &intent.source_intent_id {
            let source = intents
                .iter()
                .find(|source| &source.intent_id == source_id)
                .ok_or_else(|| invalid("Music export source is missing"))?;
            if !matches!(&source.request, Request::Music { .. })
                || source.phase != Phase::Submitted
                || serde_json::to_value(&source.draft).ok()
                    != serde_json::to_value(&intent.draft).ok()
                || !matches!(&intent.request, Request::Export { input, .. } if source.candidates.iter().any(|c| c.candidate_id == *input && c.exportable))
                || intent.submission_scope.as_ref().is_some_and(|scope| {
                    serde_json::to_value(scope).ok()
                        != serde_json::to_value(&source.submission_scope).ok()
                })
            {
                return Err(invalid("Invalid saved music export source"));
            }
        }
    }
    Ok(intents)
}

fn save(state: &AppState, key: &str, intents: &[Intent]) -> Result<(), JsonRpcError> {
    let value = serde_json::to_value(intents).map_err(|e| error(e.into()))?;
    state.db.kv_set(JOURNAL, key, &value).map_err(error)?;
    if state.db.kv_get(JOURNAL, key).map_err(error)?.as_ref() != Some(&value) {
        return Err(invalid("Canvas music intent was not stored"));
    }
    state.db.source_adoption_barrier().map_err(error)
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    if matches!(method, "courseware.mediaCanvas.music.adopt" | "courseware.mediaCanvas.music.snapshotAssets") {
        return adoption::handle(state, method, params).await;
    }
    let operation = method
        .strip_prefix("courseware.mediaCanvas.music.")
        .ok_or_else(|| invalid("Unsupported music operation"))?;
    let mut fields = vec!["sessionId", "principalKey"];
    match operation {
        "prepare" => fields.extend([
            "intentId",
            "expectedRevision",
            "draftId",
            "expectedDraftRevision",
            "model",
            "music",
        ]),
        "export.prepare" => fields.extend(["intentId", "sourceIntentId", "candidateId", "model"]),
        "list" => (),
        "get" | "begin" => fields.push("intentId"),
        "bind" => fields.extend(["intentId", "taskRef"]),
        "reject" => fields.extend(["intentId", "rejectedRequest"]),
        "candidates.record" => fields.extend(["intentId", "taskRef", "candidates", "ready"]),
        "asset.stage" | "asset.restore" => fields.extend(["intentId", "asset", "bytesBase64"]),
        "asset.get" => fields.push("intentId"),
        _ => return Err(invalid("Unsupported music operation")),
    }
    if operation.starts_with("asset.") && params.get("candidateId").is_some() {
        fields.push("candidateId");
    }
    if !params.as_object().is_some_and(|object| {
        object.len() == fields.len()
            && fields
                .iter()
                .all(|field| object.get(*field).is_some_and(|v| !v.is_null()))
    }) {
        return Err(invalid("Invalid canvas music parameters"));
    }
    let p: Params =
        serde_json::from_value(params).map_err(|_| invalid("Invalid canvas music parameters"))?;
    if !id(&p.session_id) || !hash(&p.principal_key) {
        return Err(invalid("Invalid canvas music scope"));
    }
    let state = state.lock().await;
    let root = std::fs::canonicalize(project_workspace(&state, &p.session_id)?)
        .map_err(|e| error(e.into()))?;
    let project_id = format!("canvas:{}", p.session_id);
    let canvas_key =
        serde_json::to_string(&(&root, &p.session_id, &project_id)).map_err(|e| error(e.into()))?;
    let key = serde_json::to_string(&(&root, &p.session_id, &p.principal_key))
        .map_err(|e| error(e.into()))?;
    let canvas = super::load(&state, &canvas_key, &project_id)?;
    let mut intents = load(&state, &key)?;
    if operation == "list" {
        return Ok(
            json!({ "intents": intents.iter().map(|i| i.view(canvas.as_ref())).collect::<Vec<_>>() }),
        );
    }
    let intent_id = p
        .intent_id
        .as_deref()
        .filter(|v| id(v))
        .ok_or_else(|| invalid("Invalid music intent ID"))?;
    if ["prepare", "export.prepare", "begin"].contains(&operation) {
        if crate::sessions::session_mode(&state.db, &p.session_id)
            .map_err(error)?
            .as_deref()
            != Some("agent")
        {
            return Err(rpc_err(
                1003,
                "Music generation requires Agent mode",
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
            return Err(invalid("Select a courseware task before generating music"));
        }
    }
    if operation == "prepare" || operation == "export.prepare" {
        let (draft, request, source_intent_id) = if operation == "prepare" {
            let canvas = canvas.as_ref().ok_or_else(conflict)?;
            let draft = canvas
                .document
                .drafts
                .iter()
                .find(|draft| Some(&draft.id) == p.draft_id.as_ref())
                .ok_or_else(conflict)?;
            if p.expected_revision.as_ref() != Some(&canvas.revision)
                || p.expected_draft_revision != Some(draft.revision)
            {
                return Err(conflict());
            }
            (
                draft.clone(),
                Request::Music {
                    model: p
                        .model
                        .clone()
                        .ok_or_else(|| invalid("Music model is required"))?,
                    input: draft.prompt.clone(),
                    music: p
                        .music
                        .clone()
                        .ok_or_else(|| invalid("Music options are required"))?,
                },
                None,
            )
        } else {
            let source_id = p
                .source_intent_id
                .as_ref()
                .filter(|v| id(v))
                .ok_or_else(|| invalid("Invalid music export source"))?;
            let source = intents
                .iter()
                .find(|i| &i.intent_id == source_id)
                .ok_or_else(|| invalid("Music export source is missing"))?;
            let candidate = p
                .candidate_id
                .as_ref()
                .filter(|v| candidate_id(v))
                .ok_or_else(|| invalid("Invalid music candidate"))?;
            if source.phase != Phase::Submitted
                || !matches!(source.request, Request::Music { .. })
                || !source.ready
                || !source
                    .candidates
                    .iter()
                    .any(|c| c.candidate_id == *candidate && c.exportable)
            {
                return Err(invalid("Music candidate is not exportable"));
            }
            (
                source.draft.clone(),
                Request::Export {
                    model: p
                        .model
                        .clone()
                        .ok_or_else(|| invalid("Export model is required"))?,
                    input: candidate.clone(),
                },
                Some(source_id.clone()),
            )
        };
        if let Some(existing) = intents.iter().find(|i| i.intent_id == intent_id) {
            if existing.request != request
                || existing.source_intent_id != source_intent_id
                || serde_json::to_value(&existing.draft).ok() != serde_json::to_value(&draft).ok()
            {
                return Err(conflict());
            }
            return Ok(existing.view(canvas.as_ref()));
        }
        if intents.len() >= MAX_INTENTS {
            return Err(invalid("Music journal is full"));
        }
        let intent = Intent {
            intent_id: intent_id.into(),
            draft,
            request_hash: request.hash(),
            request,
            idempotency_key: uuid::Uuid::new_v4().to_string(),
            phase: Phase::Prepared,
            task_ref: None,
            submission_scope: None,
            source_intent_id,
            candidates: vec![],
            ready: false,
            previews: vec![],
            asset: None,
        };
        intent.validate()?;
        let view = intent.view(canvas.as_ref());
        intents.push(intent);
        save(&state, &key, &intents)?;
        return Ok(view);
    }
    let index = intents
        .iter()
        .position(|i| i.intent_id == intent_id)
        .ok_or_else(|| rpc_err(1007, "Music intent not found", "COURSEWARE_NOT_FOUND"))?;
    if operation == "asset.get" {
        return assets::files(
            &state,
            &intents[index],
            canvas.as_ref(),
            p.candidate_id.as_deref(),
        );
    }
    if operation == "asset.stage" || operation == "asset.restore" {
        assets::stage(
            &state,
            &mut intents[index],
            p.candidate_id.as_deref(),
            p.asset.ok_or_else(|| invalid("Music asset is required"))?,
            &p.bytes_base64
                .ok_or_else(|| invalid("Music bytes are required"))?,
            operation == "asset.restore",
        )?;
        save(&state, &key, &intents)?;
        return assets::files(
            &state,
            &intents[index],
            canvas.as_ref(),
            p.candidate_id.as_deref(),
        );
    }
    let inherited_scope = intents[index]
        .source_intent_id
        .as_ref()
        .and_then(|source_id| intents.iter().find(|i| &i.intent_id == source_id))
        .and_then(|i| i.submission_scope.clone());
    let intent = &mut intents[index];
    match operation {
        "get" => return Ok(intent.view(canvas.as_ref())),
        "begin" => {
            if intent.phase != Phase::Prepared
                || intent.source_intent_id.is_none() && !intent.current(canvas.as_ref())
            {
                return Err(conflict());
            }
            intent.submission_scope = Some(if intent.source_intent_id.is_some() {
                inherited_scope.ok_or_else(|| invalid("Music source scope is missing"))?
            } else {
                state
                    .db
                    .courseware_media_submission_scope(&p.session_id)
                    .map_err(error)?
            });
            intent.phase = Phase::SubmissionUnknown;
        }
        "bind" => {
            let task = p
                .task_ref
                .ok_or_else(|| invalid("Music task is required"))?;
            if !matches!(intent.phase, Phase::SubmissionUnknown | Phase::Submitted)
                || intent.task_ref.as_ref().is_some_and(|old| old != &task)
            {
                return Err(conflict());
            }
            intent.task_ref = Some(task);
            intent.phase = Phase::Submitted;
        }
        "reject" => {
            let rejected = p
                .rejected_request
                .ok_or_else(|| invalid("Music rejection is required"))?;
            if intent.phase != Phase::SubmissionUnknown
                || intent.task_ref.is_some()
                || intent.idempotency_key != rejected.idempotency_key
                || intent.request_hash != rejected.request_hash
                || !intent
                    .submission_scope
                    .as_ref()
                    .is_some_and(|scope| scope.team_project_id.is_some())
            {
                return Err(conflict());
            }
            intent.phase = Phase::Rejected;
        }
        "candidates.record" => {
            let candidates = p
                .candidates
                .ok_or_else(|| invalid("Candidates are required"))?;
            let ready = p
                .ready
                .ok_or_else(|| invalid("Candidate readiness is required"))?;
            if !matches!(intent.request, Request::Music { .. })
                || intent.phase != Phase::Submitted
                || p.task_ref != intent.task_ref
                || !candidates_valid(&candidates, ready)
                || intent.ready && (intent.candidates != candidates || !ready)
                || candidates.len() < intent.candidates.len()
                || intent.candidates.iter().zip(&candidates).any(|(old, new)| {
                    old.candidate_id != new.candidate_id
                        || old.order != new.order
                        || ["completed", "failed"].contains(&old.state.as_str())
                            && old.state != new.state
                        || old.state == "processing" && new.state == "pending"
                })
            {
                return Err(conflict());
            }
            intent.candidates = candidates;
            intent.ready = ready;
        }
        _ => return Err(invalid("Unsupported music operation")),
    }
    intent.validate()?;
    let view = intent.view(canvas.as_ref());
    save(&state, &key, &intents)?;
    Ok(view)
}

#[cfg(test)]
mod tests;
