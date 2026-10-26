//! Direct narration saves and compatibility for previously staged candidates.
use super::*;
use crate::courseware::SavedProjectSeed;

const CANDIDATES: &str = "coursewareNarrationCandidates.v1";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Status {
    NeedsReview,
    Adopted,
    Rejected,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Candidate {
    candidate_id: String,
    baseline: CoursewareProject,
    write: TeachingWrite,
    status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    page_scoped: Option<bool>,
}

impl Candidate {
    fn matches_current(&self, current: &CoursewareProject) -> Result<bool> {
        let mut comparable = current.clone();
        if self.page_scoped == Some(true) {
            comparable.teaching_revision = self.baseline.teaching_revision.clone();
            for (page, old) in comparable.pages.iter_mut().zip(&self.baseline.pages) {
                if page.page_id == old.page_id && page.page_id != self.write.page_id {
                    page.actions = old.actions.clone();
                    page.review_state = old.review_state.clone();
                }
            }
        }
        Ok(serde_json::to_value(comparable)? == serde_json::to_value(&self.baseline)?)
    }
    fn view(&self) -> Value {
        serde_json::json!({"candidateId": self.candidate_id, "kind": "page-narration",
            "status": self.status, "write": self.write, "audioReady": false})
    }
}

fn candidate_key(workspace: &str, project_id: &str, candidate_id: &str) -> Result<String> {
    anyhow::ensure!(
        valid_id(candidate_id),
        "COURSEWARE_INVALID: invalid candidate id"
    );
    Ok(serde_json::to_string(&(
        storage_key(workspace, project_id)?,
        candidate_id,
    ))?)
}

fn narration(actions: &[Value]) -> Result<()> {
    validate_actions(actions)?;
    // shortcut: reject existing audio/effects intact; add action-specific invalidation before replacing them.
    anyhow::ensure!(
        actions.iter().all(|action| {
            (action["type"] == "interaction_checkpoint" && action["checkpointKind"] == "teacher_continue"
                && action.as_object().is_some_and(|object| object.keys().all(|key| ["id", "type", "checkpointId", "checkpointKind"].contains(&key.as_str())))
                && valid_id(action["checkpointId"].as_str().unwrap_or_default()))
                || (action["type"] == "speech"
                    && action["text"].as_str().is_some_and(|text| text.encode_utf16().count() <= 32000)
                    && action.as_object().is_some_and(|object| object.keys().all(|key| ["id", "type", "text", "pauseAfterMs", "attention"].contains(&key.as_str())))
                    && action.get("pauseAfterMs").is_none_or(|pause| pause.as_u64().is_some_and(|pause| pause <= 30000)))
        }),
        "COURSEWARE_INVALID: narration candidate supports speech, bounded pauses and teacher-continue checkpoints only"
    );
    Ok(())
}

fn replaceable_narration(actions: &[Value]) -> Result<Vec<Value>> {
    actions
        .iter()
        .filter(|a| a["type"] != "audio_clip")
        .map(|action| {
            let mut clean = action.clone();
            if action["type"] == "speech" {
                if let Some(cues) = action.get("visualCues") {
                    let cues = cues
                        .as_array()
                        .filter(|c| !c.is_empty() && c.len() <= 200)
                        .ok_or_else(|| {
                            anyhow!("COURSEWARE_INVALID: unsupported previous effects")
                        })?;
                    for cue in cues {
                        reviews::effects::cue_targets(cue)?;
                    }
                    clean.as_object_mut().unwrap().remove("visualCues");
                }
                if let Some(audio) = action.get("audioAssetId") {
                    anyhow::ensure!(
                        audio
                            .as_str()
                            .and_then(|s| s.strip_prefix("tts-"))
                            .is_some_and(
                                |s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit())
                            ),
                        "COURSEWARE_INVALID: unsupported previous audio"
                    );
                    clean.as_object_mut().unwrap().remove("audioAssetId");
                }
                if let Some(source) = action.get("source") {
                    anyhow::ensure!(
                        matches!(source.as_str(), Some("notes" | "external")),
                        "COURSEWARE_INVALID: unsupported narration source"
                    );
                    clean.as_object_mut().unwrap().remove("source");
                }
            }
            Ok(clean)
        })
        .collect()
}

fn matches_seed(project: &CoursewareProject, seed: &SavedProjectSeed) -> Result<()> {
    anyhow::ensure!(
        project.project_id == seed.project_id
            && project.source.sha256 == seed.sha256
            && project.pages.len() == seed.pages,
        "COURSEWARE_CONFLICT: saved source no longer matches the candidate baseline"
    );
    Ok(())
}

