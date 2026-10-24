//! Finite confirmed scope; Main still owns human review and ZIP operation semantics.
use super::*;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StyleBatchScope {
    pub representative_candidate_id: String,
    pub representative_output_sha256: String,
    pub instruction_hash: String,
    pub page_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StyleBatchTarget {
    pub page_id: String,
    pub slide_part: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StyleBatchEvidence {
    pub protocol: String,
    pub source_sha256: String,
    pub output_sha256: String,
    pub mapping_revision: String,
    pub targets: Vec<StyleBatchTarget>,
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Candidate {
    pub(super) fn target_page_ids(&self) -> Vec<&str> {
        match &self.request.style_batch {
            Some(scope) => scope.page_ids.iter().map(String::as_str).collect(),
            None => vec![self.request.page_id.as_str()],
        }
    }

    pub(super) fn validate_batch(&self) -> Result<()> {
        let Some(scope) = &self.request.style_batch else {
            anyhow::ensure!(
                self.request.kind != Kind::StyleBatch && self.batch_evidence.is_none(),
                "COURSEWARE_INVALID: batch scope is missing"
            );
            return Ok(());
        };
        anyhow::ensure!(
            self.request.kind == Kind::StyleBatch
                && valid_id(&scope.representative_candidate_id)
                && scope.representative_candidate_id != self.request.candidate_id
                && hash(&scope.representative_output_sha256)
                && scope
                    .instruction_hash
                    .strip_prefix("sha256:")
                    .is_some_and(hash)
                && (2..=20).contains(&scope.page_ids.len())
                && scope.page_ids.iter().collect::<HashSet<_>>().len() == scope.page_ids.len()
                && scope.page_ids.contains(&self.request.page_id)
                && scope.page_ids.iter().all(|id| self
                    .baseline
                    .pages
                    .iter()
                    .any(|page| page.page_id == *id && !page.locked)),
            "COURSEWARE_INVALID: invalid confirmed batch scope"
        );
        if let Some(proof) = &self.batch_evidence {
            anyhow::ensure!(
                proof.protocol == "deckwise-main-style-batch/1"
                    && proof.source_sha256 == self.baseline.source.sha256
                    && self
                        .output
                        .as_ref()
                        .is_some_and(|out| out.sha256 == proof.output_sha256)
                    && proof.mapping_revision == self.mapping_revision
                    && proof
                        .targets
                        .iter()
                        .map(|t| &t.page_id)
                        .eq(scope.page_ids.iter())
                    && proof
                        .targets
                        .iter()
                        .map(|t| &t.slide_part)
                        .collect::<HashSet<_>>()
                        .len()
                        == scope.page_ids.len()
                    && proof.targets.iter().all(|target| target
                        .slide_part
                        .strip_prefix("ppt/slides/slide")
                        .and_then(|s| s.strip_suffix(".xml"))
                        .is_some_and(
                            |s| !s.starts_with('0') && s.parse::<u32>().is_ok_and(|n| n > 0)
                        )),
                "COURSEWARE_INVALID: batch evidence differs from confirmed scope"
            );
        }
        Ok(())
    }
}

impl Database {
    pub(super) fn batch_representative_current(
        &self,
        workspace: &str,
        candidate: &Candidate,
    ) -> Result<bool> {
        let Some(scope) = &candidate.request.style_batch else {
            return Ok(true);
        };
        // validate_batch forbids self-reference and only a single-page representative is eligible.
        let representative = self.source_candidate(
            &key(
                workspace,
                &candidate.baseline.project_id,
                &scope.representative_candidate_id,
            )?,
            &candidate.baseline.project_id,
            &scope.representative_candidate_id,
        )?;
        Ok(representative.request.kind == Kind::PagePptx
            && representative.redo_evidence.is_some()
            && representative.status == Status::NeedsReview
            && representative.request.page_id == candidate.request.page_id
            && representative
                .output
                .as_ref()
                .is_some_and(|out| out.sha256 == scope.representative_output_sha256)
            && representative.mapping_revision == candidate.mapping_revision
            && representative.asset_locks == candidate.asset_locks
            && serde_json::to_value(&representative.baseline)?
                == serde_json::to_value(&candidate.baseline)?)
    }
}

#[cfg(test)]
mod tests;
