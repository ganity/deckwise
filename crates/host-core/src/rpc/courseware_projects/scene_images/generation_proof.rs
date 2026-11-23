use super::*;

/// Recheck the exact reviewed inputs under the same Host lock as project initialization/attachment.
pub(in super::super) fn verify_generation(
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
    let corrections: Vec<_> = proof
        .teaching_correction
        .iter()
        .chain(&proof.teaching_corrections)
        .collect();
    if corrections.len() > plan.pages.len() {
        return Err(invalid("Too many reviewed scene teaching corrections"));
    }
    let mut corrected_pages = std::collections::HashSet::new();
    for (index, correction) in corrections.iter().enumerate() {
        let (_, page) = plan
            .pages
            .iter()
            .enumerate()
            .find(|(page_index, page)| {
                correction.page_id == format!("scene-{:03}", page_index + 1)
                    && page.quiz.is_none()
                    && !page.teaching.as_ref().is_some_and(|t| t.question.is_some())
            })
            .ok_or_else(|| conflict("Reviewed scene correction has no matching visual page"))?;
        if !corrected_pages.insert(&correction.page_id) {
            return Err(invalid("Duplicate reviewed scene correction page"));
        }
        let intent = selected
            .iter()
            .find(|intent| {
                intent.intent_id == correction.intent_id
                    && intent.page_id == correction.page_id
                    && matches!(intent.target, Target::VisualMaster {})
            })
            .ok_or_else(|| {
                conflict("Reviewed scene correction is not bound to the selected visual master")
            })?;
        let asset = intent
            .asset
            .as_ref()
            .ok_or_else(|| conflict("Reviewed scene correction image is not archived"))?;
        if correction
            .asset_sha256
            .as_deref()
            .is_some_and(|sha| sha != asset.sha256)
            || (correction.asset_sha256.is_none()
                && (proof.teaching_correction.is_none() || index > 0))
        {
            return Err(conflict("Reviewed scene correction image changed"));
        }
        let instruction = intent.planning_instructions.as_str();
        if instruction.trim().is_empty() {
            return Err(conflict(
                "Reviewed scene correction has no saved instruction",
            ));
        }
        let teaching = page
            .teaching
            .as_ref()
            .ok_or_else(|| conflict("Reviewed scene correction teaching changed"))?;
        if correction.removals.is_empty()
            || correction.removals.len() > teaching.required_objects.len()
        {
            return Err(invalid("Invalid reviewed scene teaching correction"));
        }
        let mut removed = std::collections::HashSet::new();
        for removal in &correction.removals {
            if removal.object.trim().is_empty()
                || removal.object.encode_utf16().count() > 200
                || removal.quote.trim().is_empty()
                || removal.quote.encode_utf16().count() > 1200
                || !instruction.contains(&removal.quote)
                || !teaching.required_objects.contains(&removal.object)
                || !removed.insert(&removal.object)
            {
                return Err(conflict(
                    "Reviewed scene teaching correction evidence changed",
                ));
            }
        }
    }
    let pages: std::collections::HashSet<_> = plan
        .pages
        .iter()
        .enumerate()
        .filter(|(_, page)| {
            page.quiz.is_none()
                && !page
                    .teaching
                    .as_ref()
                    .is_some_and(|teaching| teaching.question.is_some())
        })
        .map(|(index, _)| format!("scene-{:03}", index + 1))
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
        verify_reference(&intents, master.unwrap())?;
        verify_decomposition_selection(&intents, clean.unwrap())?;
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
