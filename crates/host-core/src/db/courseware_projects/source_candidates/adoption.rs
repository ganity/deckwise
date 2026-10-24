//! Host retains process-restart intent and commits teaching only after a fresh parse.
use super::*;
use crate::courseware::identity::SavedSourceIdentity;

const ADOPTIONS: &str = "coursewareSourceAdoptions.v1";
const LOCKS: &str = "coursewareSourceAdoptionLocks.v1";

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Pending,
    Committed,
    Cancelled,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Adoption {
    adoption_id: String,
    candidate_id: String,
    baseline: CoursewareProject,
    mapping_revision: String,
    next: CoursewareProject,
    identity: Value,
    phase: Phase,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    effect_bindings: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_path: Option<String>,
}

impl Adoption {
    fn view(&self) -> Value {
        serde_json::json!({
            "adoptionId": self.adoption_id, "candidateId": self.candidate_id,
            "projectId": self.baseline.project_id, "status": self.phase,
            "sourceSha256": self.baseline.source.sha256, "outputSha256": self.next.source.sha256,
            "sourcePath": self.source_path,
            "project": if self.phase == Phase::Committed { Some(&self.next) } else { None }
        })
    }
}

fn check_seed(seed: &SavedProjectSeed, project: &CoursewareProject, bound: &Value) -> Result<()> {
    let identity = SavedSourceIdentity::parse(&serde_json::to_vec(bound)?)?;
    anyhow::ensure!(
        seed.project_id == project.project_id
            && seed.sha256 == project.source.sha256
            && seed.pages == project.pages.len()
            && seed
                .identity
                .as_ref()
                .is_some_and(|raw| identity.same_export(raw)),
        "COURSEWARE_CONFLICT: parsed saved revision differs from adoption"
    );
    Ok(())
}

