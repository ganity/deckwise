//! Explicit attention-target association; parser positions are review-scoped, never identities.
use super::*;
use std::collections::{HashMap, HashSet};

fn fields(value: &Value, required: &[&str], optional: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        required.iter().all(|key| object.contains_key(*key))
            && object
                .keys()
                .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))
    })
}

fn object_id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|id| !id.is_empty() && id.encode_utf16().count() <= 200)
}

fn eligible(value: &Value) -> bool {
    matches!(value.as_str(), Some("text" | "shape" | "image"))
}

pub(crate) fn cue_targets(cue: &Value) -> Result<Vec<String>> {
    anyhow::ensure!(
        fields(cue, &["id", "atMs", "endMs", "effect"], &[])
            && object_id(&cue["id"])
            && cue["atMs"].as_u64().is_some()
            && cue["endMs"].as_u64().is_some_and(|end| end
                > cue["atMs"].as_u64().unwrap_or(u64::MAX)
                && end <= 3_600_000),
        "COURSEWARE_INVALID: unsupported attention cue"
    );
    let effect = &cue["effect"];
    let mut targets = Vec::new();
    match effect["type"].as_str() {
        Some("highlight") => {
            anyhow::ensure!(
                fields(
                    effect,
                    &["type", "elementIds"],
                    &["color", "style", "opacity"]
                ) && effect["elementIds"]
                    .as_array()
                    .is_some_and(|ids| !ids.is_empty())
                    && effect
                        .get("color")
                        .is_none_or(|color| color.as_str().is_some_and(|color| color.len() == 7
                            && color.starts_with('#')
                            && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())))
                    && effect.get("style").is_none_or(|style| matches!(
                        style.as_str(),
                        Some("outline" | "fill" | "glow")
                    ))
                    && effect.get("opacity").is_none_or(|unit| unit
                        .as_f64()
                        .is_some_and(|unit| (0.0..=1.0).contains(&unit))),
                "COURSEWARE_INVALID: unsupported highlight cue"
            );
            targets.extend(effect["elementIds"].as_array().unwrap().iter().cloned());
        }
        Some("spotlight") => {
            anyhow::ensure!(
                fields(
                    effect,
                    &["type", "elementId"],
                    &["elementIds", "dimOpacity"]
                ) && effect.get("elementIds").is_none_or(Value::is_array)
                    && effect.get("dimOpacity").is_none_or(|unit| unit
                        .as_f64()
                        .is_some_and(|unit| (0.0..=1.0).contains(&unit))),
                "COURSEWARE_INVALID: unsupported spotlight cue"
            );
            targets.push(effect["elementId"].clone());
            targets.extend(
                effect["elementIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .cloned(),
            );
        }
        _ => anyhow::bail!(
            "COURSEWARE_INVALID: source review supports highlight and spotlight cues only"
        ),
    }
    let mut unique = HashSet::new();
    anyhow::ensure!(
        (1..=200).contains(&targets.len())
            && targets.iter().all(|id| object_id(id) && unique.insert(id)),
        "COURSEWARE_INVALID: invalid or duplicate attention targets"
    );
    Ok(targets
        .iter()
        .map(|id| id.as_str().unwrap().to_owned())
        .collect())
}

pub(in crate::db::courseware_projects) fn referenced(
    project: &CoursewareProject,
) -> Result<Vec<(String, String)>> {
    let mut plain = project.clone();
    let mut targets = Vec::new();
    let mut unique = HashSet::new();
    for page in &mut plain.pages {
        for action in &mut page.actions {
            if let Some(intent) = action.get("attention") {
                anyhow::ensure!(action["type"] == "speech", "COURSEWARE_INVALID: attention requires speech");
                for id in attention::targets(intent)? {
                    if unique.insert((page.page_id.clone(), id.clone())) { targets.push((page.page_id.clone(), id)); }
                }
                action.as_object_mut().unwrap().remove("attention");
            }
            if let Some(cues) = action.get("visualCues") {
                let cues = cues
                    .as_array()
                    .filter(|cues| cues.len() <= 200)
                    .ok_or_else(|| anyhow!("COURSEWARE_INVALID: invalid attention cues"))?;
                anyhow::ensure!(
                    action["type"] == "speech",
                    "COURSEWARE_INVALID: attention cues require speech"
                );
                let mut cue_ids = HashSet::new();
                for cue in cues {
                    anyhow::ensure!(
                        cue_ids.insert(cue["id"].clone()),
                        "COURSEWARE_INVALID: duplicate cue IDs"
                    );
                    for id in cue_targets(cue)? {
                        if unique.insert((page.page_id.clone(), id.clone())) {
                            targets.push((page.page_id.clone(), id));
                        }
                    }
                }
                action.as_object_mut().unwrap().remove("visualCues");
            }
        }
    }
    portable_narration(&plain, true)?;
    Ok(targets)
}

