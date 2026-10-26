//! Source copies and the explicit, recoverable Host adoption transaction.
use super::*;
use crate::courseware::{source_candidates::ParsedOutput, SavedProjectSeed};

const CANDIDATES: &str = "coursewareSourceCandidates.v1";

mod adoption;
mod attention;
mod batch;
pub use batch::{StyleBatchEvidence, StyleBatchScope};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    PagePptx,
    PageFade,
    #[serde(rename = "page-style-batch")]
    StyleBatch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceCandidateRequest {
    pub candidate_id: String,
    pub page_id: String,
    pub kind: Kind,
    pub expected_source_revision: String,
    pub expected_teaching_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_batch: Option<StyleBatchScope>,
}

/// Attestation retained by the production Main generator, never accepted from Chat or UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FadeEvidence {
    pub protocol: String,
    pub source_sha256: String,
    pub output_sha256: String,
    pub mapping_revision: String,
    pub page_id: String,
    pub slide_part: String,
}

/// Same strict wire fields; the redo protocol and candidate kind are checked independently.
pub type RedoEvidence = FadeEvidence;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Status {
    Preparing,
    NeedsReview,
    Rejected,
    Adopted,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Candidate {
    request: SourceCandidateRequest,
    baseline: CoursewareProject,
    mapping_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    asset_locks: Option<super::asset_locks::AssetLocks>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    preserved_images: Vec<super::asset_locks::PreservedImage>,
    output: Option<ParsedOutput>,
    status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fade_evidence: Option<FadeEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    redo_evidence: Option<RedoEvidence>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    batch_evidence: Option<StyleBatchEvidence>,
}

fn key(workspace: &str, project_id: &str, candidate_id: &str) -> Result<String> {
    anyhow::ensure!(
        valid_id(candidate_id),
        "COURSEWARE_INVALID: invalid candidate id"
    );
    Ok(serde_json::to_string(&(
        storage_key(workspace, project_id)?,
        candidate_id,
    ))?)
}

impl Candidate {
    fn verified(&self) -> bool {
        self.fade_evidence.is_some()
            || self.redo_evidence.is_some()
            || self.batch_evidence.is_some()
    }

    fn validate(&self) -> Result<()> {
        self.baseline.validate()?;
        let request = &self.request;
        self.validate_batch()?;
        anyhow::ensure!(
            valid_id(&request.candidate_id)
                && valid_id(&self.mapping_revision)
                && request.expected_source_revision == self.baseline.source.revision
                && request.expected_teaching_revision == self.baseline.teaching_revision
                && self
                    .baseline
                    .pages
                    .iter()
                    .any(|page| page.page_id == request.page_id && !page.locked)
                && (self.status != Status::NeedsReview || self.output.is_some())
                && (self.status != Status::Preparing || self.output.is_none()),
            "COURSEWARE_INVALID: invalid source candidate baseline"
        );
        anyhow::ensure!(
            self.status != Status::Adopted || (self.output.is_some() && self.verified()),
            "COURSEWARE_INVALID: adopted source requires verified output"
        );
        super::reviews::effects::referenced(&self.baseline)?;
        if let Some(output) = &self.output {
            output.validate()?;
            anyhow::ensure!(
                output.pages == self.baseline.pages.len()
                    && output.sha256 != self.baseline.source.sha256,
                "COURSEWARE_INVALID: candidate must change source and preserve page count"
            );
        }
        anyhow::ensure!(
            [
                self.fade_evidence.is_some(),
                self.redo_evidence.is_some(),
                self.batch_evidence.is_some()
            ]
            .into_iter()
            .filter(|present| *present)
            .count()
                <= 1,
            "COURSEWARE_INVALID: conflicting source candidate attestations"
        );
        for (proof, kind, protocol) in [
            (&self.fade_evidence, Kind::PageFade, "deckwise-main-fade/1"),
            (&self.redo_evidence, Kind::PagePptx, "deckwise-main-redo/1"),
        ] {
            let Some(proof) = proof else { continue };
            let number = proof
                .slide_part
                .strip_prefix("ppt/slides/slide")
                .and_then(|part| part.strip_suffix(".xml"));
            anyhow::ensure!(
                self.request.kind == kind
                    && proof.protocol == protocol
                    && proof.source_sha256 == self.baseline.source.sha256
                    && self
                        .output
                        .as_ref()
                        .is_some_and(|output| output.sha256 == proof.output_sha256)
                    && proof.mapping_revision == self.mapping_revision
                    && proof.page_id == self.request.page_id
                    && number.is_some_and(|number| !number.starts_with('0')
                        && !number.is_empty()
                        && number.bytes().all(|byte| byte.is_ascii_digit())),
                "COURSEWARE_INVALID: operation evidence differs from candidate"
            );
        }
        anyhow::ensure!(
            serde_json::to_vec(self)?.len() <= MAX_BYTES,
            "COURSEWARE_INVALID: candidate exceeds storage limit"
        );
        Ok(())
    }

    fn view(&self, stale: bool) -> Value {
        serde_json::json!({
            "candidateId": self.request.candidate_id, "projectId": self.baseline.project_id,
            "kind": self.request.kind, "targetPageIds": self.target_page_ids(),
            "source": self.baseline.source, "teachingRevision": self.baseline.teaching_revision,
            "mappingRevision": self.mapping_revision, "status": self.status, "stale": stale,
            "outputSha256": self.output.as_ref().map(|output| &output.sha256),
            "pageCount": self.output.as_ref().map(|output| output.pages), "applied": self.status == Status::Adopted,
            "lineageVerified": self.verified()
        })
    }
}

impl Database {
    fn source_candidate(
        &self,
        key: &str,
        project_id: &str,
        candidate_id: &str,
    ) -> Result<Candidate> {
        let candidate: Candidate = serde_json::from_value(
            self.kv_get(CANDIDATES, key)?
                .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: source candidate not found"))?,
        )?;
        candidate.validate()?;
        anyhow::ensure!(
            candidate.baseline.project_id == project_id
                && candidate.request.candidate_id == candidate_id,
            "COURSEWARE_INVALID: source candidate identity differs"
        );
        Ok(candidate)
    }

    fn source_candidate_current(&self, workspace: &str, candidate: &Candidate) -> Result<bool> {
        let Some(current) =
            self.get_courseware_project(workspace, &candidate.baseline.project_id)?
        else {
            return Ok(false);
        };
        Ok(
            serde_json::to_value(&current)? == serde_json::to_value(&candidate.baseline)?
                && self.courseware_mapping_revision(workspace, &current)?
                    == candidate.mapping_revision
                && self.courseware_asset_locks(workspace, &current.project_id)?
                    == candidate.asset_locks
                && self.batch_representative_current(workspace, candidate)?,
        )
    }

    fn save_source_candidate(
        &self,
        key: &str,
        previous: &str,
        candidate: &Candidate,
    ) -> Result<()> {
        candidate.validate()?;
        let changed = self.conn.execute(
            "UPDATE kv SET value_json=?1,updated_at=?2 WHERE ns=?3 AND key=?4 AND value_json=?5",
            params![
                serde_json::to_string(candidate)?,
                now_ms(),
                CANDIDATES,
                key,
                previous
            ],
        )?;
        anyhow::ensure!(
            changed == 1,
            "COURSEWARE_CONFLICT: source candidate changed"
        );
        Ok(())
    }

    pub fn prepare_source_candidate(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        request: SourceCandidateRequest,
    ) -> Result<Value> {
        let key = key(workspace, &seed.project_id, &request.candidate_id)?;
        let tx = self.conn.unchecked_transaction()?;
        let baseline = self
            .get_courseware_project(workspace, &seed.project_id)?
            .ok_or_else(|| {
                anyhow!("COURSEWARE_NOT_FOUND: initialize teaching before generation")
            })?;
        anyhow::ensure!(
            baseline.source.sha256 == seed.sha256 && baseline.pages.len() == seed.pages,
            "COURSEWARE_CONFLICT: saved source differs from project"
        );
        let mapping_revision = self.courseware_mapping_revision(workspace, &baseline)?;
        let saved = self
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(workspace, &seed.project_id, &seed.sha256)?,
            )?
            .unwrap_or(Value::Null);
        let saved =
            crate::courseware::identity::SavedSourceIdentity::parse(&serde_json::to_vec(&saved)?)?;
        anyhow::ensure!(
            seed.identity
                .as_ref()
                .is_some_and(|identity| saved.same_export(identity)),
            "COURSEWARE_CONFLICT: parsed source identity differs from saved mapping"
        );
        super::reviews::effects::projection(&baseline, saved.value(), saved.value())?;
        anyhow::ensure!(
            baseline.source.revision == request.expected_source_revision
                && baseline.teaching_revision == request.expected_teaching_revision,
            "COURSEWARE_CONFLICT: generation baseline changed"
        );
        let page = baseline
            .pages
            .iter()
            .find(|page| page.page_id == request.page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_PAGE_NOT_FOUND: logical page not found"))?;
        anyhow::ensure!(
            !page.locked,
            "COURSEWARE_LOCKED: candidate target is locked"
        );
        let targets: Vec<&str> = request
            .style_batch
            .as_ref()
            .map(|batch| batch.page_ids.iter().map(String::as_str).collect())
            .unwrap_or_else(|| vec![request.page_id.as_str()]);
        let asset_locks = self.candidate_asset_locks(workspace, &baseline, &targets)?;
        let candidate = Candidate {
            request,
            baseline,
            mapping_revision,
            asset_locks,
            preserved_images: vec![],
            output: None,
            status: Status::Preparing,
            fade_evidence: None,
            redo_evidence: None,
            batch_evidence: None,
        };
        candidate.validate()?;
        anyhow::ensure!(
            self.batch_representative_current(workspace, &candidate)?,
            "COURSEWARE_CONFLICT: batch representative is not current and verified"
        );
        if self.kv_get(CANDIDATES, &key)?.is_some() {
            let old =
                self.source_candidate(&key, &seed.project_id, &candidate.request.candidate_id)?;
            anyhow::ensure!(
                old.request == candidate.request
                    && serde_json::to_value(&old.baseline)?
                        == serde_json::to_value(&candidate.baseline)?
                    && old.mapping_revision == candidate.mapping_revision
                    && old.asset_locks == candidate.asset_locks,
                "COURSEWARE_CONFLICT: candidate id has different input"
            );
            tx.commit()?;
            return Ok(old.view(false));
        }
        self.conn.execute(
            "INSERT INTO kv (ns,key,value_json,updated_at) VALUES (?1,?2,?3,?4)",
            params![
                CANDIDATES,
                key,
                serde_json::to_string(&candidate)?,
                now_ms()
            ],
        )?;
        tx.commit()?;
        Ok(candidate.view(false))
    }

    pub fn stage_source_candidate(
        &self,
        workspace: &str,
        project_id: &str,
        candidate_id: &str,
        output: ParsedOutput,
    ) -> Result<Value> {
        self.stage_source_candidate_with_evidence(workspace, project_id, candidate_id, output, None)
    }

    pub fn stage_source_candidate_with_evidence(
        &self,
        workspace: &str,
        project_id: &str,
        candidate_id: &str,
        output: ParsedOutput,
        evidence: Option<FadeEvidence>,
    ) -> Result<Value> {
        self.stage_source_candidate_with_proofs(
            workspace,
            project_id,
            candidate_id,
            output,
            (evidence, None, None),
        )
    }

    pub fn stage_source_candidate_with_proofs(
        &self,
        workspace: &str,
        project_id: &str,
        candidate_id: &str,
        output: ParsedOutput,
        evidence: (
            Option<FadeEvidence>,
            Option<RedoEvidence>,
            Option<StyleBatchEvidence>,
        ),
    ) -> Result<Value> {
        self.stage_source_candidate_with_locked_proofs(
            workspace,
            project_id,
            candidate_id,
            output,
            evidence,
            vec![],
        )
    }

    pub fn stage_source_candidate_with_locked_proofs(
        &self,
        workspace: &str,
        project_id: &str,
        candidate_id: &str,
        output: ParsedOutput,
        evidence: (
            Option<FadeEvidence>,
            Option<RedoEvidence>,
            Option<StyleBatchEvidence>,
        ),
        preserved_images: Vec<super::asset_locks::PreservedImage>,
    ) -> Result<Value> {
        let (fade_evidence, redo_evidence, batch_evidence) = evidence;
        let key = key(workspace, project_id, candidate_id)?;
        let tx = self.conn.unchecked_transaction()?;
        let mut candidate = self.source_candidate(&key, project_id, candidate_id)?;
        anyhow::ensure!(
            !matches!(candidate.status, Status::Rejected | Status::Adopted),
            "COURSEWARE_CONFLICT: source candidate is resolved"
        );
        anyhow::ensure!(
            self.source_candidate_current(workspace, &candidate)?,
            "COURSEWARE_CONFLICT: generation baseline changed"
        );
        let previous = serde_json::to_string(&candidate)?;
        output.validate()?;
        if fade_evidence.is_some() || redo_evidence.is_some() || batch_evidence.is_some() {
            let saved = self
                .kv_get(
                    identities::IDENTITY_NAMESPACE,
                    &identities::identity_key(
                        workspace,
                        project_id,
                        &candidate.baseline.source.sha256,
                    )?,
                )?
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: original identity is missing"))?;
            verify_candidate_identity(
                &saved,
                output.identity.as_ref().unwrap(),
                &if redo_evidence.is_some() || batch_evidence.is_some() {
                    candidate.target_page_ids()
                } else {
                    vec![]
                },
            )?;
            super::asset_locks::verify_preserved_images(
                &saved,
                output.identity.as_ref().unwrap(),
                &if redo_evidence.is_some() || batch_evidence.is_some() {
                    candidate.target_page_ids()
                } else {
                    vec![]
                },
                &candidate.asset_locks,
                &preserved_images,
            )?;
        }
        anyhow::ensure!(
            candidate.preserved_images.is_empty() || candidate.preserved_images == preserved_images,
            "COURSEWARE_CONFLICT: locked-image evidence differs"
        );
        candidate.preserved_images = preserved_images;
        if let Some(previous) = &candidate.output {
            anyhow::ensure!(
                previous == &output,
                "COURSEWARE_CONFLICT: candidate output differs"
            );
        } else {
            candidate.output = Some(output);
            candidate.status = Status::NeedsReview;
        }
        for (stored, evidence) in [
            (&mut candidate.fade_evidence, fade_evidence),
            (&mut candidate.redo_evidence, redo_evidence),
        ] {
            let Some(evidence) = evidence else { continue };
            anyhow::ensure!(
                stored.as_ref().is_none_or(|old| old == &evidence),
                "COURSEWARE_CONFLICT: operation evidence differs"
            );
            *stored = Some(evidence);
        }
        if let Some(proof) = batch_evidence {
            anyhow::ensure!(
                candidate
                    .batch_evidence
                    .as_ref()
                    .is_none_or(|old| old == &proof),
                "COURSEWARE_CONFLICT: batch evidence differs"
            );
            candidate.batch_evidence = Some(proof);
        }
        if serde_json::to_string(&candidate)? != previous {
            self.save_source_candidate(&key, &previous, &candidate)?;
        }
        tx.commit()?;
        Ok(candidate.view(false))
    }

    pub fn get_source_candidate(
        &self,
        workspace: &str,
        project_id: &str,
        candidate_id: &str,
    ) -> Result<Value> {
        let candidate = self.source_candidate(
            &key(workspace, project_id, candidate_id)?,
            project_id,
            candidate_id,
        )?;
        let stale = !self.source_candidate_current(workspace, &candidate)?;
        let mut view = candidate.view(stale);
        if let Some((targets, pages)) = attention::review(self, workspace, &candidate)? {
            view["effectTargets"] = targets;
            view["effectPages"] = pages;
        }
        Ok(view)
    }

    /// Private generator input derived only from the current Host-bound identity.
    pub fn source_candidate_context(
        &self,
        workspace: &str,
        project_id: &str,
        candidate_id: &str,
    ) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let candidate = self.source_candidate(
            &key(workspace, project_id, candidate_id)?,
            project_id,
            candidate_id,
        )?;
        anyhow::ensure!(
            !matches!(candidate.status, Status::Rejected | Status::Adopted)
                && self.source_candidate_current(workspace, &candidate)?,
            "COURSEWARE_CONFLICT: source candidate is stale or rejected"
        );
        let mapping = self.courseware_mapping(workspace, &candidate.baseline)?;
        let context = serde_json::json!({
            "candidate": candidate.view(false),
            "mapping": mapping, "assetLocks": candidate.asset_locks
        });
        tx.commit()?;
        Ok(context)
    }

    pub fn reject_source_candidate(
        &self,
        workspace: &str,
        project_id: &str,
        candidate_id: &str,
    ) -> Result<Value> {
        let key = key(workspace, project_id, candidate_id)?;
        let mut candidate = self.source_candidate(&key, project_id, candidate_id)?;
        anyhow::ensure!(
            candidate.status != Status::Adopted,
            "COURSEWARE_CONFLICT: adopted source cannot be rejected"
        );
        if candidate.status != Status::Rejected {
            let previous = serde_json::to_string(&candidate)?;
            candidate.status = Status::Rejected;
            self.save_source_candidate(&key, &previous, &candidate)?;
        }
        Ok(candidate.view(!self.source_candidate_current(workspace, &candidate)?))
    }
}

