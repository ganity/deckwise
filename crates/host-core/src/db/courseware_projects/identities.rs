use super::*;
use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};

pub(super) const IDENTITY_NAMESPACE: &str = "coursewareIdentities.v1";

pub(super) fn identity_key(workspace: &str, project_id: &str, sha256: &str) -> Result<String> {
    Ok(serde_json::to_string(&(
        storage_key(workspace, project_id)?,
        sha256,
    ))?)
}

fn upgrade_fallback_identity(
    saved: &SavedSourceIdentity,
    fresh: &SavedSourceIdentity,
) -> Option<Value> {
    let old = saved.value();
    let mut next = fresh.value().clone();
    let fallback = |value: &Value| {
        value["diagnostics"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["code"] == "pptx_fallback_ooxml")
        })
    };
    if old["sourceSha256"] != next["sourceSha256"]
        || !fallback(old)
        || fallback(&next)
        || [old, &next].iter().any(|value| {
            value["diagnostics"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["severity"] == "error"))
        })
    {
        return None;
    }
    let old_pages = old["pages"].as_array()?;
    let pages = next["pages"].as_array_mut()?;
    if pages.len() != old_pages.len() {
        return None;
    }
    for (page, previous) in pages.iter_mut().zip(old_pages) {
        if page["importPageId"] != previous["importPageId"] {
            return None;
        }
        page["logicalId"] = previous["logicalId"].clone();
        let old_objects = previous["objects"].as_array()?;
        let objects = page["objects"].as_array_mut()?;
        if objects.len() != old_objects.len() {
            return None;
        }
        let mut by_native_id = std::collections::HashMap::new();
        for object in old_objects {
            if by_native_id
                .insert(object["sourceShapeId"].as_str()?, object)
                .is_some()
            {
                return None;
            }
        }
        for object in objects {
            let previous = by_native_id.remove(object["sourceShapeId"].as_str()?)?;
            let name = previous["sourceObjectName"].as_str()?;
            // Identical bytes and exact native identities, not changed parser fingerprints, prove correspondence.
            if name.trim().is_empty()
                || object["sourceObjectName"] != name
                || !(previous["type"] == object["type"]
                    || previous["type"] == "shape" && object["type"] == "text")
            {
                return None;
            }
            object["logicalId"] = previous["logicalId"].clone();
        }
    }
    next["mappingRevision"] = uuid::Uuid::new_v4().to_string().into();
    Some(next)
}

