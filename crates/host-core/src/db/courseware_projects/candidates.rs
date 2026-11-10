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
            valid_teaching_checkpoint(action)
                || music::valid_slot(action)
                || super::video::valid_slot(action)
                || (action["type"] == "speech"
                    && action["text"].as_str().is_some_and(|text| text.encode_utf16().count() <= 32000)
                    && action.get("source").is_none_or(|source| source == "generated")
                    && action.as_object().is_some_and(|object| object.keys().all(|key| ["id", "type", "text", "pauseAfterMs", "attention", "source"].contains(&key.as_str())))
                    && action.get("pauseAfterMs").is_none_or(|pause| pause.as_u64().is_some_and(|pause| pause <= 30000)))
        }),
        "COURSEWARE_INVALID: narration candidate supports speech, bounded pauses and teacher-led checkpoints only"
    );
    Ok(())
}

fn replaceable_narration(actions: &[Value]) -> Result<Vec<Value>> {
    actions
        .iter()
        .filter(|a| a["type"] != "audio_clip" && a["type"] != "video_clip" && a["type"] != "music_slot")
        .map(|action| {
            let mut clean = action.clone();
            if action["type"] == "speech" {
                if let Some(cues) = action.get("visualCues") {
                    let cues = cues
                        .as_array()
                        .filter(|c| c.len() <= 200)
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
                        matches!(
                            source.as_str(),
                            Some("notes" | "external" | "original" | "light_rewrite" | "generated")
                        ),
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

/// Required repairs use original speech anchors, preserving speech/audio while adding missing actions or focus.
fn repair_required_actions(
    original: &[Value],
    proposed: &[Value],
    teaching: &Value,
) -> Result<Vec<Value>> {
    let speeches: Vec<_> = original.iter().filter(|a| a["type"] == "speech").collect();
    let candidates: Vec<_> = proposed.iter().filter(|a| a["type"] == "speech").collect();
    anyhow::ensure!(!speeches.is_empty() && speeches.len() == candidates.len() &&
        speeches.iter().zip(&candidates).all(|(old, new)| old["text"] == new["text"]),
        "COURSEWARE_INVALID: requirement repair must preserve every existing speech exactly and in order; no teaching was replaced");
    let question_missing = !teaching["question"].is_null()
        && !original.iter().any(|a| {
            a["type"] == "interaction_checkpoint"
                && a["checkpointKind"] == "chapter_summary"
                && scene_teaching::question_matches(a, &teaching["question"])
        });
    let music_missing = !teaching["music"].is_null()
        && !original
            .iter()
            .any(|a| a["type"] == "audio_clip" || a["type"] == "music_slot");
    let video_missing = !teaching["video"].is_null()
        && !original
            .iter()
            .any(|a| a["type"] == "video_slot" || a["type"] == "video_clip");
    let mut video_added = false;
    let mut question_added = false;
    let mut music_added = false;
    let mut cursor = 0;
    let mut actions = Vec::new();
    for action in proposed {
        if action["type"] == "speech" {
            while cursor < original.len() {
                let existing = &original[cursor];
                let mut preserved = existing.clone();
                if existing["type"] == "speech" {
                    if let Some(attention) = action
                        .get("attention")
                        .filter(|_| existing.get("attention").is_none())
                    {
                        anyhow::ensure!(
                            existing["id"] == action["id"]
                                && existing["visualCues"].as_array().is_none_or(|cues|
                                    !cues.iter().any(|c| c["effect"]["type"] == attention["type"])
                                        || attention.get("animation").is_some()
                                            && !cues.iter().any(|c| c["effect"]["type"] == "element_animation")),
                            "COURSEWARE_INVALID: focus repair must preserve existing cues and speech identity"
                        );
                        attention::targets(attention)?;
                        preserved["attention"] = attention.clone();
                    }
                }
                actions.push(preserved);
                cursor += 1;
                if existing["type"] == "speech" {
                    break;
                }
            }
        } else if question_missing
            && !question_added
            && action["type"] == "interaction_checkpoint"
            && action["checkpointKind"] == "chapter_summary"
            && scene_teaching::question_matches(action, &teaching["question"])
        {
            narration(std::slice::from_ref(action))?;
            actions.push(action.clone());
            question_added = true;
        } else if music_missing && !music_added && action["type"] == "music_slot" {
            narration(std::slice::from_ref(action))?;
            actions.push(action.clone());
            music_added = true;
        } else if video_missing && !video_added && action["type"] == "video_slot" {
            narration(std::slice::from_ref(action))?;
            actions.push(action.clone());
            video_added = true;
        }
    }
    actions.extend_from_slice(&original[cursor..]);
    anyhow::ensure!((!question_missing || question_added) && (!music_missing || music_added) && (!video_missing || video_added),
        "COURSEWARE_INCOMPLETE: proposed repair omitted a required question, music or video slot; existing teaching was preserved");
    Ok(actions)
}

impl Database {
    fn normalize_narration_music(
        &self,
        workspace: &str,
        project: &CoursewareProject,
        write: &mut TeachingWrite,
    ) -> Result<Vec<Value>> {
        let page = project
            .pages
            .iter()
            .find(|p| p.page_id == write.page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_PAGE_NOT_FOUND: logical page not found"))?;
        let mut actions = page.actions.clone();
        if let Some(scene) = self.courseware_teaching_requirements(workspace, project)? {
            let teaching = scene["pages"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|p| p["pageId"] == page.page_id)
                .map(|p| &p["teaching"]);
            if let Some(question) = teaching.map(|t| &t["question"]).filter(|q| !q.is_null()) {
                let questions: Vec<_> = write
                    .actions
                    .iter()
                    .filter(|a| {
                        a["type"] == "interaction_checkpoint"
                            && a["checkpointKind"] == "chapter_summary"
                    })
                    .collect();
                anyhow::ensure!(questions.is_empty() || questions.iter().any(|a| scene_teaching::question_matches(a, question)),
                    "COURSEWARE_INVALID: include the exact approved question text, ordered options and answer indices");
            }
            if teaching.is_some_and(|t| t["music"].is_null()) {
                anyhow::ensure!(
                    write
                        .actions
                        .iter()
                        .filter(|a| a["type"] == "music_slot")
                        .all(|a| page.actions.iter().any(|old| old["id"] == a["id"]
                            && matches!(old["type"].as_str(), Some("music_slot" | "audio_clip")))),
                    "COURSEWARE_INVALID: music is not approved on this logical page"
                );
                let mut retained = Vec::new();
                for action in actions {
                    if action["type"] != "music_slot"
                        || self.music_slot_has_submission(
                            workspace,
                            action["id"].as_str().unwrap_or_default(),
                        )?
                    {
                        retained.push(action);
                    }
                }
                actions = retained;
            }
        }
        write.actions.retain(|a| {
            a["type"] != "music_slot"
                || !page.actions.iter().any(|old| old["id"] == a["id"])
                || actions.iter().any(|old| old["id"] == a["id"])
        });
        Ok(actions)
    }

    /// Generated narration replaces teaching directly; legacy candidates remain readable.
    pub fn save_generated_narration(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        baseline: &CoursewareProject,
        write: &TeachingWrite,
    ) -> Result<CoursewareProject> {
        self.save_generated_narration_with_semantics(workspace, seed, baseline, write, &[])
    }

    pub fn save_generated_narration_with_semantics(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        baseline: &CoursewareProject,
        write: &TeachingWrite,
        semantics: &[scene_objects::SceneSemanticEvidence],
    ) -> Result<CoursewareProject> {
        self.save_narration(workspace, seed, baseline, write, semantics, false)
    }

    pub fn repair_required_teaching(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        baseline: &CoursewareProject,
        write: &TeachingWrite,
    ) -> Result<CoursewareProject> {
        self.save_narration(workspace, seed, baseline, write, &[], true)
    }

    fn save_narration(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        baseline: &CoursewareProject,
        write: &TeachingWrite,
        semantics: &[scene_objects::SceneSemanticEvidence],
        preserve_speech: bool,
    ) -> Result<CoursewareProject> {
        baseline.validate()?;
        matches_seed(baseline, seed)?;
        anyhow::ensure!(
            write.project_id == baseline.project_id
                && write.expected_source_revision == baseline.source.revision
                && write.expected_teaching_revision == baseline.teaching_revision,
            "COURSEWARE_CONFLICT: narration write differs from its baseline"
        );
        if preserve_speech {
            validate_actions(&write.actions)?;
        } else {
            narration(&write.actions)?;
        }
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
        anyhow::ensure!(
            !self.courseware_assessment_page_ids(workspace, &current)?.contains(&write.page_id),
            "COURSEWARE_INVALID: independent Quiz/checkpoint pages use the question editor, not generated lecture"
        );
        anyhow::ensure!(
            current.task_type != "scene" || !write.actions.iter().any(|a| a["type"] == "interaction_checkpoint")
                || self.courseware_classroom(workspace, &current.project_id, None)?["classroom"].is_null(),
            "COURSEWARE_INVALID: questions require separate assessment pages, not body lecture actions"
        );
        narration(&replaceable_narration(&page.actions)?)?;
        self.validate_narration_attention(workspace, &current, &write.page_id, &write.actions)?;
        let mut write = write.clone();
        let retained = self.normalize_narration_music(workspace, &current, &mut write)?;
        if preserve_speech {
            let scene = self.courseware_teaching_requirements(workspace, &current)?
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: required teaching repair needs retained scene requirements"))?;
            let teaching = scene["pages"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|p| p["pageId"] == page.page_id)
                .map(|p| &p["teaching"])
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: page requirements missing"))?;
            write.actions = repair_required_actions(&retained, &write.actions, teaching)?;
            if write.actions.iter().any(|a| a.get("attention").is_some() && a.get("audioAssetId").is_some()) {
                let audio = self.portable_audio(workspace, &current)?;
                let local = self.portable_courseware_media_entries(workspace, &current)?;
                for action in &mut write.actions {
                    let Some(intent) = action.get("attention").cloned().filter(|_| action.get("audioAssetId").is_some()) else {
                        continue;
                    };
                    let duration = audio.iter()
                        .find(|a| action["audioAssetId"] == a.asset().id)
                        .map(|a| a.duration_ms)
                        .or_else(|| {
                            local.get(&(page.page_id.clone(), action["id"].as_str().unwrap_or_default().to_owned()))
                                .filter(|a| action["audioAssetId"] == a.id)
                                .map(|a| a.duration_ms)
                        })
                        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: focus repair needs verified saved speech audio"))?;
                    let mut cues = action["visualCues"].as_array().cloned().unwrap_or_default();
                    let anchor = if cues.is_empty() {
                        action["id"].as_str().unwrap_or_default().to_owned()
                    } else {
                        format!("{}-repair-{}", action["id"].as_str().unwrap_or_default(), cues.len())
                    };
                    cues.extend(attention::cues(&intent, &anchor, duration)?);
                    action["visualCues"] = serde_json::json!(cues);
                    action.as_object_mut().unwrap().remove("attention");
                }
            }
        } else {
            for (index, clip) in retained.iter().enumerate().filter(|(_, action)| {
                action["type"] == "audio_clip"
                    || action["type"] == "music_slot"
                    || action["type"] == "video_slot"
                    || action["type"] == "video_clip"
            }) {
                anyhow::ensure!(
                    music::valid_clip(clip)
                        || music::valid_slot(clip)
                        || super::video::valid_slot(clip)
                        || super::video::valid_clip(clip),
                    "COURSEWARE_INVALID: invalid retained media action"
                );
                if let Some(position) = write
                    .actions
                    .iter()
                    .position(|a| a["type"] == "music_slot" && a["id"] == clip["id"])
                {
                    write.actions[position] = clip.clone();
                } else {
                    write
                        .actions
                        .insert(index.min(write.actions.len()), clip.clone());
                }
            }
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
        self.save_scene_semantic_evidence(workspace, &project, &write.page_id, semantics)?;
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
        let retained = self.normalize_narration_music(workspace, &current, &mut write)?;
        for (index, clip) in retained.iter().enumerate().filter(|(_, action)| {
            action["type"] == "audio_clip"
                || action["type"] == "music_slot"
                || action["type"] == "video_slot"
                || action["type"] == "video_clip"
        }) {
            if let Some(position) = write.actions.iter().position(|a| a["type"] == "music_slot" && a["id"] == clip["id"]) {
                write.actions[position] = clip.clone();
            } else {
                write.actions.insert(index.min(write.actions.len()), clip.clone());
            }
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
