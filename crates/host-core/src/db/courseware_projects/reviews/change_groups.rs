//! Saved native edits and their teaching review share a durable receipt, not a transaction with Office.
use super::*;
use serde_json::json;

const CHANGES: &str = "coursewareSourceChanges.v1";
const LATEST: &str = "coursewareSourceChangeLatest.v1";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceChange {
    change_group_id: String,
    baseline: CoursewareProject,
    target_source: String,
    associated: Option<CoursewareProject>,
    page_bindings: Vec<Option<String>>,
    effect_bindings: Vec<Value>,
}

fn key(workspace: &str, project_id: &str, id: &str) -> Result<String> {
    anyhow::ensure!(valid_id(id), "COURSEWARE_INVALID: invalid source change id");
    Ok(serde_json::to_string(&(
        storage_key(workspace, project_id)?,
        id,
    ))?)
}

impl Database {
    pub(super) fn prepare_source_change(
        &self,
        workspace: &str,
        review: &Review,
        target: &str,
    ) -> Result<()> {
        let key = key(workspace, &review.project.project_id, &review.review_id)?;
        let change = SourceChange {
            change_group_id: review.review_id.clone(),
            baseline: review.project.clone(),
            target_source: target.into(),
            associated: None,
            page_bindings: vec![],
            effect_bindings: vec![],
        };
        let expected = serde_json::to_value(&change)?;
        if let Some(existing) = self.kv_get(CHANGES, &key)? {
            anyhow::ensure!(
                existing == expected,
                "COURSEWARE_CONFLICT: source change already has a different result"
            );
        } else {
            self.kv_set(CHANGES, &key, &expected)?;
        }
        self.kv_set(
            LATEST,
            &storage_key(workspace, &review.project.project_id)?,
            &json!(review.review_id),
        )
    }

    pub(super) fn associate_source_change(
        &self,
        workspace: &str,
        review: &Review,
        next: &CoursewareProject,
        bindings: &[Option<String>],
        effects: &[Value],
    ) -> Result<()> {
        // Legacy pending reviews have no receipt; upgrade within the same adoption transaction.
        self.prepare_source_change(workspace, review, &next.source.sha256)?;
        let change = SourceChange {
            change_group_id: review.review_id.clone(),
            baseline: review.project.clone(),
            target_source: next.source.sha256.clone(),
            associated: Some(next.clone()),
            page_bindings: bindings.to_vec(),
            effect_bindings: effects.to_vec(),
        };
        self.kv_set(
            CHANGES,
            &key(workspace, &next.project_id, &review.review_id)?,
            &serde_json::to_value(change)?,
        )
    }

    pub(in crate::db::courseware_projects) fn source_change_context(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<Option<Value>> {
        let Some(id) = self.kv_get(LATEST, &storage_key(workspace, &project.project_id)?)? else {
            return Ok(None);
        };
        let id = id
            .as_str()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: invalid source change pointer"))?;
        let raw = self
            .kv_get(CHANGES, &key(workspace, &project.project_id, id)?)?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: source change receipt is missing"))?;
        let change: SourceChange = serde_json::from_value(raw)?;
        change.baseline.validate()?;
        anyhow::ensure!(
            change.change_group_id == id
                && change.baseline.project_id == project.project_id
                && change.target_source.len() == 64
                && change.target_source.bytes().all(|c| c.is_ascii_hexdigit())
                && change.target_source != change.baseline.source.sha256,
            "COURSEWARE_INVALID: invalid source change receipt"
        );
        let mut completed = vec!["source-saved"];
        let mut pending: Vec<&str> = vec![];
        let (phase, stale) = if let Some(associated) = &change.associated {
            associated.validate()?;
            anyhow::ensure!(
                associated.project_id == project.project_id
                    && associated.source.sha256 == change.target_source
                    && associated.pages.len() == change.page_bindings.len(),
                "COURSEWARE_INVALID: invalid source association receipt"
            );
            completed.push("source-associated");
            if project.source.sha256 != change.target_source {
                ("superseded", true)
            } else {
                // Derive readiness from current authoritative teaching; a later edit reopens review.
                pending = project
                    .pages
                    .iter()
                    .filter(|p| p.review_state != "ready")
                    .map(|p| p.page_id.as_str())
                    .collect();
                if pending.is_empty() {
                    completed.push("teaching-review");
                    ("complete", false)
                } else {
                    ("teaching-review", false)
                }
            }
        } else {
            (
                "source-review",
                serde_json::to_value(project)? != serde_json::to_value(&change.baseline)?,
            )
        };
        Ok(Some(
            json!({ "changeGroupId":id, "phase":phase, "stale":stale,
            "baselineSource":change.baseline.source.sha256, "baselineTeachingRevision":change.baseline.teaching_revision,
            "targetSource":change.target_source, "expected":["source-associated","teaching-review"], "completed":completed,
            "associationTeachingRevision":change.associated.as_ref().map(|p| &p.teaching_revision),
            "currentTeachingRevision":project.teaching_revision, "pendingPageIds":pending }),
        ))
    }
}
