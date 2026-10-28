//! Explicit decisions produce an independent publication input, never a local adoption.
use super::*;
use crate::db::courseware_projects::{reviews::effects::cue_targets, CoursewarePage};
use std::collections::{BTreeSet, HashMap, HashSet};

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveRequest {
    pub session_id: String,
    pub baseline_id: String,
    pub review_id: String,
    pub job_id: String,
    pub target: Target,
    pub pages: Vec<PageDecision>,
    pub removed_pages: Vec<RemovedPage>,
    pub cues: Vec<CueDecision>,
}

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum PageDecision {
    #[serde(rename_all = "camelCase")]
    Carry {
        target_import_page_id: String,
        old_page_id: String,
        confirm_ready: bool,
    },
    #[serde(rename_all = "camelCase")]
    New {
        target_import_page_id: String,
        confirm_ready: bool,
    },
}
impl PageDecision {
    fn target(&self) -> &str {
        match self {
            Self::Carry {
                target_import_page_id,
                ..
            }
            | Self::New {
                target_import_page_id,
                ..
            } => target_import_page_id,
        }
    }
}

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemovedPage {
    old_page_id: String,
    confirm_delete: bool,
}
#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CueDecision {
    old_page_id: String,
    action_id: String,
    cue_id: String,
    delete_cue: bool,
    targets: Vec<TargetDecision>,
}
#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(tag = "decision", rename_all = "lowercase", deny_unknown_fields)]
pub enum TargetDecision {
    #[serde(rename_all = "camelCase")]
    Keep {
        old_object_id: String,
        target_import_element_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Rebind {
        old_object_id: String,
        target_import_element_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Remove { old_object_id: String },
}
impl TargetDecision {
    fn old(&self) -> &str {
        match self {
            Self::Keep { old_object_id, .. }
            | Self::Rebind { old_object_id, .. }
            | Self::Remove { old_object_id } => old_object_id,
        }
    }
    fn target(&self) -> Option<&str> {
        match self {
            Self::Keep {
                target_import_element_id,
                ..
            }
            | Self::Rebind {
                target_import_element_id,
                ..
            } => Some(target_import_element_id),
            Self::Remove { .. } => None,
        }
    }
}
fn eligible(object: &Value) -> bool {
    matches!(object["type"].as_str(), Some("text" | "shape" | "image"))
}
fn safe_id(value: &Value) -> bool {
    value.as_str().is_some_and(|v| {
        !v.is_empty()
            && v.len() <= 128
            && v.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
    })
}
fn invalid(message: &str) -> anyhow::Error {
    anyhow!("COURSEWARE_INVALID: {message}")
}
fn generated(seed: &str, label: &str, parts: &[&str]) -> String {
    let hash = Sha256::digest(serde_json::to_vec(&(seed, label, parts)).unwrap());
    let mut bytes = [0; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes).to_string()
}
fn cue_key(page: &str, action: &str, cue: &str) -> (String, String, String) {
    (page.into(), action.into(), cue.into())
}

fn portable(project: &CoursewareProject) -> Result<()> {
    for page in &project.pages {
        for action in &page.actions {
            let fields = action
                .as_object()
                .ok_or_else(|| invalid("invalid original action"))?;
            let allowed: &[&str] = match action["type"].as_str() {
                Some("speech") => {
                    anyhow::ensure!(
                        action["text"].is_string()
                            && action
                                .get("source")
                                .is_none_or(|v| matches!(v.as_str(), Some("notes" | "external")))
                            && action
                                .get("pauseAfterMs")
                                .is_none_or(|v| v.as_u64().is_some_and(|v| v <= 30000)),
                        "{}",
                        invalid("unsupported original speech")
                    );
                    &[
                        "id",
                        "type",
                        "text",
                        "source",
                        "pauseAfterMs",
                        "audioAssetId",
                        "visualCues",
                    ]
                }
                Some("audio_clip") => &["id", "type", "audioAssetId"],
                Some("interaction_checkpoint") => {
                    anyhow::ensure!(
                        crate::db::courseware_projects::valid_teaching_checkpoint(action),
                        "{}",
                        invalid("unsupported original checkpoint")
                    );
                    &[
                        "id",
                        "type",
                        "checkpointId",
                        "checkpointKind",
                        "chapterId",
                        "chapterTitle",
                        "question",
                        "referenceAnswer",
                        "context",
                    ]
                }
                _ => return Err(invalid("unsupported original action type")),
            };
            anyhow::ensure!(
                fields.keys().all(|key| allowed.contains(&key.as_str()))
                    && action.get("audioAssetId").is_none_or(safe_id),
                "{}",
                invalid("unsupported original action fields")
            );
            if let Some(cues) = action.get("visualCues") {
                let cues = cues
                    .as_array()
                    .filter(|v| v.len() <= 200)
                    .ok_or_else(|| invalid("invalid original cues"))?;
                let mut ids = HashSet::new();
                for cue in cues {
                    cue_targets(cue)?;
                    anyhow::ensure!(
                        ids.insert(cue["id"].clone()),
                        "{}",
                        invalid("duplicate original cue id")
                    );
                }
            }
        }
    }
    Ok(())
}

impl ReviewCache {
    fn resolve(
        &mut self,
        workspace: &Path,
        parsed: source_candidates::ParsedOutput,
        request: &ResolveRequest,
    ) -> Result<Value> {
        bounded(serde_json::to_value(request)?, MAX_RESPONSE_BYTES)?;
        let review = self.review(
            &request.session_id,
            workspace,
            &request.baseline_id,
            parsed.clone(),
            request.target.clone(),
        )?;
        anyhow::ensure!(
            review["reviewId"] == request.review_id,
            "COURSEWARE_CONFLICT: online source review changed"
        );
        let baseline = self.owned(&request.session_id, workspace, &request.baseline_id)?;
        portable(&baseline.project)?;
        let mut normalized = request.clone();
        normalized.pages.sort_by(|a, b| a.target().cmp(b.target()));
        normalized
            .removed_pages
            .sort_by(|a, b| a.old_page_id.cmp(&b.old_page_id));
        normalized
            .cues
            .sort_by_key(|v| cue_key(&v.old_page_id, &v.action_id, &v.cue_id));
        for cue in &mut normalized.cues {
            cue.targets.sort_by(|a, b| a.old().cmp(b.old()));
        }
        // Parser job IDs are ephemeral; pinned view and decisions alone determine output IDs.
        normalized.job_id.clear();
        let seed = hex::encode(Sha256::digest(serde_json::to_vec(&normalized)?));
        let raw = parsed.identity.as_ref().unwrap();
        let targets = raw["pages"].as_array().unwrap();
        anyhow::ensure!(
            request.pages.len() == targets.len()
                && request.removed_pages.len() <= baseline.project.pages.len()
                && request.cues.len() <= 20000,
            "{}",
            invalid("incomplete or oversized online decisions")
        );
        let mut decisions = HashMap::new();
        for decision in &request.pages {
            anyhow::ensure!(
                decisions.insert(decision.target(), decision).is_none(),
                "{}",
                invalid("duplicate target page decision")
            );
        }
        let mut used = HashSet::new();
        let mut next = baseline.project.clone();
        next.source = request.target.source.clone();
        next.pages.clear();
        let mut identity = raw.clone();
        identity["mappingRevision"] = json!(generated(&seed, "mapping", &[]));
        for (index, target) in targets.iter().enumerate() {
            let import = target["importPageId"].as_str().unwrap();
            let decision = decisions
                .remove(import)
                .ok_or_else(|| invalid("every target page requires an explicit decision"))?;
            let (mut page, ready) = match decision {
                PageDecision::Carry {
                    old_page_id,
                    confirm_ready,
                    ..
                } => {
                    anyhow::ensure!(
                        used.insert(old_page_id.as_str()),
                        "{}",
                        invalid("old page cannot be carried twice")
                    );
                    (
                        baseline
                            .project
                            .pages
                            .iter()
                            .find(|p| p.page_id == *old_page_id)
                            .cloned()
                            .ok_or_else(|| invalid("unknown old page"))?,
                        *confirm_ready,
                    )
                }
                PageDecision::New { confirm_ready, .. } => (
                    CoursewarePage {
                        page_id: generated(&seed, "page", &[import]),
                        actions: vec![],
                        locked: false,
                        review_state: "review".into(),
                    },
                    *confirm_ready,
                ),
            };
            page.review_state = if ready { "ready" } else { "review" }.into();
            identity["pages"][index]["logicalId"] = json!(page.page_id);
            for object in identity["pages"][index]["objects"].as_array_mut().unwrap() {
                object["logicalId"] = json!(generated(
                    &seed,
                    "object",
                    &[import, object["importElementId"].as_str().unwrap()]
                ));
            }
            next.pages.push(page);
        }
        anyhow::ensure!(
            decisions.is_empty(),
            "{}",
            invalid("unknown target page decision")
        );
        let mut removed = BTreeSet::new();
        for removal in &request.removed_pages {
            let page = baseline
                .project
                .pages
                .iter()
                .find(|p| p.page_id == removal.old_page_id)
                .ok_or_else(|| invalid("unknown removed page"))?;
            anyhow::ensure!(
                removal.confirm_delete
                    && !page.locked
                    && !used.contains(removal.old_page_id.as_str())
                    && removed.insert(removal.old_page_id.clone()),
                "{}",
                invalid("removed page needs explicit unlocked unique confirmation")
            );
        }
        anyhow::ensure!(
            baseline
                .project
                .pages
                .iter()
                .all(|p| used.contains(p.page_id.as_str()) || removed.contains(&p.page_id)),
            "{}",
            invalid("every old page requires carry or deletion confirmation")
        );
        let mut cues = HashMap::new();
        for decision in &request.cues {
            anyhow::ensure!(
                decision.targets.len() <= 200
                    && cues
                        .insert(
                            cue_key(&decision.old_page_id, &decision.action_id, &decision.cue_id),
                            decision
                        )
                        .is_none(),
                "{}",
                invalid("duplicate or oversized cue decision")
            );
        }
        let mut seen = HashSet::new();
        let mut kept = HashMap::new();
        let mut kept_actual = HashMap::new();
        for (index, page) in next.pages.iter().enumerate() {
            for action in &page.actions {
                for cue in action
                    .get("visualCues")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let key = cue_key(
                        &page.page_id,
                        action["id"].as_str().unwrap(),
                        cue["id"].as_str().unwrap(),
                    );
                    let decision = cues.get(&key).ok_or_else(|| {
                        invalid("every carried cue requires explicit target decisions")
                    })?;
                    seen.insert(key);
                    let old_targets = cue_targets(cue)?;
                    anyhow::ensure!(
                        decision.targets.len() == old_targets.len(),
                        "{}",
                        invalid("every cue target requires a decision")
                    );
                    let mut seen_targets = HashSet::new();
                    for choice in &decision.targets {
                        anyhow::ensure!(
                            old_targets.iter().any(|v| v == choice.old())
                                && seen_targets.insert(choice.old()),
                            "{}",
                            invalid("unknown or duplicate old cue target")
                        );
                        let previous = baseline.identity.value()["pages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|p| p["logicalId"] == page.page_id)
                            .unwrap();
                        anyhow::ensure!(
                            previous["objects"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|o| o["logicalId"] == choice.old() && eligible(o)),
                            "{}",
                            invalid("old cue target is absent or unsupported")
                        );
                        if let Some(target_id) = choice.target() {
                            let object_index = identity["pages"][index]["objects"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .position(|o| o["importElementId"] == target_id && eligible(o))
                                .ok_or_else(|| {
                                    invalid("target object is absent, cross-page or unsupported")
                                })?;
                            if matches!(choice, TargetDecision::Keep { .. }) {
                                let actual = (index, object_index);
                                let old = (page.page_id.clone(), choice.old().to_owned());
                                anyhow::ensure!(
                                    kept.get(&old).is_none_or(|v| v == &actual)
                                        && kept_actual.get(&actual).is_none_or(|v| v == &old),
                                    "{}",
                                    invalid("keep associations must be globally consistent")
                                );
                                kept.insert(old.clone(), actual);
                                kept_actual.insert(actual, old);
                                identity["pages"][index]["objects"][object_index]["logicalId"] =
                                    json!(choice.old());
                            }
                        }
                    }
                    anyhow::ensure!(
                        !decision.delete_cue
                            || decision
                                .targets
                                .iter()
                                .all(|v| matches!(v, TargetDecision::Remove { .. })),
                        "{}",
                        invalid("cue deletion requires removing every target")
                    );
                }
            }
        }
        anyhow::ensure!(
            seen.len() == cues.len(),
            "{}",
            invalid("unknown or removed-page cue decision")
        );
        let bound = identity::SavedSourceIdentity::parse(&serde_json::to_vec(&identity)?)?;
        for (index, page) in next.pages.iter_mut().enumerate() {
            for action in &mut page.actions {
                let Some(old_cues) = action.get("visualCues").and_then(Value::as_array) else {
                    continue;
                };
                let mut output = Vec::new();
                for cue in old_cues {
                    let decision = cues[&cue_key(
                        &page.page_id,
                        action["id"].as_str().unwrap(),
                        cue["id"].as_str().unwrap(),
                    )];
                    if decision.delete_cue {
                        continue;
                    }
                    let replace = |id: &Value| -> Option<Value> {
                        let choice = decision
                            .targets
                            .iter()
                            .find(|v| Some(v.old()) == id.as_str())
                            .unwrap();
                        choice.target().map(|target| {
                            bound.value()["pages"][index]["objects"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find(|o| o["importElementId"] == target)
                                .unwrap()["logicalId"]
                                .clone()
                        })
                    };
                    let mut updated = cue.clone();
                    let effect = &mut updated["effect"];
                    if effect["type"] == "spotlight" {
                        effect["elementId"] = replace(&effect["elementId"]).ok_or_else(|| {
                            invalid("removing spotlight primary requires explicit cue deletion")
                        })?;
                    }
                    if let Some(ids) = effect.get("elementIds").and_then(Value::as_array) {
                        effect["elementIds"] =
                            json!(ids.iter().filter_map(replace).collect::<Vec<_>>());
                    }
                    cue_targets(&updated)?;
                    output.push(updated);
                }
                action["visualCues"] = json!(output);
            }
        }
        next.validate_online()?;
        let mapping = json!({"revision":identity["mappingRevision"],"sourceSha256":parsed.sha256,"pages":bound.value()["pages"].as_array().unwrap().iter().map(|page|json!({"pageId":page["logicalId"],"importPageId":page["importPageId"],"objects":page["objects"].as_array().unwrap().iter().map(|object|json!({"objectId":object["logicalId"],"importElementId":object["importElementId"]})).collect::<Vec<_>>() })).collect::<Vec<_>>()});
        let mut pinned = mapping.clone();
        pinned["sourceRevision"] = json!(next.source.revision);
        identity::SavedSourceIdentity::parse(&serde_json::to_vec(raw)?)?.bind_mapping(&pinned)?;
        let asset_ids = next
            .pages
            .iter()
            .flat_map(|p| &p.actions)
            .filter_map(|a| a.get("audioAssetId").and_then(Value::as_str))
            .collect::<BTreeSet<_>>();
        bounded(
            json!({"reviewId":request.review_id,"project":next,"mapping":mapping,"removedPageIds":removed,"assetIds":asset_ids}),
            MAX_RESPONSE_BYTES,
        )
    }
}

impl Parser {
    pub fn online_source_resolve(
        &mut self,
        workspace: &Path,
        request: &ResolveRequest,
    ) -> Result<Value> {
        self.online_review
            .owned(&request.session_id, workspace, &request.baseline_id)?;
        let (parsed, _) = self.verified_online_source(
            &request.job_id,
            workspace,
            &request.target.source.sha256,
            request.target.byte_length,
        )?;
        self.online_review.resolve(workspace, parsed, request)
    }
}

#[cfg(test)]
mod tests;
