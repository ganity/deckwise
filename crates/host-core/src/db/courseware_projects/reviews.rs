//! Explicit human page association for an already-saved PPTX; never replaces source files.
use super::identities::{identity_key, IDENTITY_NAMESPACE};
use super::*;
use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};

const REVIEW_NAMESPACE: &str = "coursewareReviews.v1";
#[cfg(test)]
mod change_group_tests;
mod change_groups;
pub(crate) mod effects;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Review {
    review_id: String,
    project: CoursewareProject,
    previous_mapping_revision: String,
    identity: Value,
}

fn source_identity(seed: &SavedProjectSeed) -> Result<&SavedSourceIdentity> {
    let identity = seed
        .identity
        .as_ref()
        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: saved-source identity worker is required"))?;
    anyhow::ensure!(
        identity.matches_source(&seed.sha256, seed.pages)
            && identity.value().get("mappingRevision").is_none(),
        "COURSEWARE_INVALID: invalid review identity"
    );
    Ok(identity)
}

pub(super) fn portable_narration(project: &CoursewareProject, preserve_audio: bool) -> Result<()> {
    // shortcut: saved-source review rebinds adopted audio; cues/effects still need object-specific review.
    anyhow::ensure!(
        project.pages.iter().flat_map(|page| &page.actions).all(|action| {
            (preserve_audio && music::valid_clip(action)) || super::video::valid_clip(action) || super::video::valid_slot(action) || valid_teaching_checkpoint(action) || valid_teaching_delay(action)
                || (action["type"] == "speech" && action["text"].is_string()
                    && action.as_object().is_some_and(|object| object.keys().all(|key| ["id", "type", "text", "source", "pauseAfterMs", "audioAssetId"].contains(&key.as_str())))
                    && action.get("source").is_none_or(|source| matches!(source.as_str(), Some("notes" | "external" | "original" | "light_rewrite" | "generated")))
                    && action.get("audioAssetId").is_none_or(|asset| preserve_audio && asset.as_str().and_then(|value| value.strip_prefix("tts-")).is_some_and(|hash| hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))))
                    && action.get("pauseAfterMs").is_none_or(|pause| pause.as_u64().is_some_and(|pause| pause <= 30000)))
        }),
        "COURSEWARE_INVALID: source review supports speech, adopted TTS audio, bounded pauses and teacher-led checkpoints only; cues and effects require separate review"
    );
    Ok(())
}

