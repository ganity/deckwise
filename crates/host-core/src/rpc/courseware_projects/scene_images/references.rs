use super::*;

pub(super) fn selected_reference<'a>(
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
pub(in crate::rpc::courseware_projects) fn canvas_reference(
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

pub(super) fn verify_reference(intents: &[Intent], intent: &Intent) -> Result<(), JsonRpcError> {
    if let (Some(id), Some(reference)) = (
        &intent.reference_intent_id,
        intent
            .source_reference_image
            .as_ref()
            .or(intent.request.reference_image.as_ref()),
    ) {
        let page = if matches!(intent.target, Target::VisualMaster {}) {
            let reference = intents
                .iter()
                .find(|item| item.intent_id == *id)
                .ok_or_else(|| conflict("Selected course style reference changed"))?;
            if intent.page_id == reference.page_id {
                return Err(invalid("The representative page cannot reference itself"));
            }
            &reference.page_id
        } else {
            &intent.page_id
        };
        let asset = selected_reference(intents, &intent.plan_sha256, page, id)?;
        if asset.sha256 != reference.sha256
            || asset.mime_type != reference.mime_type
            || asset.byte_length != reference.byte_length
        {
            return Err(conflict("Selected reviewed reference image changed"));
        }
    }
    Ok(())
}

pub(super) fn verify_decomposition_selection(
    intents: &[Intent],
    clean: &Intent,
) -> Result<(), JsonRpcError> {
    let foregrounds: Vec<_> = intents
        .iter()
        .filter(|i| {
            i.selected
                && i.plan_sha256 == clean.plan_sha256
                && i.page_id == clean.page_id
                && matches!(i.target, Target::Layer { .. })
        })
        .collect();
    if clean.request.kind == "image-layers" {
        verify_reference(intents, clean)?;
        let group: Vec<_> = intents
            .iter()
            .filter(|i| i.task_ref == clean.task_ref && matches!(i.target, Target::Layer { .. }))
            .collect();
        if group.is_empty()
            || group.iter().any(|i| !i.selected)
            || foregrounds.iter().any(|i| i.task_ref != clean.task_ref)
        {
            return Err(conflict(
                "Review and select every foreground from the same decomposition",
            ));
        }
    } else if foregrounds.iter().any(|i| i.request.kind == "image-layers") {
        return Err(conflict(
            "Decomposed foregrounds require their original base plate",
        ));
    }
    Ok(())
}