fn verify_candidate_identity(
    source: &Value,
    output: &Value,
    replaced_pages: &[&str],
) -> Result<()> {
    let source =
        crate::courseware::identity::SavedSourceIdentity::parse(&serde_json::to_vec(source)?)?;
    let output =
        crate::courseware::identity::SavedSourceIdentity::parse(&serde_json::to_vec(output)?)?;
    let pages = |identity: &Value| {
        identity["pages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|page| {
                let mut page = page.clone();
                page.as_object_mut().unwrap().remove("logicalId");
                for object in page["objects"].as_array_mut().unwrap() {
                    object.as_object_mut().unwrap().remove("logicalId");
                }
                page
            })
            .collect::<Vec<_>>()
    };
    let before = pages(source.value());
    let after = pages(output.value());
    let replaced = replaced_pages
        .iter()
        .map(|id| {
            source.value()["pages"]
                .as_array()
                .unwrap()
                .iter()
                .position(|page| page["logicalId"] == *id)
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: replacement target is missing"))
        })
        .collect::<Result<Vec<_>>>()?;
    anyhow::ensure!(
        before.len() == after.len()
            && before
                .iter()
                .zip(&after)
                .enumerate()
                .all(|(index, (before, after))| {
                    before["importPageId"] == after["importPageId"]
                        && (replaced.contains(&index) || before == after)
                }),
        "COURSEWARE_INVALID: candidate changed non-target content, page order or object identity"
    );
    Ok(())
}

#[cfg(test)]
mod redo_tests;
#[cfg(test)]
mod tests;