pub(in crate::db::courseware_projects) fn projection(
    project: &CoursewareProject,
    previous: &Value,
    target: &Value,
) -> Result<(Value, Value)> {
    let mut targets = Vec::new();
    for (page_id, object_id) in referenced(project)? {
        let page = previous["pages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|page| page["logicalId"] == page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: previous effect page is missing"))?;
        let (index, object) = page["objects"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .find(|(_, object)| object["logicalId"] == object_id)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: previous effect target is missing"))?;
        anyhow::ensure!(
            eligible(&object["type"]),
            "COURSEWARE_INVALID: unsupported previous effect target kind"
        );
        targets.push(serde_json::json!({"pageId":page_id,"objectId":object_id,"kind":object["type"],"index":index+1}));
    }
    let pages: Vec<_> = target["pages"].as_array().into_iter().flatten().map(|page| serde_json::json!({
        "objects":page["objects"].as_array().into_iter().flatten().enumerate().map(|(index, object)|
            serde_json::json!({"index":index+1,"kind":object["type"]})).collect::<Vec<_>>()
    })).collect();
    Ok((serde_json::json!(targets), serde_json::json!(pages)))
}

pub(in crate::db::courseware_projects) fn rebind(
    previous: &CoursewareProject,
    next: &mut CoursewareProject,
    previous_identity: &Value,
    bound: &SavedSourceIdentity,
    bindings: &[Value],
) -> Result<()> {
    let (targets, _) = projection(previous, previous_identity, bound.value())?;
    let targets = targets.as_array().unwrap();
    anyhow::ensure!(
        bindings.len() == targets.len(),
        "COURSEWARE_INVALID: every effect target requires explicit association"
    );
    let mut replacements = HashMap::new();
    let mut used = HashSet::new();
    for binding in bindings {
        anyhow::ensure!(
            fields(binding, &["pageIndex", "objectId", "targetIndex"], &[]),
            "COURSEWARE_INVALID: invalid effect association fields"
        );
        let page_index = binding["pageIndex"]
            .as_u64()
            .and_then(|index| usize::try_from(index).ok())
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: invalid effect page index"))?;
        let target_index = binding["targetIndex"]
            .as_u64()
            .and_then(|index| usize::try_from(index).ok())
            .filter(|index| *index > 0)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: invalid effect object index"))?;
        let page = next
            .pages
            .get(page_index)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: effect page is missing"))?;
        let old_id = binding["objectId"]
            .as_str()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: invalid old effect UUID"))?;
        anyhow::ensure!(
            targets
                .iter()
                .any(|target| target["pageId"] == page.page_id && target["objectId"] == old_id),
            "COURSEWARE_INVALID: unknown or cross-page effect target"
        );
        let object = bound.value()["pages"][page_index]["objects"]
            .get(target_index - 1)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: current saved object is missing"))?;
        anyhow::ensure!(
            eligible(&object["type"])
                && used.insert((page_index, target_index))
                && replacements
                    .insert(
                        (page.page_id.clone(), old_id.to_owned()),
                        object["logicalId"].clone()
                    )
                    .is_none(),
            "COURSEWARE_INVALID: unsupported or duplicate effect association"
        );
    }
    for page in &mut next.pages {
        for action in &mut page.actions {
            for id in action.get_mut("attention").and_then(|v| v.get_mut("objectIds")).and_then(Value::as_array_mut).into_iter().flatten() {
                *id = replacements.get(&(page.page_id.clone(), id.as_str().unwrap_or_default().to_owned()))
                    .ok_or_else(|| anyhow!("COURSEWARE_INVALID: attention association is incomplete"))?.clone();
            }
            for cue in action
                .get_mut("visualCues")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                let effect = &mut cue["effect"];
                let replace = |id: &mut Value| -> Result<()> {
                    *id = replacements
                        .get(&(
                            page.page_id.clone(),
                            id.as_str().unwrap_or_default().to_owned(),
                        ))
                        .ok_or_else(|| {
                            anyhow!("COURSEWARE_INVALID: effect association is incomplete")
                        })?
                        .clone();
                    Ok(())
                };
                if effect["type"] == "spotlight" {
                    replace(&mut effect["elementId"])?;
                }
                for id in effect
                    .get_mut("elementIds")
                    .and_then(Value::as_array_mut)
                    .into_iter()
                    .flatten()
                {
                    replace(id)?;
                }
            }
        }
    }
    Ok(())
}