impl Database {
    /// Generated narration replaces teaching directly; legacy candidates remain readable.
    pub fn save_generated_narration(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        baseline: &CoursewareProject,
        write: &TeachingWrite,
    ) -> Result<CoursewareProject> {
        baseline.validate()?;
        matches_seed(baseline, seed)?;
        anyhow::ensure!(
            write.project_id == baseline.project_id
                && write.expected_source_revision == baseline.source.revision
                && write.expected_teaching_revision == baseline.teaching_revision,
            "COURSEWARE_CONFLICT: narration write differs from its baseline"
        );
        narration(&write.actions)?;
        let tx = self.conn.unchecked_transaction()?;
        let current = self
            .get_courseware_project(workspace, &seed.project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        anyhow::ensure!(
            serde_json::to_value(&current)? == serde_json::to_value(baseline)?,
            "COURSEWARE_CONFLICT: source, teaching, locks or education policy changed"
        );
        let page = current
            .pages
            .iter()
            .find(|page| page.page_id == write.page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_PAGE_NOT_FOUND: logical page not found"))?;
        narration(&replaceable_narration(&page.actions)?)?;
        self.validate_narration_attention(workspace, &current, &write.page_id, &write.actions)?;
        let mut write = write.clone();
        for (index, clip) in page
            .actions
            .iter()
            .enumerate()
            .filter(|(_, action)| action["type"] == "audio_clip")
        {
            anyhow::ensure!(
                music::valid_clip(clip),
                "COURSEWARE_INVALID: invalid retained music clip"
            );
            write
                .actions
                .insert(index.min(write.actions.len()), clip.clone());
        }
        let history_key = serde_json::to_string(&(
            storage_key(workspace, &seed.project_id)?,
            &current.teaching_revision,
        ))?;
        let inserted = self.conn.execute(
            "INSERT INTO kv (ns,key,value_json,updated_at) VALUES (?1,?2,?3,?4)",
            params![
                HISTORY_NAMESPACE,
                history_key,
                serde_json::to_string(&current)?,
                now_ms()
            ],
        )?;
        anyhow::ensure!(
            inserted == 1,
            "COURSEWARE_CONFLICT: previous teaching was not archived"
        );
        let project = self.write_courseware_teaching(workspace, &write)?;
        tx.commit()?;
        Ok(project)
    }

    fn narration_candidate(&self, key: &str) -> Result<Candidate> {
        let value = self
            .kv_get(CANDIDATES, key)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: candidate not found"))?;
        let candidate: Candidate = serde_json::from_value(value)?;
        candidate.baseline.validate()?;
        anyhow::ensure!(
            valid_id(&candidate.candidate_id)
                && candidate.write.project_id == candidate.baseline.project_id
                && candidate.write.expected_source_revision == candidate.baseline.source.revision
                && candidate.write.expected_teaching_revision
                    == candidate.baseline.teaching_revision
                && candidate
                    .baseline
                    .pages
                    .iter()
                    .any(|page| page.page_id == candidate.write.page_id),
            "COURSEWARE_INVALID: invalid stored candidate baseline"
        );
        narration(&candidate.write.actions)?;
        anyhow::ensure!(
            serde_json::to_vec(&candidate)?.len() <= MAX_BYTES,
            "COURSEWARE_INVALID: candidate exceeds storage limit"
        );
        Ok(candidate)
    }

    fn save_narration_candidate(
        &self,
        key: &str,
        previous: &str,
        candidate: &Candidate,
    ) -> Result<()> {
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
        anyhow::ensure!(changed == 1, "COURSEWARE_CONFLICT: candidate changed");
        Ok(())
    }

    pub fn stage_narration_candidate(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        candidate_id: &str,
        write: &TeachingWrite,
    ) -> Result<Value> {
        self.stage_scoped_narration_candidate(workspace, seed, candidate_id, write, false)
    }

    pub fn stage_scoped_narration_candidate(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        candidate_id: &str,
        write: &TeachingWrite,
        page_scoped: bool,
    ) -> Result<Value> {
        let key = candidate_key(workspace, &seed.project_id, candidate_id)?;
        narration(&write.actions)?;
        let tx = self.conn.unchecked_transaction()?;
        let baseline = self
            .get_courseware_project(workspace, &seed.project_id)?
            .ok_or_else(|| {
                anyhow!("COURSEWARE_NOT_FOUND: initialize teaching before staging candidates")
            })?;
        matches_seed(&baseline, seed)?;
        anyhow::ensure!(
            write.project_id == baseline.project_id
                && write.expected_source_revision == baseline.source.revision
                && write.expected_teaching_revision == baseline.teaching_revision,
            "COURSEWARE_CONFLICT: candidate teaching baseline changed"
        );
        let page = baseline
            .pages
            .iter()
            .find(|page| page.page_id == write.page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_PAGE_NOT_FOUND: logical page not found"))?;
        self.validate_narration_attention(workspace, &baseline, &write.page_id, &write.actions)?;
        anyhow::ensure!(
            !page.locked,
            "COURSEWARE_LOCKED: candidate target is locked"
        );
        narration(&replaceable_narration(&page.actions)?)?;
        anyhow::ensure!(
            page.actions
                .iter()
                .filter(|action| action["type"] == "audio_clip")
                .all(music::valid_clip),
            "COURSEWARE_INVALID: invalid retained music clip"
        );
        let candidate = Candidate {
            candidate_id: candidate_id.into(),
            baseline,
            write: write.clone(),
            status: Status::NeedsReview,
            page_scoped: page_scoped.then_some(true),
        };
        let serialized = serde_json::to_string(&candidate)?;
        anyhow::ensure!(
            serialized.len() <= MAX_BYTES,
            "COURSEWARE_INVALID: candidate exceeds storage limit"
        );
        if self.kv_get(CANDIDATES, &key)?.is_some() {
            let previous = self.narration_candidate(&key)?;
            anyhow::ensure!(
                serde_json::to_value(&previous.baseline)?
                    == serde_json::to_value(&candidate.baseline)?
                    && previous.page_scoped == candidate.page_scoped
                    && serde_json::to_value(&previous.write)? == serde_json::to_value(write)?,
                "COURSEWARE_CONFLICT: candidate id already has different input"
            );
            tx.commit()?;
            return Ok(previous.view());
        }
        self.conn.execute(
            "INSERT INTO kv (ns,key,value_json,updated_at) VALUES (?1,?2,?3,?4)",
            params![CANDIDATES, key, serialized, now_ms()],
        )?;
        tx.commit()?;
        Ok(candidate.view())
    }

    pub fn get_narration_candidate(
        &self,
        workspace: &str,
        project_id: &str,
        candidate_id: &str,
    ) -> Result<Value> {
        let key = candidate_key(workspace, project_id, candidate_id)?;
        let candidate = self.narration_candidate(&key)?;
        anyhow::ensure!(
            candidate.candidate_id == candidate_id && candidate.baseline.project_id == project_id,
            "COURSEWARE_INVALID: candidate identity differs"
        );
        let mut view = candidate.view();
        if candidate.page_scoped == Some(true) {
            let current = self.get_courseware_project(workspace, project_id)?;
            view["stale"] = serde_json::json!(match current {
                Some(project) => !candidate.matches_current(&project)?,
                None => true,
            });
        }
        Ok(view)
    }

    pub fn reject_narration_candidate(
        &self,
        workspace: &str,
        project_id: &str,
        candidate_id: &str,
    ) -> Result<Value> {
        let key = candidate_key(workspace, project_id, candidate_id)?;
        let mut candidate = self.narration_candidate(&key)?;
        anyhow::ensure!(
            candidate.candidate_id == candidate_id && candidate.baseline.project_id == project_id,
            "COURSEWARE_INVALID: candidate identity differs"
        );
        anyhow::ensure!(
            candidate.status != Status::Adopted,
            "COURSEWARE_CONFLICT: candidate already adopted"
        );
        if candidate.status == Status::NeedsReview {
            let original = serde_json::to_string(&candidate)?;
            candidate.status = Status::Rejected;
            self.save_narration_candidate(&key, &original, &candidate)?;
        }
        Ok(candidate.view())
    }

    pub fn adopt_narration_candidate(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        candidate_id: &str,
    ) -> Result<CoursewareProject> {
        let key = candidate_key(workspace, &seed.project_id, candidate_id)?;
        let tx = self.conn.unchecked_transaction()?;
        let mut candidate = self.narration_candidate(&key)?;
        anyhow::ensure!(
            candidate.candidate_id == candidate_id && candidate.status == Status::NeedsReview,
            "COURSEWARE_CONFLICT: candidate is not pending review"
        );
        matches_seed(&candidate.baseline, seed)?;
        let current = self
            .get_courseware_project(workspace, &seed.project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        anyhow::ensure!(
            candidate.matches_current(&current)?,
            "COURSEWARE_CONFLICT: source, teaching, locks or education policy changed"
        );
        let original = serde_json::to_string(&candidate)?;
        let history_key = serde_json::to_string(&(
            storage_key(workspace, &seed.project_id)?,
            &current.teaching_revision,
        ))?;
        self.conn.execute(
            "INSERT INTO kv (ns,key,value_json,updated_at) VALUES (?1,?2,?3,?4)",
            params![
                HISTORY_NAMESPACE,
                history_key,
                serde_json::to_string(&current)?,
                now_ms()
            ],
        )?;
        let mut write = candidate.write.clone();
        write.expected_teaching_revision = current.teaching_revision.clone();
        let page = current
            .pages
            .iter()
            .find(|page| page.page_id == write.page_id)
            .unwrap();
        for (index, clip) in page
            .actions
            .iter()
            .enumerate()
            .filter(|(_, action)| action["type"] == "audio_clip")
        {
            write
                .actions
                .insert(index.min(write.actions.len()), clip.clone());
        }
        let project = self.write_courseware_teaching(workspace, &write)?;
        candidate.status = Status::Adopted;
        self.save_narration_candidate(&key, &original, &candidate)?;
        self.record_chat_candidate_adoption(
            workspace,
            &project,
            candidate_id,
            "page-narration",
            &[candidate.write.page_id.as_str()],
        )?;
        tx.commit()?;
        Ok(project)
    }
}

#[cfg(test)]
mod tests;
