use super::*;
use sha2::{Digest, Sha256};

const ADOPTIONS: &str = "coursewareChatCandidateAdoptions.v1";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Adoption {
    project_id: String,
    candidate_id: String,
    kind: String,
    source: CoursewareSource,
    teaching_revision: String,
    pages: Vec<PageProof>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageProof {
    page_id: String,
    actions_sha256: String,
}

fn actions_hash(actions: &[Value]) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(actions)?)))
}

fn key(workspace: &str, project: &str, candidate: &str, kind: &str) -> Result<String> {
    anyhow::ensure!(
        valid_id(candidate)
            && matches!(
                kind,
                "page-narration" | "page-pptx" | "page-fade" | "page-style-batch"
            ),
        "COURSEWARE_INVALID: invalid candidate adoption identity"
    );
    Ok(serde_json::to_string(&(
        storage_key(workspace, project)?,
        candidate,
        kind,
    ))?)
}

impl Database {
    /// The caller's candidate/teaching transaction also commits this immutable result reference.
    pub(in crate::db::courseware_projects) fn record_chat_candidate_adoption(
        &self,
        workspace: &str,
        next: &CoursewareProject,
        candidate_id: &str,
        kind: &str,
        page_ids: &[&str],
    ) -> Result<()> {
        anyhow::ensure!(
            !self.conn.is_autocommit(),
            "COURSEWARE_INVALID: adoption receipt requires the candidate transaction"
        );
        next.validate()?;
        let receipt = Adoption {
            project_id: next.project_id.clone(),
            candidate_id: candidate_id.into(),
            kind: kind.into(),
            source: next.source.clone(),
            teaching_revision: next.teaching_revision.clone(),
            pages: page_ids
                .iter()
                .map(|id| {
                    let page = next
                        .pages
                        .iter()
                        .find(|page| page.page_id == *id)
                        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: adopted page is missing"))?;
                    Ok(PageProof {
                        page_id: (*id).into(),
                        actions_sha256: actions_hash(&page.actions)?,
                    })
                })
                .collect::<Result<Vec<_>>>()?,
        };
        let key = key(workspace, &next.project_id, candidate_id, kind)?;
        let value = serde_json::to_value(receipt)?;
        anyhow::ensure!(
            !page_ids.is_empty()
                && page_ids.len() <= 100
                && self.kv_get(ADOPTIONS, &key)?.is_none(),
            "COURSEWARE_CONFLICT: candidate adoption already recorded or invalid page scope"
        );
        self.kv_set(ADOPTIONS, &key, &value)
    }

    pub(super) fn chat_candidate_progress(
        &self,
        workspace: &str,
        project: &CoursewareProject,
        candidate_id: &str,
        kind: &str,
        status: &str,
        stale: bool,
    ) -> Result<Value> {
        let raw = self.kv_get(
            ADOPTIONS,
            &key(workspace, &project.project_id, candidate_id, kind)?,
        )?;
        if status != "adopted" {
            anyhow::ensure!(
                raw.is_none(),
                "COURSEWARE_CONFLICT: unadopted candidate has an adoption receipt"
            );
            return Ok(json!({"candidateId": candidate_id, "status": match status {
                "needs-review" => if stale { "stale" } else { "needs-review" },
                "rejected" => "rejected", _ => "unknown",
            }}));
        }
        // Legacy adopted candidates have no immutable result receipt; never invent one from current teaching.
        let Some(raw) = raw else {
            return Ok(json!({"candidateId": candidate_id, "status": "unknown"}));
        };
        let adoption: Adoption = serde_json::from_value(raw)?;
        let valid_hash = |value: &str| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        let unique: std::collections::HashSet<_> =
            adoption.pages.iter().map(|page| &page.page_id).collect();
        anyhow::ensure!(
            adoption.project_id == project.project_id
                && adoption.candidate_id == candidate_id
                && adoption.kind == kind
                && valid_id(&adoption.source.revision)
                && valid_hash(&adoption.source.sha256)
                && valid_id(&adoption.teaching_revision)
                && !adoption.pages.is_empty()
                && adoption.pages.len() <= 100
                && unique.len() == adoption.pages.len()
                && adoption
                    .pages
                    .iter()
                    .all(|page| valid_id(&page.page_id) && valid_hash(&page.actions_sha256)),
            "COURSEWARE_INVALID: invalid candidate adoption receipt"
        );
        let mut current = adoption.source.revision == project.source.revision
            && adoption.source.sha256 == project.source.sha256;
        for proof in &adoption.pages {
            current &= match project
                .pages
                .iter()
                .find(|page| page.page_id == proof.page_id)
            {
                Some(page) => actions_hash(&page.actions)? == proof.actions_sha256,
                None => false,
            };
        }
        Ok(
            json!({"candidateId": candidate_id, "status": if current {"adopted"} else {"superseded"},
            "sourceSha256":adoption.source.sha256, "teachingRevision":adoption.teaching_revision,
            "pageIds":adoption.pages.iter().map(|page| &page.page_id).collect::<Vec<_>>() }),
        )
    }
}