impl Database {
    pub fn source_adoption_barrier(&self) -> Result<()> {
        let (busy, frames, copied): (i64, i64, i64) =
            self.conn
                .query_row("PRAGMA main.wal_checkpoint(FULL)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?;
        anyhow::ensure!(busy == 0 && frames >= 0 && frames == copied,
            "COURSEWARE_CONFLICT: adoption durability checkpoint is incomplete; recover before replacing files");
        Ok(())
    }
    pub fn ensure_no_source_adoption(&self, workspace: &str) -> Result<()> {
        anyhow::ensure!(
            self.kv_get(LOCKS, &storage_key(workspace, "source-adoption")?)?
                .is_none(),
            "COURSEWARE_CONFLICT: source adoption pending; recover it before editing teaching"
        );
        Ok(())
    }

    fn source_adoption(&self, workspace: &str, project_id: &str) -> Result<Adoption> {
        let journal: Adoption = serde_json::from_value(
            self.kv_get(ADOPTIONS, &storage_key(workspace, project_id)?)?
                .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: source adoption not found"))?,
        )?;
        journal.baseline.validate()?;
        journal.next.validate()?;
        let identity = SavedSourceIdentity::parse(&serde_json::to_vec(&journal.identity)?)?;
        super::super::reviews::effects::projection(&journal.next, identity.value(), identity.value())?;
        anyhow::ensure!(
            journal.baseline.project_id == project_id
                && journal.next.project_id == project_id
                && valid_id(&journal.adoption_id)
                && valid_id(&journal.candidate_id)
                && identity.matches_source(&journal.next.source.sha256, journal.next.pages.len())
                && journal.identity["mappingRevision"].is_string(),
            "COURSEWARE_INVALID: invalid adoption journal"
        );
        Ok(journal)
    }

    pub fn get_source_adoption(&self, workspace: &str, project_id: &str) -> Result<Value> {
        Ok(self.source_adoption(workspace, project_id)?.view())
    }

    #[cfg(test)]
    pub fn prepare_source_adoption(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        candidate_id: &str,
    ) -> Result<Value> {
        self.prepare_source_adoption_with_path(workspace, seed, candidate_id, None, &[])
    }

    pub fn prepare_source_adoption_with_path(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        candidate_id: &str,
        source_path: Option<String>,
        effect_bindings: &[Value],
    ) -> Result<Value> {
        anyhow::ensure!(effect_bindings.len() <= 20000, "COURSEWARE_INVALID: too many effect associations");
        let tx = self.conn.unchecked_transaction()?;
        let project_key = storage_key(workspace, &seed.project_id)?;
        if let Some(lock) = self.kv_get(LOCKS, &storage_key(workspace, "source-adoption")?)? {
            anyhow::ensure!(
                lock == project_key,
                "COURSEWARE_CONFLICT: another source adoption is pending"
            );
            let journal = self.source_adoption(workspace, &seed.project_id)?;
            anyhow::ensure!(
                journal.phase == Phase::Pending
                    && journal.candidate_id == candidate_id
                    && journal.source_path == source_path
                    && journal.effect_bindings == effect_bindings,
                "COURSEWARE_CONFLICT: another source adoption is pending"
            );
            self.check_adoption_baseline(workspace, &journal)?;
            let identity_key = identities::identity_key(workspace, &seed.project_id, &seed.sha256)?;
            let bound = self
                .kv_get(identities::IDENTITY_NAMESPACE, &identity_key)?
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: original identity is missing"))?;
            check_seed(seed, &journal.baseline, &bound)?;
            self.validate_courseware_review_audio(workspace, &journal.baseline, &journal.next)?;
            tx.commit()?;
            return Ok(journal.view());
        }
        let candidate = self.source_candidate(
            &key(workspace, &seed.project_id, candidate_id)?,
            &seed.project_id,
            candidate_id,
        )?;
        anyhow::ensure!(
            candidate.status == Status::NeedsReview
                && candidate.verified()
                && self.source_candidate_current(workspace, &candidate)?,
            "COURSEWARE_CONFLICT: adoption requires a current verified source candidate"
        );
        let source_key = identities::identity_key(workspace, &seed.project_id, &seed.sha256)?;
        let original = self
            .kv_get(identities::IDENTITY_NAMESPACE, &source_key)?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: original identity is missing"))?;
        check_seed(seed, &candidate.baseline, &original)?;
        super::super::reviews::effects::projection(&candidate.baseline, &original, &original)?;
        let output = candidate
            .output
            .as_ref()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: output is missing"))?;
        let mut identity = output
            .identity
            .clone()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: output identity is missing"))?;
        let replaced_pages =
            if candidate.redo_evidence.is_some() || candidate.batch_evidence.is_some() {
                candidate.target_page_ids()
            } else {
                vec![]
            };
        verify_candidate_identity(&original, &identity, &replaced_pages)?;
        super::super::asset_locks::verify_preserved_images(&original, &identity, &replaced_pages, &candidate.asset_locks, &candidate.preserved_images)?;
        // Only explicitly locked, verified images retain their logical object IDs.
        for (page, old) in identity["pages"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .zip(original["pages"].as_array().into_iter().flatten())
        {
            page["logicalId"] = old["logicalId"].clone();
            if replaced_pages.iter().any(|id| old["logicalId"] == *id) {
                for object in page["objects"].as_array_mut().into_iter().flatten() {
                    object["logicalId"] = candidate.preserved_images.iter()
                        .find(|proof| old["logicalId"] == proof.page_id && object["sourceShapeId"] == proof.output_shape_id)
                        .map(|proof|proof.object_id.clone()).unwrap_or_else(||uuid::Uuid::new_v4().to_string()).into();
                }
            } else {
                for (object, old) in page["objects"]
                    .as_array_mut()
                    .into_iter()
                    .flatten()
                    .zip(old["objects"].as_array().into_iter().flatten())
                {
                    object["logicalId"] = old["logicalId"].clone();
                }
            }
        }
        identity["mappingRevision"] = uuid::Uuid::new_v4().to_string().into();
        SavedSourceIdentity::parse(&serde_json::to_vec(&identity)?)?;
        let mut next = candidate.baseline.clone();
        next.source = CoursewareSource {
            revision: output.sha256.clone(),
            sha256: output.sha256.clone(),
        };
        next.teaching_revision = uuid::Uuid::new_v4().to_string();
        for page in &mut next.pages {
            if candidate.target_page_ids().contains(&page.page_id.as_str()) {
                page.review_state = "review".into();
            }
        }
        super::attention::rebind(&candidate, &mut next, &original, &identity, effect_bindings)?;
        next.validate()?;
        // Verify adopted provenance before Main may replace any source bytes.
        self.validate_courseware_review_audio(workspace, &candidate.baseline, &next)?;
        let target_key = identities::identity_key(workspace, &seed.project_id, &output.sha256)?;
        anyhow::ensure!(
            self.kv_get(identities::IDENTITY_NAMESPACE, &target_key)?
                .is_none(),
            "COURSEWARE_CONFLICT: output already has a historical mapping"
        );
        let journal = Adoption {
            adoption_id: uuid::Uuid::new_v4().to_string(),
            candidate_id: candidate_id.into(),
            baseline: candidate.baseline,
            mapping_revision: candidate.mapping_revision,
            next,
            identity,
            phase: Phase::Pending,
            effect_bindings: effect_bindings.to_vec(),
            source_path,
        };
        let record = serde_json::to_value(&journal)?;
        self.kv_set(ADOPTIONS, &project_key, &record)?;
        let lock_key = storage_key(workspace, "source-adoption")?;
        self.kv_set(LOCKS, &lock_key, &Value::String(project_key.clone()))?;
        anyhow::ensure!(
            self.kv_get(ADOPTIONS, &project_key)? == Some(record)
                && self.kv_get(LOCKS, &lock_key)? == Some(Value::String(project_key)),
            "COURSEWARE_CONFLICT: adoption preparation was not persisted"
        );
        tx.commit()?;
        Ok(journal.view())
    }

    fn check_adoption_baseline(&self, workspace: &str, journal: &Adoption) -> Result<()> {
        let candidate = self.source_candidate(
            &key(
                workspace,
                &journal.baseline.project_id,
                &journal.candidate_id,
            )?,
            &journal.baseline.project_id,
            &journal.candidate_id,
        )?;
        anyhow::ensure!(
            candidate.status == Status::NeedsReview
                && candidate.verified()
                && serde_json::to_value(&candidate.baseline)?
                    == serde_json::to_value(&journal.baseline)?
                && candidate.mapping_revision == journal.mapping_revision
                && candidate
                    .output
                    .as_ref()
                    .is_some_and(|output| output.sha256 == journal.next.source.sha256)
                && self.source_candidate_current(workspace, &candidate)?,
            "COURSEWARE_CONFLICT: adoption baseline changed"
        );
        Ok(())
    }

    pub fn resolve_source_adoption(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        adoption_id: &str,
        commit: bool,
    ) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let project_key = storage_key(workspace, &seed.project_id)?;
        let mut journal = self.source_adoption(workspace, &seed.project_id)?;
        anyhow::ensure!(
            journal.adoption_id == adoption_id,
            "COURSEWARE_CONFLICT: adoption id changed"
        );
        let previous = serde_json::to_string(&serde_json::to_value(&journal)?)?;
        if commit {
            check_seed(seed, &journal.next, &journal.identity)?;
        } else {
            let key = identities::identity_key(
                workspace,
                &seed.project_id,
                &journal.baseline.source.sha256,
            )?;
            let original = self
                .kv_get(identities::IDENTITY_NAMESPACE, &key)?
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: original identity is missing"))?;
            check_seed(seed, &journal.baseline, &original)?;
        }
        let target = if commit {
            Phase::Committed
        } else {
            Phase::Cancelled
        };
        if journal.phase == target {
            tx.commit()?;
            return Ok(journal.view());
        }
        anyhow::ensure!(
            journal.phase == Phase::Pending,
            "COURSEWARE_CONFLICT: adoption already resolved"
        );
        anyhow::ensure!(
            self.kv_get(LOCKS, &storage_key(workspace, "source-adoption")?)?
                == Some(Value::String(project_key.clone())),
            "COURSEWARE_CONFLICT: adoption lock changed"
        );
        self.check_adoption_baseline(workspace, &journal)?;
        if commit {
            let candidate = self.source_candidate(&key(workspace, &seed.project_id, &journal.candidate_id)?, &seed.project_id, &journal.candidate_id)?;
            self.rebind_candidate_asset_locks(workspace, &journal.baseline, &journal.next,
                journal.identity["mappingRevision"].as_str().unwrap(), &candidate.asset_locks, &candidate.preserved_images)?;
            self.rebind_courseware_review_audio(workspace, &journal.baseline, &journal.next)?;
            let original = serde_json::to_string(&journal.baseline)?;
            let history_key =
                serde_json::to_string(&(&project_key, &journal.baseline.teaching_revision))?;
            let inserted = self.conn.execute(
                "INSERT INTO kv (ns,key,value_json,updated_at) VALUES (?1,?2,?3,?4)",
                params![HISTORY_NAMESPACE, history_key, original, now_ms()],
            )?;
            anyhow::ensure!(
                inserted == 1,
                "COURSEWARE_CONFLICT: history was not archived"
            );
            let identity_key = identities::identity_key(workspace, &seed.project_id, &seed.sha256)?;
            let inserted = self.conn.execute(
                "INSERT INTO kv (ns,key,value_json,updated_at) VALUES (?1,?2,?3,?4)",
                params![
                    identities::IDENTITY_NAMESPACE,
                    identity_key,
                    serde_json::to_string(&journal.identity)?,
                    now_ms()
                ],
            )?;
            anyhow::ensure!(
                inserted == 1,
                "COURSEWARE_CONFLICT: identity was not archived"
            );
            let changed = self.conn.execute("UPDATE kv SET value_json=?1,updated_at=?2 WHERE ns=?3 AND key=?4 AND value_json=?5", params![serde_json::to_string(&journal.next)?, now_ms(), NAMESPACE, project_key, original])?;
            anyhow::ensure!(
                changed == 1,
                "COURSEWARE_CONFLICT: project changed during source adoption"
            );
            let candidate_key = key(workspace, &seed.project_id, &journal.candidate_id)?;
            let mut candidate =
                self.source_candidate(&candidate_key, &seed.project_id, &journal.candidate_id)?;
            let previous = serde_json::to_string(&candidate)?;
            candidate.status = Status::Adopted;
            self.save_source_candidate(&candidate_key, &previous, &candidate)?;
            let kind = match candidate.request.kind {
                Kind::PagePptx => "page-pptx",
                Kind::PageFade => "page-fade",
                Kind::StyleBatch => "page-style-batch",
            };
            self.record_chat_candidate_adoption(
                workspace,
                &journal.next,
                &journal.candidate_id,
                kind,
                &candidate.target_page_ids(),
            )?;
        }
        journal.phase = target;
        let changed = self.conn.execute(
            "UPDATE kv SET value_json=?1,updated_at=?2 WHERE ns=?3 AND key=?4 AND value_json=?5",
            params![
                serde_json::to_string(&serde_json::to_value(&journal)?)?,
                now_ms(),
                ADOPTIONS,
                project_key,
                previous
            ],
        )?;
        anyhow::ensure!(
            changed == 1,
            "COURSEWARE_CONFLICT: adoption journal changed"
        );
        let deleted = self.conn.execute(
            "DELETE FROM kv WHERE ns=?1 AND key=?2 AND value_json=?3",
            params![
                LOCKS,
                storage_key(workspace, "source-adoption")?,
                serde_json::to_string(&project_key)?
            ],
        )?;
        anyhow::ensure!(deleted == 1, "COURSEWARE_CONFLICT: adoption lock changed");
        tx.commit()?;
        Ok(journal.view())
    }
}

#[cfg(test)]
mod audio_tests;
#[cfg(test)]
mod tests;
