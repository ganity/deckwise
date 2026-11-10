//! Native save receipts bind runtime identities to a verified export before replacing live bytes.
use super::*;
use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};
use std::collections::{HashMap, HashSet};
use serde_json::json;

fn tokens_valid(token: &str) -> bool {
    valid_id(token)
}

const JOURNALS: &str = "coursewareNativeSaves.v1";
const WARNINGS: &str = "coursewareNativeSaveWarnings.v1";
const DRAFTS: &str = "coursewareTeachingDrafts.v1";
const PENDING: &str = "coursewareNativeSavePending.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectLineage {
    pub name: String,
    pub source_name: Option<String>,
    pub source_page_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_shape_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeLineage {
    pub protocol: String,
    pub project_id: String,
    pub document_id: String,
    pub session_id: String,
    pub save_request_id: String,
    pub source_sha256: String,
    pub output_sha256: String,
    pub opened_page_tokens: Vec<String>,
    pub page_tokens: Vec<String>,
    pub objects: Vec<Vec<ObjectLineage>>,
    pub animation_unchanged: Vec<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClassroomSave {
    pub expected_revision: String,
    pub classroom: Value,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    save_id: String,
    source_path: String,
    baseline: CoursewareProject,
    next: CoursewareProject,
    identity: Value,
    warnings: Vec<String>,
    animation_pages: Vec<String>,
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    classroom: Option<Value>,
}
impl Journal {
    fn receipt(&self) -> Value {
        serde_json::json!({"saveId": self.save_id, "projectId":self.next.project_id,
          "sourcePath":self.source_path,"sourceSha256":self.baseline.source.sha256,
          "outputSha256":self.next.source.sha256,"status":self.status,"warnings":self.warnings})
    }
}

impl Database {
    pub(super) fn has_native_save_receipt(&self, workspace: &str, project: &CoursewareProject) -> Result<bool> {
        Ok(self.kv_get(WARNINGS, &storage_key(workspace, &project.project_id)?)?
            .is_some_and(|value| value["sourceSha256"] == project.source.sha256))
    }

    pub(super) fn ensure_no_native_save(&self, workspace: &str) -> Result<()> {
        anyhow::ensure!(
            self.kv_get(PENDING, &storage_key(workspace, "native-save")?)?
                .is_none(),
            "COURSEWARE_CONFLICT: PPT save is pending; finish recovery before editing teaching"
        );
        Ok(())
    }
    pub fn native_save_warnings(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<Value> {
        Ok(self
            .kv_get(WARNINGS, &storage_key(workspace, &project.project_id)?)?
            .filter(|value| value["sourceSha256"] == project.source.sha256)
            .map(|value| value["warnings"].clone())
            .unwrap_or_else(|| serde_json::json!([])))
    }
    pub fn native_save_receipt(&self, workspace: &str, id: &str) -> Result<Value> {
        let journal: Journal = serde_json::from_value(
            self.kv_get(JOURNALS, &storage_key(workspace, id)?)?
                .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: native save missing"))?,
        )?;
        Ok(journal.receipt())
    }
    pub fn native_save_for_path(&self, workspace: &str, path: &str) -> Result<Option<Value>> {
        let Some(id) = self.kv_get(PENDING, &storage_key(workspace, "native-save")?)? else {
            return Ok(None);
        };
        let journal: Journal = serde_json::from_value(
            self.kv_get(
                JOURNALS,
                id.as_str()
                    .ok_or_else(|| anyhow!("COURSEWARE_INVALID: invalid save lock"))?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing save journal"))?,
        )?;
        Ok((journal.source_path == path).then(|| journal.receipt()))
    }
    pub fn prepare_native_save(
        &self,
        workspace: &str,
        path: &str,
        seed: &SavedProjectSeed,
        proof: &NativeLineage,
    ) -> Result<Value> {
        self.prepare_native_save_with_classroom(workspace, path, seed, proof, None)
    }
    pub fn prepare_native_save_with_classroom(
        &self, workspace: &str, path: &str, seed: &SavedProjectSeed, proof: &NativeLineage,
        classroom: Option<&ClassroomSave>,
    ) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        let baseline = self
            .get_courseware_project(workspace, &seed.project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: native save project missing"))?;
        let old: Value = self
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(workspace, &seed.project_id, &baseline.source.sha256)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: saved identity missing"))?;
        let parsed = seed
            .identity
            .as_ref()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: export identity missing"))?;
        let mut identity = parsed.value().clone();
        let unique = |values: &[String]| {
            values.iter().all(|id| valid_id(id))
                && values.iter().collect::<HashSet<_>>().len() == values.len()
        };
        let native_identity = proof.protocol == "deckwise-office-page-lineage/2";
        let shape_id_valid = |id: &str| !id.is_empty() && id.len() <= 10 && id.bytes().all(|b| b.is_ascii_digit());
        anyhow::ensure!(
            (proof.protocol == "deckwise-office-page-lineage/1" || native_identity)
                && valid_id(&proof.save_request_id)
                && valid_id(&proof.document_id)
                && valid_id(&proof.session_id)
                && proof.project_id.len() == 64
                && proof.source_sha256 == baseline.source.sha256
                && proof.output_sha256 == seed.sha256
                && proof.opened_page_tokens.len() == baseline.pages.len()
                && proof.page_tokens.len() == seed.pages
                && unique(&proof.opened_page_tokens)
                && unique(&proof.page_tokens)
                && proof.objects.len() == seed.pages
                && proof.animation_unchanged.len() == seed.pages
                && proof.objects.iter().map(Vec::len).sum::<usize>() <= 10000
                && proof
                    .objects
                    .iter()
                    .flatten()
                    .all(|item| item.name.len() <= 200
                        && (if native_identity {
                            item.shape_id.as_deref().is_some_and(&shape_id_valid)
                                && item.source_shape_id.as_deref().is_none_or(&shape_id_valid)
                                && (item.source_shape_id.is_none() || item.source_page_token.is_some())
                        } else { item.shape_id.is_none() && item.source_shape_id.is_none() })
                        && item
                            .source_name
                            .as_ref()
                            .is_none_or(|name| !name.is_empty() && name.len() <= 200)
                        && item
                            .source_page_token
                            .as_ref()
                            .is_none_or(|token| tokens_valid(token))),
            "COURSEWARE_INVALID: native save lineage differs from saved source"
        );
        if native_identity {
            for objects in &proof.objects {
                let ids: HashSet<_> = objects.iter().map(|item| item.shape_id.as_deref()).collect();
                anyhow::ensure!(ids.len() == objects.len(), "COURSEWARE_INVALID: duplicate native output identity");
            }
        }
        let old_pages = old["pages"]
            .as_array()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: saved pages missing"))?;
        let tokens: HashMap<_, _> = proof
            .opened_page_tokens
            .iter()
            .enumerate()
            .map(|(i, token)| (token, i))
            .collect();
        let mut next = baseline.clone();
        next.source = CoursewareSource {
            revision: seed.sha256.clone(),
            sha256: seed.sha256.clone(),
        };
        next.teaching_revision = uuid::Uuid::new_v4().to_string();
        next.pages.clear();
        let mut warnings = Vec::new();
        let mut preserved = HashSet::new();
        for (index, target) in identity["pages"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            let old_index = tokens.get(&proof.page_tokens[index]).copied();
            let mut page = old_index
                .map(|i| baseline.pages[i].clone())
                .unwrap_or_else(|| CoursewarePage {
                    page_id: uuid::Uuid::new_v4().to_string(),
                    actions: vec![],
                    locked: false,
                    review_state: "review".into(),
                });
            target["logicalId"] = page.page_id.clone().into();
            let mut page_objects = HashSet::new();
            for object in target["objects"].as_array_mut().unwrap() {
                let name = object["sourceObjectName"].as_str().unwrap_or("");
                let matches: Vec<_> = proof.objects[index]
                    .iter()
                    .filter(|item| if native_identity {
                        item.shape_id.as_deref().is_some_and(|id| object["sourceShapeId"] == id)
                    } else { !name.is_empty() && item.name == name })
                    .collect();
                let candidate = if matches.len() == 1 {
                    let item = matches[0];
                    item.source_page_token
                        .as_ref()
                        .and_then(|token| tokens.get(token))
                        .and_then(|i| old_pages[*i]["objects"].as_array())
                        .and_then(|objects| {
                            let found: Vec<_> = objects
                                .iter()
                                .filter(|old| {
                                    (if native_identity {
                                        item.source_shape_id.as_deref().is_some_and(|id| old["sourceShapeId"] == id)
                                    } else {
                                        item.source_name.as_deref().is_some_and(|name| old["sourceObjectName"] == name)
                                    }) && old["type"] == object["type"]
                                })
                                .collect();
                            (found.len() == 1).then(|| found[0])
                        })
                } else {
                    None
                };
                let id = candidate
                    .and_then(|old| old["logicalId"].as_str())
                    .filter(|id| preserved.insert((*id).to_owned()))
                    .map(str::to_owned)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                object["logicalId"] = id.clone().into();
                page_objects.insert(id);
            }
            let mut affected = false;
            page.actions.retain_mut(|action| {
                if action["type"] == "native_animation" {
                    if !proof.animation_unchanged[index] {
                        affected = true;
                        return false;
                    }
                    action["sourceSha256"] = seed.sha256.clone().into();
                }
                if let Some(cues) = action.get_mut("visualCues").and_then(Value::as_array_mut) {
                    cues.retain(|cue| {
                        let keep = reviews::effects::cue_targets(cue).is_ok_and(|targets| {
                            targets.iter().all(|id| page_objects.contains(id))
                        });
                        affected |= !keep;
                        keep
                    });
                }
                if let Some(intent) = action.get("attention") {
                    if !attention::targets(intent)
                        .is_ok_and(|ids| ids.iter().all(|id| page_objects.contains(id)))
                    {
                        affected = true;
                        action.as_object_mut().unwrap().remove("attention");
                    }
                }
                true
            });
            if affected {
                page.review_state = "review".into();
                warnings.push(format!(
                    "第 {} 页已删除或更换的对象/动画对应提示已停用，旧版教学保留在历史中",
                    index + 1
                ));
            }
            next.pages.push(page);
        }
        // Native deletion is intentional; retained history holds the removed page and its teaching.
        if next.pages.len() < baseline.pages.len()
            || baseline
                .pages
                .iter()
                .any(|old| !next.pages.iter().any(|p| p.page_id == old.page_id))
        {
            warnings.push("已删除页面的教学内容保留在历史中".into());
        }
        identity["mappingRevision"] = uuid::Uuid::new_v4().to_string().into();
        SavedSourceIdentity::parse(&serde_json::to_vec(&identity)?)?;
        if let Some(save) = classroom {
            let previous = self.courseware_classroom(workspace, &baseline.project_id, None)?;
            let scenes = save.classroom["scenes"].as_array().ok_or_else(|| anyhow!("COURSEWARE_INVALID: scenes missing"))?;
            anyhow::ensure!(scenes.len() == next.pages.len(), "COURSEWARE_INVALID: scene/page count differs");
            for (page, scene) in next.pages.iter_mut().zip(scenes) {
                let old_scene = previous["classroom"]["scenes"].as_array().into_iter().flatten()
                    .find(|old| old["metadata"]["nativePageId"] == page.page_id);
                let speech_text = |scene: &Value| scene["actions"].as_array().into_iter().flatten()
                    .filter(|a| a["type"] == "speech" && !scene["metadata"]["assessmentSpeechIds"].as_object()
                        .is_some_and(|ids| ids.values().any(|id| *id == a["id"])))
                    .map(|a| a["text"].clone()).collect::<Vec<_>>();
                // An unrelated canonical edit must not roll back newer native narration/audio.
                if old_scene.is_some_and(|old| speech_text(old) == speech_text(scene)) { continue; }
                // Keep native-only media/actions. Speech edits share the canonical text baseline.
                let assessment_ids = scene["metadata"]["assessmentSpeechIds"].as_object();
                let existing: Vec<_> = page.actions.iter().filter(|action| action["type"] == "speech").cloned().collect();
                let speeches: Vec<Value> = scene["actions"].as_array().into_iter().flatten()
                    .filter(|action| action["type"] == "speech" && !assessment_ids.is_some_and(|ids| ids.values().any(|id| *id == action["id"])))
                    .enumerate()
                    .map(|(index, action)| existing.iter().find(|old| old["id"] == action["id"] && old["text"] == action["text"])
                        .or_else(|| existing.get(index).filter(|old| old["text"] == action["text"]))
                        .cloned().unwrap_or_else(|| json!({"id":action["id"],"type":"speech","text":action["text"]}))).collect();
                if existing != speeches {
                    let position = page.actions.iter().position(|action| action["type"] == "speech").unwrap_or(0);
                    page.actions.retain(|action| action["type"] != "speech");
                    let position = position.min(page.actions.len());
                    page.actions.splice(position..position, speeches);
                }
            }
        }
        next.validate()?;
        self.validate_courseware_review_audio(workspace, &baseline, &next)?;
        let animation_pages = next
            .pages
            .iter()
            .enumerate()
            .filter(|(i, _)| proof.animation_unchanged[*i])
            .map(|(_, page)| page.page_id.clone())
            .collect();
        let classroom = classroom.map(|save| self.prepare_native_classroom(workspace, &baseline, &next,
            &save.expected_revision, &save.classroom)).transpose()?;
        let journal = Journal {
            save_id: uuid::Uuid::new_v4().to_string(),
            source_path: path.into(),
            baseline,
            next,
            identity,
            warnings,
            animation_pages,
            status: "pending".into(),
            classroom,
        };
        let key = storage_key(workspace, &journal.save_id)?;
        self.kv_set(JOURNALS, &key, &serde_json::to_value(&journal)?)?;
        self.kv_set(
            PENDING,
            &storage_key(workspace, "native-save")?,
            &Value::String(key),
        )?;
        tx.commit()?;
        self.source_adoption_barrier()?;
        Ok(journal.receipt())
    }
    pub fn resolve_native_save(
        &self,
        workspace: &str,
        save_id: &str,
        live_sha: &str,
    ) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let key = storage_key(workspace, save_id)?;
        let mut journal: Journal = serde_json::from_value(
            self.kv_get(JOURNALS, &key)?
                .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: native save journal missing"))?,
        )?;
        let commit = live_sha == journal.next.source.sha256;
        anyhow::ensure!(
            commit || live_sha == journal.baseline.source.sha256,
            "COURSEWARE_CONFLICT: external PPT changes; all versions retained"
        );
        if journal.status != "pending" {
            anyhow::ensure!(
                journal.status == if commit { "committed" } else { "cancelled" },
                "COURSEWARE_CONFLICT: save already resolved"
            );
            return Ok(journal.receipt());
        }
        anyhow::ensure!(
            self.kv_get(PENDING, &storage_key(workspace, "native-save")?)?
                == Some(Value::String(key.clone())),
            "COURSEWARE_CONFLICT: native save lock changed"
        );
        let project_key = storage_key(workspace, &journal.next.project_id)?;
        let project = self.get_courseware_project(workspace, &journal.next.project_id)?;
        anyhow::ensure!(
            project
                .as_ref()
                .is_some_and(|p| serde_json::to_value(p).ok()
                    == serde_json::to_value(&journal.baseline).ok()),
            "COURSEWARE_CONFLICT: teaching changed during native save"
        );
        if commit {
            self.rebind_courseware_review_audio(workspace, &journal.baseline, &journal.next)?;
            self.rebind_native_save_tts(workspace, &journal.baseline, &journal.next)?;
            self.rebind_native_save_music(workspace, &journal.baseline, &journal.next)?;
            self.rebind_native_save_video(workspace, &journal.baseline, &journal.next)?;
            self.rebind_native_workflow(workspace, &journal.baseline, &journal.next)?;
            self.kv_set(
                HISTORY_NAMESPACE,
                &serde_json::to_string(&(&project_key, &journal.baseline.teaching_revision))?,
                &serde_json::to_value(&journal.baseline)?,
            )?;
            self.kv_set(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(workspace, &journal.next.project_id, live_sha)?,
                &journal.identity,
            )?;
            // Page writes compare the serialized typed project, including field order.
            self.conn.execute(
                "UPDATE kv SET value_json=?1,updated_at=?2 WHERE ns=?3 AND key=?4",
                params![
                    serde_json::to_string(&journal.next)?,
                    now_ms(),
                    NAMESPACE,
                    project_key
                ],
            )?;
            // Only unchanged draft baselines can follow a verified native save; divergent drafts remain recoverable.
            let drafts: Vec<(String, String)> = self
                .conn
                .prepare("SELECT key,value_json FROM kv WHERE ns=?1")?
                .query_map([DRAFTS], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            for (draft_key, raw) in drafts {
                let Ok(scope) = serde_json::from_str::<Vec<String>>(&draft_key) else {
                    continue;
                };
                if scope.len() != 4 || scope[0] != workspace || scope[2] != journal.next.project_id
                {
                    continue;
                }
                let mut draft: Value = serde_json::from_str(&raw)?;
                if draft["baseline"] != serde_json::to_value(&journal.baseline)? {
                    continue;
                }
                let Some(page) = journal
                    .next
                    .pages
                    .iter()
                    .find(|page| page.page_id == scope[3])
                else {
                    continue;
                };
                let objects: HashSet<_> = journal.identity["pages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|p| p["logicalId"] == page.page_id)
                    .flat_map(|p| p["objects"].as_array().unwrap())
                    .filter_map(|o| o["logicalId"].as_str())
                    .collect();
                if !draft["actions"].is_array() {
                    continue;
                }
                self.kv_set(
                    "coursewareTeachingDraftHistory.v1",
                    &serde_json::to_string(&(&draft_key, &draft["revision"]))?,
                    &draft,
                )?;
                let mut affected = false;
                draft["actions"]
                    .as_array_mut()
                    .unwrap()
                    .retain_mut(|action| {
                        if action["type"] == "native_animation" {
                            if !journal.animation_pages.contains(&page.page_id) {
                                affected = true;
                                return false;
                            }
                            action["sourceSha256"] = live_sha.into();
                        }
                        if let Some(cues) =
                            action.get_mut("visualCues").and_then(Value::as_array_mut)
                        {
                            cues.retain(|cue| {
                                let keep = reviews::effects::cue_targets(cue).is_ok_and(|ids| {
                                    ids.iter().all(|id| objects.contains(id.as_str()))
                                });
                                affected |= !keep;
                                keep
                            });
                        }
                        if action.get("attention").is_some_and(|a| {
                            !attention::targets(a)
                                .is_ok_and(|ids| ids.iter().all(|id| objects.contains(id.as_str())))
                        }) {
                            affected = true;
                            action.as_object_mut().unwrap().remove("attention");
                        }
                        true
                    });
                if affected {
                    journal.warnings.push(
                        "草稿中已失效的对象提示或动画绑定已停用，讲解保留；原草稿已归档".into(),
                    );
                }
                draft["baseline"] = serde_json::to_value(&journal.next)?;
                draft["revision"] = uuid::Uuid::new_v4().to_string().into();
                self.kv_set(DRAFTS, &draft_key, &draft)?;
            }
            self.kv_set(
                WARNINGS,
                &project_key,
                &serde_json::json!({"sourceSha256":live_sha,"warnings":journal.warnings}),
            )?;
            if let Some(document) = &journal.classroom {
                self.kv_set(classroom::DOCUMENTS, &project_key, document)?;
                self.kv_set(classroom::REVISIONS,
                    &serde_json::to_string(&(&project_key, &document["revision"]))?, document)?;
            }
        }
        journal.status = if commit { "committed" } else { "cancelled" }.into();
        self.kv_set(JOURNALS, &key, &serde_json::to_value(&journal)?)?;
        self.kv_delete(PENDING, &storage_key(workspace, "native-save")?)?;
        tx.commit()?;
        self.source_adoption_barrier()?;
        Ok(journal.receipt())
    }
}

#[cfg(test)]
mod tests;
