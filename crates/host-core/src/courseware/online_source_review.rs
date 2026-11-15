//! Temporary review projections for remote sources; never adopts teaching or edits files.
use super::*;
use crate::db::courseware_projects::{CoursewareProject, CoursewareSource};
use sha2::{Digest, Sha256};
use std::time::Instant;

mod resolve;
pub use resolve::ResolveRequest;

const TTL: Duration = Duration::from_secs(600);
const MAX_CACHE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub source: CoursewareSource,
    pub byte_length: u64,
    pub session_epoch: u64,
    pub callback_id: String,
}

struct Baseline {
    id: String,
    session_id: String,
    workspace: PathBuf,
    created: Instant,
    project: CoursewareProject,
    mapping: Value,
    identity: identity::SavedSourceIdentity,
}

#[derive(Default)]
pub(super) struct ReviewCache(Option<Baseline>);

fn bounded(value: Value, limit: usize) -> Result<Value> {
    anyhow::ensure!(
        serde_json::to_vec(&value)?.len() <= limit,
        "COURSEWARE_INVALID: online source review exceeds size limit"
    );
    Ok(value)
}

impl ReviewCache {
    pub(super) fn clear(&mut self) {
        self.0 = None;
    }

    fn baseline(
        &mut self,
        session_id: &str,
        workspace: &Path,
        parsed: source_candidates::ParsedOutput,
        project: CoursewareProject,
        mapping: Value,
    ) -> Result<Value> {
        self.clear();
        project.validate_online()?;
        parsed.validate()?;
        anyhow::ensure!(
            mapping.as_object().is_some_and(|fields| fields.len() == 3
                && ["revision", "sourceSha256", "pages"]
                    .iter()
                    .all(|key| fields.contains_key(*key)))
                && project.source.sha256 == parsed.sha256
                && project.pages.len() == parsed.pages,
            "COURSEWARE_INVALID: online baseline source or mapping differs"
        );
        let mut pinned = mapping.clone();
        pinned["sourceRevision"] = json!(project.source.revision);
        let fresh = identity::SavedSourceIdentity::parse(&serde_json::to_vec(&parsed.identity)?)?;
        let identity = fresh.bind_mapping(&pinned)?;
        anyhow::ensure!(
            project
                .pages
                .iter()
                .zip(identity.value()["pages"].as_array().unwrap())
                .all(|(page, bound)| page.page_id == bound["logicalId"]),
            "COURSEWARE_CONFLICT: teaching page order differs from baseline mapping"
        );
        bounded(
            json!({"project":project,"mapping":mapping,"identity":identity.value()}),
            MAX_CACHE_BYTES,
        )?;
        let baseline = Baseline {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.into(),
            workspace: workspace.canonicalize()?,
            created: Instant::now(),
            project,
            mapping,
            identity,
        };
        let view = json!({"baselineId":baseline.id,"projectId":baseline.project.project_id,
            "source":baseline.project.source,"teachingRevision":baseline.project.teaching_revision,
            "mappingRevision":baseline.mapping["revision"]});
        self.0 = Some(baseline);
        Ok(view)
    }

    fn owned(
        &mut self,
        session_id: &str,
        workspace: &Path,
        baseline_id: &str,
    ) -> Result<&Baseline> {
        if self
            .0
            .as_ref()
            .is_some_and(|baseline| baseline.created.elapsed() >= TTL)
        {
            self.clear();
        }
        let baseline = self.0.as_ref().ok_or_else(|| {
            anyhow!("COURSEWARE_CONFLICT: online baseline expired or unavailable")
        })?;
        anyhow::ensure!(
            baseline.id == baseline_id
                && baseline.session_id == session_id
                && baseline.workspace == workspace.canonicalize()?,
            "COURSEWARE_CONFLICT: online baseline belongs to another review context"
        );
        Ok(baseline)
    }

