//! A declared current-page checklist; never edit authority or a semantic-completion claim.
use super::*;
#[cfg(test)]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanItem {
    pub tool_name: String,
    pub label: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub tool_call_id: String,
    pub page_id: String,
    pub page_number: usize,
    pub edit_generation: u64,
    pub items: Vec<PlanItem>,
}

impl Plan {
    pub fn validate(&self, project: &CoursewareProject) -> Result<()> {
        anyhow::ensure!(
            !self.tool_call_id.is_empty()
                && self.tool_call_id.len() <= 256
                && self.edit_generation > 0
                && self.page_number > 0
                && project
                    .pages
                    .get(self.page_number - 1)
                    .is_some_and(|page| page.page_id == self.page_id)
                && !self.items.is_empty()
                && self.items.len() <= 20
                && self.items.iter().all(|item| !item.label.trim().is_empty()
                    && item.label.encode_utf16().count() <= 200
                    && plannable(&item.tool_name)),
            "COURSEWARE_INVALID: invalid current-page Chat plan"
        );
        Ok(())
    }
}

fn plannable(name: &str) -> bool {
    matches!(
        name,
        "ppt_replace_selection"
            | "ppt_add_slide_text"
            | "ppt_set_slide_font_family"
            | "ppt_set_slide_font_size"
            | "ppt_set_slide_text_color"
            | "ppt_set_slide_text_bold"
            | "ppt_set_slide_text_italic"
            | "ppt_set_slide_text_box_position"
            | "ppt_set_slide_text_box_size"
            | "ppt_set_slide_image_size"
            | "ppt_set_slide_image_position"
            | "ppt_add_slide_object_animation"
            | "ppt_replace_slide_image_from_asset"
            | "ppt_insert_slide_image_from_asset"
            | "ppt_set_slide_fade"
            | "ppt_propose_page_narration"
            | "ppt_propose_page_redo"
            | "ppt_propose_page_fade"
    )
}

impl Database {
    pub fn declare_courseware_chat_plan(
        &self,
        workspace: &str,
        project_id: &str,
        request: OperationRequest<'_>,
        plan: &Plan,
        expected_source: &str,
        expected_teaching: &str,
    ) -> Result<Value> {
        anyhow::ensure!(
            [request.session_id, request.turn_id]
                .iter()
                .all(|id| !id.is_empty() && id.len() <= 256)
                && request.tool_call_id == plan.tool_call_id,
            "COURSEWARE_INVALID: invalid Chat plan identity"
        );
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        let project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: Chat project not found"))?;
        plan.validate(&project)?;
        anyhow::ensure!(
            project.source.revision == expected_source
                && project.teaching_revision == expected_teaching
                && !project.pages[plan.page_number - 1].locked,
            "COURSEWARE_CONFLICT: Chat plan baseline changed or page is locked"
        );
        let scope = storage_key(workspace, project_id)?;
        let key = serde_json::to_string(&(&scope, request.session_id, request.turn_id))?;
        anyhow::ensure!(self.kv_get(CHANGES, &key)?.is_none() && self.kv_get(PLANNED_CHANGES, &key)?.is_none(),
            "COURSEWARE_CONFLICT: record the plan before any edit; an existing turn cannot be rewritten");
        let prefix = format!("[{},", serde_json::to_string(&scope)?);
        let count: i64 = self.conn.query_row(
            "SELECT count(*) FROM kv WHERE ns IN (?1,?2) AND substr(key,1,length(?3))=?3",
            params![CHANGES, PLANNED_CHANGES, prefix],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            count < 1000,
            "COURSEWARE_INVALID: too many retained Chat changes"
        );
        let change = Change {
            change_group_id: uuid::Uuid::new_v4().to_string(),
            session_id: request.session_id.into(),
            turn_id: request.turn_id.into(),
            baseline: project,
            operations: vec![],
            plan: Some(plan.clone()),
        };
        let value = serde_json::to_value(&change)?;
        anyhow::ensure!(
            serde_json::to_vec(&value)?.len() <= MAX_BYTES,
            "COURSEWARE_INVALID: Chat plan is too large"
        );
        self.kv_set(PLANNED_CHANGES, &key, &value)?;
        anyhow::ensure!(
            self.kv_get(PLANNED_CHANGES, &key)? == Some(value),
            "COURSEWARE_CONFLICT: Chat plan was not saved"
        );
        tx.commit()?;
        self.source_adoption_barrier()?;
        Ok(
            json!({"changeGroupId":change.change_group_id,"pageId":plan.page_id,"pageNumber":plan.page_number,
            "expectedCount":plan.items.len(),"recorded":true,"applied":false}),
        )
    }
}

pub(super) fn progress(plan: &Plan, operations: &Value, requests: &[Operation]) -> Result<Value> {
    let operations = operations
        .as_array()
        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing Chat operations"))?;
    let mut used = std::collections::HashSet::new();
    let items: Vec<Value> = plan
        .items
        .iter()
        .map(|item| {
            let matched = operations.iter().enumerate().find(|(index, op)| {
                if used.contains(index) || op["toolName"] != item.tool_name {
                    return false;
                }
                if item.tool_name.starts_with("ppt_propose_") {
                    return requests[*index].args["baseline"]["pageId"] == plan.page_id;
                }
                if let Some(page) = op["outcome"]["page"].as_u64() {
                    return page == plan.page_number as u64;
                }
                // Unknown native targets remain unknown, never a verified planned-page success.
                op["outcome"]["state"] != "acknowledged" || op["candidate"].is_object()
            });
            let mut result =
                json!({"label":item.label,"toolName":item.tool_name,"status":"not-recorded"});
            if let Some((index, op)) = matched {
                used.insert(index);
                result["toolCallId"] = op["toolCallId"].clone();
                result["status"] = if op["outcome"]["state"] != "acknowledged" {
                    json!("unknown")
                } else if op["candidate"].is_object() {
                    op["candidate"]["status"].clone()
                } else if item.tool_name == "ppt_propose_page_narration"
                    && op["outcome"]["saved"] == true
                {
                    json!("saved")
                } else {
                    json!("native-unsaved")
                };
            }
            result
        })
        .collect();
    Ok(json!({"pageId":plan.page_id,"pageNumber":plan.page_number,"items":items}))
}
