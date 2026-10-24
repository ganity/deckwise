use super::*;
use crate::courseware::{identity::SavedSourceIdentity, SavedProjectSeed};

pub(super) const IDENTITY_NAMESPACE: &str = "coursewareIdentities.v1";

pub(super) fn identity_key(workspace: &str, project_id: &str, sha256: &str) -> Result<String> {
    Ok(serde_json::to_string(&(
        storage_key(workspace, project_id)?,
        sha256,
    ))?)
}

impl Database {
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
                    serde_json::json!({"objectId":object["logicalId"], "kind":object["type"], "index":index + 1})
                ).collect::<Vec<_>>()
            })).collect::<Vec<_>>()
        });
        let mut context = serde_json::json!({ "project": project, "mapping": mapping, "savedObjects": saved_objects });
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
                let saved = SavedSourceIdentity::parse(&serde_json::to_vec(&saved)?)?;
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