    fn review(
        &mut self,
        session_id: &str,
        workspace: &Path,
        baseline_id: &str,
        parsed: source_candidates::ParsedOutput,
        target: Target,
    ) -> Result<Value> {
        parsed.validate()?;
        anyhow::ensure!(
            uuid::Uuid::parse_str(&target.source.revision)
                .is_ok_and(|id| id.to_string() == target.source.revision)
                && target.source.sha256 == parsed.sha256
                && (1..=20 * 1024 * 1024).contains(&target.byte_length)
                && (1..=9_007_199_254_740_991).contains(&target.session_epoch)
                && target.callback_id.len() == 64
                && target
                    .callback_id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "COURSEWARE_INVALID: invalid final source archive pins"
        );
        let baseline = self.owned(session_id, workspace, baseline_id)?;
        anyhow::ensure!(
            target.source.revision != baseline.project.source.revision,
            "COURSEWARE_INVALID: final source revision must differ from baseline"
        );
        let previous: Vec<_> = baseline.identity.value()["pages"].as_array().unwrap().iter().enumerate().map(|(index,page)| json!({
            "pageId":page["logicalId"],"pageNumber":index+1,
            "objects":page["objects"].as_array().unwrap().iter().enumerate().map(|(index,object)| json!({
                "objectId":object["logicalId"],"index":index+1,"kind":object["type"]
            })).collect::<Vec<_>>()
        })).collect();
        let pages: Vec<_> = parsed.identity.as_ref().unwrap()["pages"].as_array().unwrap().iter().enumerate().map(|(index,page)| json!({
            "pageNumber":index+1,"importPageId":page["importPageId"],
            "objects":page["objects"].as_array().unwrap().iter().enumerate().map(|(index,object)| json!({
                "importElementId":object["importElementId"],"index":index+1,"kind":object["type"]
            })).collect::<Vec<_>>()
        })).collect();
        let mut view = json!({"baselineId":baseline.id,"original":{"project":baseline.project,"mapping":baseline.mapping},
            "previousPages":previous,"target":{"source":target.source,"byteLength":target.byte_length,
                "sessionEpoch":target.session_epoch,"callbackId":target.callback_id,"pages":pages},
            "requiresExplicitAssociations":true});
        view["reviewId"] = hex::encode(Sha256::digest(serde_json::to_vec(&view)?)).into();
        bounded(view, MAX_RESPONSE_BYTES)
    }
}

impl Parser {
    pub fn invalidate_online_source_review(&mut self) {
        self.online_review.clear();
    }

    pub fn online_source_baseline(
        &mut self,
        session_id: &str,
        workspace: &Path,
        job_id: &str,
        source_byte_length: u64,
        project: CoursewareProject,
        mapping: Value,
    ) -> Result<Value> {
        // An invalid replacement cannot leave an older baseline accidentally confirmable.
        self.online_review.clear();
        let (parsed, _) = self.verified_online_source(
            job_id,
            workspace,
            &project.source.sha256,
            source_byte_length,
        )?;
        self.online_review
            .baseline(session_id, workspace, parsed, project, mapping)
    }

    pub fn online_source_review(
        &mut self,
        session_id: &str,
        workspace: &Path,
        baseline_id: &str,
        job_id: &str,
        target: Target,
    ) -> Result<Value> {
        self.online_review
            .owned(session_id, workspace, baseline_id)?;
        let (parsed, _) = self.verified_online_source(
            job_id,
            workspace,
            &target.source.sha256,
            target.byte_length,
        )?;
        self.online_review
            .review(session_id, workspace, baseline_id, parsed, target)
    }

    pub fn clear_online_source_review(
        &mut self,
        session_id: &str,
        workspace: &Path,
        baseline_id: &str,
    ) -> Result<Value> {
        self.online_review
            .owned(session_id, workspace, baseline_id)?;
        self.online_review.clear();
        Ok(json!({"cleared":true}))
    }
}

#[cfg(test)]
mod tests;
