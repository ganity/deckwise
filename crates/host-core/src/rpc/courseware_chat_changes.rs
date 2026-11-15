//! Attach a durable courseware receipt without changing native command or permission contracts.
use super::*;
use crate::db::courseware_projects::chat_changes::{OperationRequest, Pending, Plan, PlanItem};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanBaseline {
    project_id: String,
    document_id: String,
    session_id: String,
    edit_generation: u64,
    courseware_project_id: String,
    page_id: String,
    source_revision: String,
    source_sha256: String,
    teaching_revision: String,
    content_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PlanArgs {
    baseline: PlanBaseline,
    page_number: usize,
    changes: Vec<PlanItem>,
}

/// Metadata only: permission has already passed; no native dispatch or mutation authority is granted.
pub(super) fn declare(
    state: &AppState,
    p: &ToolsExecuteParams,
) -> Result<tools::ToolsExecuteResult> {
    let args: PlanArgs = serde_json::from_value(p.args.clone())?;
    let b = args.baseline;
    let root = sessions::get_session(&state.db, &p.session_id)?
        .and_then(|detail| detail.summary.project_path)
        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: persisted Chat workspace required"))?;
    let hash = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    };
    let project = state
        .db
        .get_courseware_project(&root, &b.courseware_project_id)?
        .ok_or_else(|| {
            anyhow!("COURSEWARE_NOT_FOUND: initialize courseware before declaring a plan")
        })?;
    anyhow::ensure!(
        b.project_id == hex::encode(Sha256::digest(root.as_bytes()))
            && b.courseware_project_id == format!("office-{}", b.document_id)
            && !b.session_id.is_empty()
            && b.session_id.len() <= 128
            && hash(&b.content_sha256)
            && b.source_sha256 == project.source.sha256,
        "COURSEWARE_INVALID: Chat plan binding differs"
    );
    let turn = p
        .turn_id
        .as_deref()
        .filter(|turn| !turn.is_empty())
        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: an owning Chat turn is required"))?;
    let content = state.db.declare_courseware_chat_plan(
        &root,
        &b.courseware_project_id,
        OperationRequest {
            session_id: &p.session_id,
            turn_id: turn,
            tool_call_id: &p.tool_call_id,
            tool_name: &p.tool_name,
            args: &p.args,
        },
        &Plan {
            tool_call_id: p.tool_call_id.clone(),
            page_id: b.page_id,
            page_number: args.page_number,
            edit_generation: b.edit_generation,
            items: args.changes,
        },
        &b.source_revision,
        &b.teaching_revision,
    )?;
    Ok(tools::ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok: true,
        content,
        duration_ms: 0,
        is_error: None,
        denied: None,
        error_code: None,
        command_shell_id: None,
    })
}

pub(super) fn prepare(state: &AppState, p: &ToolsExecuteParams) -> Result<Option<Pending>> {
    if !tools::is_ppt_editor_tool(&p.tool_name)
        || matches!(
            p.tool_name.as_str(),
            "ppt_get_context" | "ppt_get_presentation_text" | "ppt_get_narration_context"
        )
    {
        return Ok(None);
    }
    let binding = if p.tool_name.starts_with("ppt_propose_") {
        &p.args["baseline"]
    } else {
        &p.args
    };
    let Some(document_id) = binding["documentId"].as_str() else {
        return Ok(None);
    };
    anyhow::ensure!(
        !document_id.is_empty()
            && document_id.len() <= 120
            && document_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)),
        "COURSEWARE_INVALID: invalid native document identity"
    );
    let root = sessions::get_session(&state.db, &p.session_id)?
        .and_then(|detail| detail.summary.project_path)
        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: persisted Chat workspace required"))?;
    let project_id = format!("office-{document_id}");
    // Existing generic PPT editing can precede courseware initialization.
    if state
        .db
        .get_courseware_project(&root, &project_id)?
        .is_none()
    {
        return Ok(None);
    }
    anyhow::ensure!(
        binding["projectId"] == hex::encode(Sha256::digest(root.as_bytes())),
        "COURSEWARE_INVALID: native workspace identity differs"
    );
    Ok(Some(state.db.prepare_courseware_chat_change(
        &root,
        &project_id,
        OperationRequest {
            session_id: &p.session_id,
            turn_id: p.turn_id.as_deref().unwrap_or(&p.tool_call_id),
            tool_call_id: &p.tool_call_id,
            tool_name: &p.tool_name,
            args: &p.args,
        },
    )?))
}

pub(super) fn finish(
    state: &AppState,
    pending: &Pending,
    result: &tools::ToolsExecuteResult,
) -> Result<()> {
    // A failure may follow a native side effect; neither failure nor timeout authorizes replay.
    state.db.finish_courseware_chat_change(
        pending,
        json!({
            "state": if result.ok { "acknowledged" } else { "uncertain" },
            "errorCode":result.error_code,
            "nativeStatus":result.content.get("status"),
            "page":result.content.pointer("/result/page"),
            "candidateId":result.content.get("candidateId"),
            "reviewState":result.content.get("reviewState"),
            "saved":result.ok && result.content["kind"] == "page-narration"
                && result.content["saved"] == true && result.content["applied"] == true,
        }),
    )
}

pub(super) fn failure(p: &ToolsExecuteParams, error: anyhow::Error) -> tools::ToolsExecuteResult {
    tools::ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok: false,
        is_error: Some(true),
        content: json!({"error":format!("Courseware Chat receipt failed; inspect the document before retrying: {error}")}),
        duration_ms: 0,
        denied: None,
        error_code: Some("COURSEWARE_CHAT_RECEIPT_FAILED".into()),
        command_shell_id: None,
    }
}

#[cfg(test)]
mod tests;