impl Database {
    /// Recovery buffers follow an unchanged page, never another page's revision alone.
    pub fn reconcile_courseware_draft(
        &self,
        workspace: &str,
        project: &CoursewareProject,
        page_id: &str,
        key: &str,
        draft: &Value,
    ) -> Result<Option<Value>> {
        let baseline: CoursewareProject = serde_json::from_value(draft["baseline"].clone())?;
        let page = project
            .pages
            .iter()
            .find(|page| page.page_id == page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_PAGE_NOT_FOUND: draft page missing"))?;
        let obsolete = draft["actions"] == serde_json::to_value(&page.actions)?
            && draft["instruction"].as_str().unwrap_or("").is_empty();
        if !obsolete {
            let unchanged = baseline.project_id == project.project_id
                && baseline
                    .pages
                    .iter()
                    .find(|page| page.page_id == page_id)
                    .is_some_and(|old| {
                        serde_json::to_value(old).ok() == serde_json::to_value(page).ok()
                    });
            if !unchanged || page.locked || draft["baseline"] == serde_json::to_value(project)? {
                return Ok(Some(draft.clone()));
            }
            if baseline.source.sha256 != project.source.sha256 {
                if draft["actions"]
                    .as_array()
                    .is_none_or(|actions| actions.iter().any(|a| a["type"] == "native_animation"))
                {
                    return Ok(Some(draft.clone()));
                }
                let mapped_page = |source: &str| -> Result<Value> {
                    let Some(identity) = self.kv_get(
                        IDENTITY_NAMESPACE,
                        &identity_key(workspace, &project.project_id, source)?,
                    )?
                    else {
                        return Ok(Value::Null);
                    };
                    let identity = SavedSourceIdentity::parse(&serde_json::to_vec(&identity)?)?;
                    Ok(identity.value()["pages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|page| page["logicalId"] == page_id)
                        .cloned()
                        .unwrap_or(Value::Null))
                };
                let old = mapped_page(&baseline.source.sha256)?;
                let next = mapped_page(&project.source.sha256)?;
                let inventory = |page: &Value| -> Option<Vec<Value>> {
                    Some(
                        page["objects"]
                            .as_array()?
                            .iter()
                            .map(|o| {
                                serde_json::json!([
                                    o["logicalId"],
                                    o["type"],
                                    o["contentFingerprint"]
                                ])
                            })
                            .collect(),
                    )
                };
                if old.is_null()
                    || next.is_null()
                    || old["contentFingerprint"] != next["contentFingerprint"]
                    || inventory(&old) != inventory(&next)
                {
                    return Ok(Some(draft.clone()));
                }
            }
        }
        self.ensure_no_source_adoption(workspace)?;
        let tx = self.conn.unchecked_transaction()?;
        self.kv_set(
            "coursewareTeachingDraftHistory.v1",
            &serde_json::to_string(&(key, &draft["revision"]))?,
            draft,
        )?;
        let result = if obsolete {
            self.kv_delete("coursewareTeachingDrafts.v1", key)?;
            None
        } else {
            let mut next = draft.clone();
            next["baseline"] = serde_json::to_value(project)?;
            next["revision"] = uuid::Uuid::new_v4().to_string().into();
            self.kv_set("coursewareTeachingDrafts.v1", key, &next)?;
            Some(next)
        };
        tx.commit()?;
        Ok(result)
    }

    // Recover pre-receipt native saves only when the complete named inventory is unambiguous.
    fn recover_named_saved_source(&self, workspace: &str, seed: &SavedProjectSeed) -> Result<()> {
        let Some(previous) = self.get_courseware_project(workspace, &seed.project_id)? else {
            return Ok(());
        };
        if previous.source.sha256 == seed.sha256 {
            return Ok(());
        }
        self.ensure_no_source_adoption(workspace)?;
        let conflict =
            "COURSEWARE_CONFLICT: PPTX changed; reconcile page identities before editing teaching";
        let fresh = seed.identity.as_ref().ok_or_else(|| anyhow!(conflict))?;
        anyhow::ensure!(
            fresh.matches_source(&seed.sha256, seed.pages)
                && fresh.value().get("mappingRevision").is_none(),
            "{conflict}"
        );
        let old = self
            .kv_get(
                IDENTITY_NAMESPACE,
                &identity_key(workspace, &seed.project_id, &previous.source.sha256)?,
            )?
            .ok_or_else(|| anyhow!(conflict))?;
        self.courseware_mapping_revision(workspace, &previous)?;
        let old_pages = old["pages"].as_array().unwrap();
        let mut bound = fresh.value().clone();
        let pages = bound["pages"].as_array_mut().unwrap();
        anyhow::ensure!(
            pages.len() == old_pages.len()
                && !previous
                    .pages
                    .iter()
                    .flat_map(|page| &page.actions)
                    .any(|action| action["type"] == "native_animation")
                && !fresh.value()["diagnostics"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|d| d["severity"] == "error"),
            "{conflict}"
        );
        let mut fingerprints = std::collections::HashSet::new();
        for (page, old_page) in pages.iter_mut().zip(old_pages) {
            anyhow::ensure!(
                page["contentFingerprint"] == old_page["contentFingerprint"]
                    && fingerprints.insert(page["contentFingerprint"].as_str().unwrap().to_owned()),
                "{conflict}"
            );
            let objects = page["objects"].as_array_mut().unwrap();
            let old_objects = old_page["objects"].as_array().unwrap();
            anyhow::ensure!(
                objects.len() == old_objects.len() && !objects.is_empty(),
                "{conflict}"
            );
            let mut names = std::collections::HashSet::new();
            for (object, old_object) in objects.iter_mut().zip(old_objects) {
                let name = object["sourceObjectName"].as_str().unwrap_or("");
                anyhow::ensure!(
                    !name.is_empty()
                        && names.insert(name.to_owned())
                        && object["sourceObjectName"] == old_object["sourceObjectName"]
                        && object["type"] == old_object["type"]
                        && object["contentFingerprint"] == old_object["contentFingerprint"],
                    "{conflict}"
                );
                object["logicalId"] = old_object["logicalId"].clone();
            }
            page["logicalId"] = old_page["logicalId"].clone();
        }
        bound["mappingRevision"] = uuid::Uuid::new_v4().to_string().into();
        SavedSourceIdentity::parse(&serde_json::to_vec(&bound)?)?;
        let mut next = previous.clone();
        next.source = CoursewareSource {
            revision: seed.sha256.clone(),
            sha256: seed.sha256.clone(),
        };
        next.teaching_revision = uuid::Uuid::new_v4().to_string();
        next.validate()?;
        self.rebind_courseware_review_audio(workspace, &previous, &next)?;
        let key = storage_key(workspace, &seed.project_id)?;
        self.kv_set(
            HISTORY_NAMESPACE,
            &serde_json::to_string(&(&key, &previous.teaching_revision))?,
            &serde_json::to_value(&previous)?,
        )?;
        let new_key = identity_key(workspace, &seed.project_id, &seed.sha256)?;
        anyhow::ensure!(
            self.kv_get(IDENTITY_NAMESPACE, &new_key)?.is_none(),
            "{conflict}"
        );
        self.kv_set(IDENTITY_NAMESPACE, &new_key, &bound)?;
        let changed = self.conn.execute(
            "UPDATE kv SET value_json=?1,updated_at=?2 WHERE ns=?3 AND key=?4 AND value_json=?5",
            params![
                serde_json::to_string(&next)?,
                now_ms(),
                NAMESPACE,
                key,
                serde_json::to_string(&previous)?
            ],
        )?;
        anyhow::ensure!(
            changed == 1,
            "COURSEWARE_CONFLICT: teaching changed during saved source recovery"
        );
        Ok(())
    }

    /// Current canonical project and mapping, with no candidate, archive or revision writes.
    pub fn courseware_project_context(&self, workspace: &str, project_id: &str) -> Result<Value> {
        let tx = self.conn.unchecked_transaction()?;
        let project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        let mapping = self.courseware_mapping(workspace, &project)?;
        let identity = self
            .kv_get(
                IDENTITY_NAMESPACE,
                &identity_key(workspace, &project.project_id, &project.source.sha256)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: saved identity is missing"))?;
        let saved_objects = serde_json::json!({
            "sourceSha256": project.source.sha256, "mappingRevision": mapping["revision"],
            "pages": identity["pages"].as_array().into_iter().flatten().map(|page| serde_json::json!({
                "pageId": page["logicalId"],
                "objects": page["objects"].as_array().into_iter().flatten().enumerate().map(|(index, object)|
                    serde_json::json!({"objectId":object["logicalId"], "kind":object["type"], "index":index + 1,
                      "sourceShapeId":object["sourceShapeId"], "sourceObjectName":object["sourceObjectName"]})
                ).collect::<Vec<_>>()
            })).collect::<Vec<_>>()
        });
        let native_saved = self.has_native_save_receipt(workspace, &project)?;
        let mut context = serde_json::json!({ "project": project, "mapping": mapping, "savedObjects": saved_objects, "nativeSaved": native_saved, "saveWarnings": self.native_save_warnings(workspace, &project)? });
        let mut assessments: Vec<_> = self
            .courseware_assessment_page_ids(workspace, &project)?
            .into_iter()
            .collect();
        assessments.sort();
        context["assessmentPageIds"] = serde_json::json!(assessments);
        context["completion"] = self.courseware_completion(workspace, &project)?;
        if project.task_type == "plain" {
            if let Some(requirements) =
                self.courseware_teaching_requirements(workspace, &project)?
            {
                context["teachingRequirements"] = requirements["pages"].clone();
            }
        }
        let chat_changes = self.courseware_chat_change_context(workspace, &project)?;
        if !chat_changes.is_empty() {
            context["chatChanges"] = serde_json::json!(chat_changes);
        }
        if let Some(change) = self.source_change_context(workspace, &project)? {
            context["sourceChange"] = change;
        }
        if let Some(objects) = self.courseware_scene_objects(workspace, &project)? {
            context["sceneObjects"] = objects;
        }
        tx.commit()?;
        Ok(context)
    }

    pub(super) fn courseware_mapping(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<Value> {
        // Validate source hash, mapping revision and ordered logical IDs before projecting.
        let revision = self.courseware_mapping_revision(workspace, project)?;
        let value = self
            .kv_get(
                IDENTITY_NAMESPACE,
                &identity_key(workspace, &project.project_id, &project.source.sha256)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: saved identity is missing"))?;
        let pages: Vec<_> = value["pages"]
            .as_array()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: saved identity pages are missing"))?
            .iter()
            .map(|page| {
                let objects: Vec<_> = page["objects"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|object| {
                        serde_json::json!({
                            "objectId": object["logicalId"],
                            "importElementId": object["importElementId"]
                        })
                    })
                    .collect();
                serde_json::json!({
                    "pageId": page["logicalId"], "importPageId": page["importPageId"],
                    "objects": objects
                })
            })
            .collect();
        Ok(
            serde_json::json!({ "revision": revision, "sourceSha256": project.source.sha256, "pages": pages }),
        )
    }

    #[cfg(test)]
    pub fn open_identified_courseware_project(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
    ) -> Result<CoursewareProject> {
        self.open_identified_courseware_project_with_metadata(workspace, seed, "import", None)
    }

    pub fn open_identified_courseware_project_with_metadata(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
        task_type: &str,
        education_context: Option<CoursewareEducationContext>,
    ) -> Result<CoursewareProject> {
        let tx = self.conn.unchecked_transaction()?;
        self.recover_named_saved_source(workspace, seed)?;
        let project = self.open_saved_courseware_project_with_metadata(
            workspace,
            &seed.project_id,
            &seed.sha256,
            seed.pages,
            task_type,
            education_context,
        )?;
        if let Some(identity) = &seed.identity {
            anyhow::ensure!(
                identity.matches_source(&project.source.sha256, project.pages.len())
                    && identity.value().get("mappingRevision").is_none(),
                "COURSEWARE_INVALID: identity does not match saved source"
            );
            let key = identity_key(workspace, &project.project_id, &project.source.sha256)?;
            if let Some(saved) = self.kv_get(IDENTITY_NAMESPACE, &key)? {
                let mut saved = SavedSourceIdentity::parse(&serde_json::to_vec(&saved)?)?;
                if !saved.same_export(identity) {
                    self.courseware_mapping_revision(workspace, &project)?;
                    if let Some(upgraded) = upgrade_fallback_identity(&saved, identity) {
                        self.ensure_no_source_adoption(workspace)?;
                        let history_key =
                            serde_json::to_string(&(&key, &saved.value()["mappingRevision"]))?;
                        self.kv_set("coursewareIdentityHistory.v1", &history_key, saved.value())?;
                        anyhow::ensure!(
                            self.kv_get("coursewareIdentityHistory.v1", &history_key)?
                                .as_ref()
                                == Some(saved.value()),
                            "COURSEWARE_INVALID: previous identity archive was not saved"
                        );
                        saved = SavedSourceIdentity::parse(&serde_json::to_vec(&upgraded)?)?;
                    }
                }
                let pages = saved.value()["pages"]
                    .as_array()
                    .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing saved identity pages"))?;
                anyhow::ensure!(
                    saved.value().get("mappingRevision").is_some()
                        && saved.same_export(identity)
                        && pages
                            .iter()
                            .zip(&project.pages)
                            .all(|(page, canonical)| page["logicalId"] == canonical.page_id),
                    "COURSEWARE_CONFLICT: saved identity differs; explicit review is required"
                );
                // Backfill verified native names without changing logical identities or fingerprints.
                let mut enriched = saved.value().clone();
                for (old_page, fresh_page) in enriched["pages"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .zip(identity.value()["pages"].as_array().unwrap())
                {
                    for (old, fresh) in old_page["objects"]
                        .as_array_mut()
                        .unwrap()
                        .iter_mut()
                        .zip(fresh_page["objects"].as_array().unwrap())
                    {
                        if let Some(name) = fresh.get("sourceObjectName") {
                            old["sourceObjectName"] = name.clone();
                        }
                    }
                }
                self.kv_set(IDENTITY_NAMESPACE, &key, &enriched)?;
                anyhow::ensure!(
                    self.kv_get(IDENTITY_NAMESPACE, &key)?.as_ref() == Some(&enriched),
                    "COURSEWARE_INVALID: saved identity update was not committed"
                );
            } else {
                let ids: Vec<_> = project
                    .pages
                    .iter()
                    .map(|page| page.page_id.as_str())
                    .collect();
                let bound = identity.bind(&ids)?;
                self.conn.execute(
                    "INSERT INTO kv (ns, key, value_json, updated_at) VALUES (?1, ?2, ?3, ?4)",
                    params![
                        IDENTITY_NAMESPACE,
                        key,
                        serde_json::to_string(bound.value())?,
                        now_ms()
                    ],
                )?;
            }
        }
        tx.commit()?;
        Ok(project)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod context_tests;