impl Database {
    pub(super) fn courseware_mapping_revision(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<String> {
        let key = identity_key(workspace, &project.project_id, &project.source.sha256)?;
        let value = self.kv_get(IDENTITY_NAMESPACE, &key)?.ok_or_else(|| {
            anyhow!("COURSEWARE_INVALID: previous saved-source identity is unavailable")
        })?;
        let identity = SavedSourceIdentity::parse(&serde_json::to_vec(&value)?)?;
        let pages = identity.value()["pages"]
            .as_array()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing identity pages"))?;
        anyhow::ensure!(
            identity.matches_source(&project.source.sha256, project.pages.len())
                && pages
                    .iter()
                    .zip(&project.pages)
                    .all(|(page, canonical)| page["logicalId"] == canonical.page_id),
            "COURSEWARE_INVALID: previous page identities differ"
        );
        identity.value()["mappingRevision"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: previous mapping revision is missing"))
    }

    pub fn prepare_courseware_review(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
    ) -> Result<Value> {
        let identity = source_identity(seed)?;
        let tx = self.conn.unchecked_transaction()?;
        let project = self
            .get_courseware_project(workspace, &seed.project_id)?
            .ok_or_else(|| {
                anyhow!("COURSEWARE_NOT_FOUND: initialize teaching before reviewing source changes")
            })?;
        anyhow::ensure!(
            project.source.sha256 != seed.sha256,
            "COURSEWARE_INVALID: source has not changed"
        );
        effects::referenced(&project)?;
        let previous_mapping_revision = self.courseware_mapping_revision(workspace, &project)?;
        let previous_identity = self
            .kv_get(
                IDENTITY_NAMESPACE,
                &identity_key(workspace, &project.project_id, &project.source.sha256)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: previous identity is missing"))?;
        let (effect_targets, target_pages) =
            effects::projection(&project, &previous_identity, identity.value())?;
        let key = storage_key(workspace, &seed.project_id)?;
        let previous: Option<Review> = self
            .kv_get(REVIEW_NAMESPACE, &key)?
            .map(serde_json::from_value)
            .transpose()?;
        let review = if let Some(previous) = previous.filter(|previous| {
            serde_json::to_value(&previous.project).ok() == serde_json::to_value(&project).ok()
                && previous.previous_mapping_revision == previous_mapping_revision
                && &previous.identity == identity.value()
        }) {
            previous
        } else {
            Review {
                review_id: uuid::Uuid::new_v4().to_string(),
                project,
                previous_mapping_revision,
                identity: identity.value().clone(),
            }
        };
        self.kv_set(REVIEW_NAMESPACE, &key, &serde_json::to_value(&review)?)?;
        self.prepare_source_change(workspace, &review, &seed.sha256)?;
        tx.commit()?;
        Ok(
            serde_json::json!({ "reviewId": review.review_id, "project": review.project, "pageCount": seed.pages, "targetSha256": seed.sha256,
                "effectTargets":effect_targets,"targetPages":target_pages }),
        )
    }

    #[cfg(test)]
    pub fn adopt_courseware_review(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        review_id: &str,
        bindings: &[Option<String>],
    ) -> Result<CoursewareProject> {
        self.adopt_courseware_review_with_effects(workspace, seed, review_id, bindings, &[])
    }

    pub fn adopt_courseware_review_with_effects(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        review_id: &str,
        bindings: &[Option<String>],
        effect_bindings: &[Value],
    ) -> Result<CoursewareProject> {
        anyhow::ensure!(
            valid_id(review_id) && bindings.len() == seed.pages,
            "COURSEWARE_INVALID: invalid review bindings"
        );
        let identity = source_identity(seed)?;
        let tx = self.conn.unchecked_transaction()?;
        let key = storage_key(workspace, &seed.project_id)?;
        let record = self.kv_get(REVIEW_NAMESPACE, &key)?.ok_or_else(|| {
            anyhow!("COURSEWARE_CONFLICT: review expired; review the saved source again")
        })?;
        let review: Review = serde_json::from_value(record.clone())?;
        let project = self
            .get_courseware_project(workspace, &seed.project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        anyhow::ensure!(
            review.review_id == review_id
                && serde_json::to_value(&project)? == serde_json::to_value(&review.project)?
                && self.courseware_mapping_revision(workspace, &project)?
                    == review.previous_mapping_revision
                && &review.identity == identity.value()
                && project.source.sha256 != seed.sha256,
            "COURSEWARE_CONFLICT: source, teaching or identity changed during review"
        );
        let effect_targets = effects::referenced(&project)?;
        let previous_identity = self
            .kv_get(
                IDENTITY_NAMESPACE,
                &identity_key(workspace, &project.project_id, &project.source.sha256)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: previous identity is missing"))?;
        let mut used = std::collections::HashSet::new();
        for id in bindings.iter().flatten() {
            anyhow::ensure!(
                used.insert(id) && project.pages.iter().any(|page| &page.page_id == id),
                "COURSEWARE_INVALID: duplicate or unknown old page binding"
            );
        }
        anyhow::ensure!(
            project
                .pages
                .iter()
                .filter(|page| page.locked)
                .all(|page| used.contains(&page.page_id)),
            "COURSEWARE_LOCKED: every locked old page must be associated exactly once"
        );
        anyhow::ensure!(
            effect_targets.iter().all(|(page, _)| used.contains(page)),
            "COURSEWARE_INVALID: pages with attention cues cannot be omitted from source review"
        );
        let original = serde_json::to_string(&project)?;
        let mut next = project.clone();
        next.source = CoursewareSource {
            revision: seed.sha256.clone(),
            sha256: seed.sha256.clone(),
        };
        next.teaching_revision = uuid::Uuid::new_v4().to_string();
        next.pages = bindings
            .iter()
            .map(|id| {
                let mut page = id
                    .as_ref()
                    .and_then(|id| project.pages.iter().find(|page| &page.page_id == id))
                    .cloned()
                    .unwrap_or_else(|| CoursewarePage {
                        page_id: uuid::Uuid::new_v4().to_string(),
                        actions: vec![],
                        locked: false,
                        review_state: "review".into(),
                    });
                page.review_state = "review".into();
                page
            })
            .collect();
        let page_ids: Vec<_> = next
            .pages
            .iter()
            .map(|page| page.page_id.as_str())
            .collect();
        let identity_key = identity_key(workspace, &seed.project_id, &seed.sha256)?;
        let historical = self.kv_get(IDENTITY_NAMESPACE, &identity_key)?;
        let bound = if let Some(saved) = &historical {
            let saved = SavedSourceIdentity::parse(&serde_json::to_vec(saved)?)?;
            anyhow::ensure!(
                saved.value()["mappingRevision"].is_string()
                    && saved.same_export(identity)
                    && saved.value()["pages"]
                        .as_array()
                        .is_some_and(|pages| pages.len() == page_ids.len()
                            && pages.iter().zip(&page_ids).all(|(page, id)| page["logicalId"] == *id)),
                "COURSEWARE_CONFLICT: historical source identity differs from explicit page associations"
            );
            saved
        } else {
            identity.bind(&page_ids)?
        };
        effects::rebind(
            &project,
            &mut next,
            &previous_identity,
            &bound,
            effect_bindings,
        )?;
        next.validate()?;
        self.rebind_courseware_review_audio(workspace, &project, &next)?;
        let history_key = serde_json::to_string(&(&key, &project.teaching_revision))?;
        self.conn.execute(
            "INSERT INTO kv (ns,key,value_json,updated_at) VALUES (?1,?2,?3,?4)",
            params![HISTORY_NAMESPACE, history_key, original, now_ms()],
        )?;
        if historical.is_none() {
            self.conn.execute(
                "INSERT INTO kv (ns,key,value_json,updated_at) VALUES (?1,?2,?3,?4)",
                params![
                    IDENTITY_NAMESPACE,
                    identity_key,
                    serde_json::to_string(bound.value())?,
                    now_ms()
                ],
            )?;
        }
        let changed = self.conn.execute(
            "UPDATE kv SET value_json=?1,updated_at=?2 WHERE ns=?3 AND key=?4 AND value_json=?5",
            params![
                serde_json::to_string(&next)?,
                now_ms(),
                NAMESPACE,
                key,
                original
            ],
        )?;
        anyhow::ensure!(
            changed == 1,
            "COURSEWARE_CONFLICT: project changed during adoption"
        );
        let deleted = self.conn.execute(
            "DELETE FROM kv WHERE ns=?1 AND key=?2 AND value_json=?3",
            params![REVIEW_NAMESPACE, key, serde_json::to_string(&record)?],
        )?;
        anyhow::ensure!(
            deleted == 1,
            "COURSEWARE_CONFLICT: review changed during adoption"
        );
        self.associate_source_change(workspace, &review, &next, bindings, effect_bindings)?;
        tx.commit()?;
        Ok(next)
    }
}

#[cfg(test)]
mod recovery_tests;
#[cfg(test)]
mod tests;
