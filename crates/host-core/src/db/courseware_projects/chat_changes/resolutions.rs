//! Explicit human disposition of a declared request; never a claim that every tool succeeded.
use super::*;
use sha2::{Digest, Sha256};

pub(super) const RESOLUTIONS: &str = "coursewareChatResolutions.v1";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolutionRequest {
    pub change_group_id: String,
    pub receipt_sha256: String,
    pub note: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Resolution {
    change_group_id: String,
    session_id: String,
    receipt_sha256: String,
    note: String,
    source: CoursewareSource,
    teaching_revision: String,
    project_sha256: String,
}

pub(super) fn digest(change: &Change) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(
        &serde_json::to_value(change)?,
    )?)))
}

impl Database {
    pub(super) fn chat_resolution(&self, key: &str, change: &Change) -> Result<Option<Value>> {
        let Some(value) = self.kv_get(RESOLUTIONS, key)? else {
            return Ok(None);
        };
        let r: Resolution = serde_json::from_value(value)?;
        let hash = |s: &str| {
            s.len() == 64
                && s.bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        };
        anyhow::ensure!(
            change.plan.is_some()
                && r.change_group_id == change.change_group_id
                && r.session_id == change.session_id
                && r.receipt_sha256 == digest(change)?
                && !r.note.trim().is_empty()
                && r.note.encode_utf16().count() <= 500
                && valid_id(&r.teaching_revision)
                && valid_id(&r.source.revision)
                && hash(&r.source.sha256)
                && hash(&r.project_sha256),
            "COURSEWARE_INVALID: invalid Chat resolution"
        );
        Ok(Some(serde_json::to_value(r)?))
    }

    /// Confirm the current page and close one reviewed request atomically, preserving newer content.
    pub fn resolve_courseware_chat_change(
        &self,
        workspace: &str,
        session_id: &str,
        project_id: &str,
        page_id: &str,
        expected_source: &str,
        expected_teaching: &str,
        request: &ResolutionRequest,
    ) -> Result<CoursewareProject> {
        anyhow::ensure!(
            valid_id(&request.change_group_id)
                && !request.note.trim().is_empty()
                && request.note.encode_utf16().count() <= 500,
            "COURSEWARE_INVALID: a bounded explicit disposition note is required"
        );
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        let scope = storage_key(workspace, project_id)?;
        let prefix = format!("[{},", serde_json::to_string(&scope)?);
        let mut statement = self
            .conn
            .prepare("SELECT key,value_json FROM kv WHERE ns=?1 AND substr(key,1,length(?2))=?2")?;
        let rows = statement
            .query_map(params![PLANNED_CHANGES, prefix], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut found = None;
        for (key, raw) in rows {
            let change = read(serde_json::from_str(&raw)?)?;
            if change.change_group_id == request.change_group_id {
                found = Some((key, change));
                break;
            }
        }
        let (key, change) =
            found.ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: declared Chat change not found"))?;
        anyhow::ensure!(change.session_id == session_id && digest(&change)? == request.receipt_sha256
            && self.chat_resolution(&key, &change)?.is_none(),
            "COURSEWARE_CONFLICT: Chat owner, receipt or resolution changed; reload before reviewing");
        let original = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        let target = &change
            .plan
            .as_ref()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing declaration"))?
            .page_id;
        anyhow::ensure!(
            if original.pages.iter().any(|page| &page.page_id == target) {
                page_id == target
            } else {
                true
            },
            "COURSEWARE_CONFLICT: review the requested page"
        );
        let next = self.review_courseware_page(
            workspace,
            project_id,
            page_id,
            expected_source,
            expected_teaching,
        )?;
        let history_key = serde_json::to_string(&(&scope, &original.teaching_revision))?;
        self.conn.execute(
            "INSERT OR IGNORE INTO kv (ns,key,value_json,updated_at) VALUES (?1,?2,?3,?4)",
            params![
                HISTORY_NAMESPACE,
                history_key,
                serde_json::to_string(&original)?,
                now_ms()
            ],
        )?;
        let resolution = Resolution {
            change_group_id: change.change_group_id.clone(),
            session_id: session_id.into(),
            receipt_sha256: request.receipt_sha256.clone(),
            note: request.note.trim().into(),
            source: next.source.clone(),
            teaching_revision: next.teaching_revision.clone(),
            project_sha256: hex::encode(Sha256::digest(serde_json::to_vec(
                &serde_json::to_value(&next)?,
            )?)),
        };
        self.kv_set(RESOLUTIONS, &key, &serde_json::to_value(resolution)?)?;
        anyhow::ensure!(
            self.chat_resolution(&key, &change)?.is_some(),
            "COURSEWARE_CONFLICT: Chat disposition was not saved"
        );
        tx.commit()?;
        self.source_adoption_barrier()?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests;
