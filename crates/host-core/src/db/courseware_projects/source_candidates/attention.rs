//! Rebuilt objects require human association; unchanged objects retain verified identity.
use super::super::reviews::effects;
use super::*;
use crate::courseware::identity::SavedSourceIdentity;

fn rebuilt(candidate: &Candidate, page_id: &str) -> bool {
    candidate.request.kind != Kind::PageFade && candidate.target_page_ids().contains(&page_id)
}

pub(super) fn review(
    db: &Database,
    workspace: &str,
    candidate: &Candidate,
) -> Result<Option<(Value, Value)>> {
    let Some(output) = candidate
        .output
        .as_ref()
        .and_then(|output| output.identity.as_ref())
    else {
        return Ok(None);
    };
    if !effects::referenced(&candidate.baseline)?
        .iter()
        .any(|(page, _)| rebuilt(candidate, page))
    {
        return Ok(None);
    }
    let original = db
        .kv_get(
            identities::IDENTITY_NAMESPACE,
            &identities::identity_key(
                workspace,
                &candidate.baseline.project_id,
                &candidate.baseline.source.sha256,
            )?,
        )?
        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: original effect identity is missing"))?;
    let (mut targets, pages) = effects::projection(&candidate.baseline, &original, output)?;
    targets
        .as_array_mut()
        .unwrap()
        .retain(|target| rebuilt(candidate, target["pageId"].as_str().unwrap_or_default()));
    Ok(Some((targets, pages)))
}

pub(super) fn rebind(
    candidate: &Candidate,
    next: &mut CoursewareProject,
    original: &Value,
    identity: &Value,
    choices: &[Value],
) -> Result<()> {
    let (targets, _) = effects::projection(&candidate.baseline, original, identity)?;
    let targets = targets.as_array().unwrap();
    anyhow::ensure!(
        choices.len()
            == targets
                .iter()
                .filter(|target| rebuilt(candidate, target["pageId"].as_str().unwrap_or_default()))
                .count(),
        "COURSEWARE_INVALID: every rebuilt effect target requires explicit association"
    );
    let mut bindings = Vec::new();
    for target in targets {
        let page_id = target["pageId"].as_str().unwrap();
        let page_index = next
            .pages
            .iter()
            .position(|page| page.page_id == page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: effect page is missing"))?;
        if rebuilt(candidate, page_id) {
            let choice = choices
                .iter()
                .find(|choice| {
                    choice["pageIndex"].as_u64() == Some(page_index as u64)
                        && choice["objectId"] == target["objectId"]
                })
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing rebuilt effect association"))?;
            bindings.push(choice.clone());
        } else {
            let index = identity["pages"][page_index]["objects"]
                .as_array()
                .into_iter()
                .flatten()
                .position(|object| object["logicalId"] == target["objectId"])
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: preserved effect target changed"))?;
            bindings.push(serde_json::json!({"pageIndex":page_index,"objectId":target["objectId"],"targetIndex":index+1}));
        }
    }
    let bound = SavedSourceIdentity::parse(&serde_json::to_vec(identity)?)?;
    effects::rebind(&candidate.baseline, next, original, &bound, &bindings)
}
