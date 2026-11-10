use super::*;
use crate::courseware::identity::SavedSourceIdentity;
use std::collections::HashSet;

const SCENE_OBJECTS_NAMESPACE: &str = "coursewareSceneObjects.v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedSceneMapping {
    pub pages: Vec<GeneratedScenePage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GeneratedScenePage {
    pub slide_id: String,
    pub source_hash: String,
    slide_part: String,
    elements: Vec<GeneratedSceneObject>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    teaching: Option<scene_teaching::Teaching>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeneratedSceneObject {
    element_id: String,
    object_name: String,
    source_shape_id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    spoken_aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    semantic_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    animation_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    object_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    action_description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    observed_semantic_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity_mismatch: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    regeneration_prompt: Option<String>,
}

impl GeneratedSceneMapping {
    /// Object IDs must come from the trusted parser, never a scene's array position.
    pub fn validate_source(&self, identity: &SavedSourceIdentity) -> Result<()> {
        anyhow::ensure!(
            serde_json::to_vec(self)?.len() <= MAX_BYTES && (1..=100).contains(&self.pages.len()),
            "COURSEWARE_INVALID: scene mapping exceeds limits"
        );
        let pages = identity.value()["pages"]
            .as_array()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: scene identity pages are missing"))?;
        anyhow::ensure!(
            self.pages.len() == pages.len(),
            "COURSEWARE_INVALID: scene page count differs (exported {}, parsed {})",
            self.pages.len(), pages.len()
        );
        let mut page_ids = HashSet::new();
        for (index, (page, saved)) in self.pages.iter().zip(pages).enumerate() {
            let objects = saved["objects"]
                .as_array()
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: scene identity objects are missing"))?;
            anyhow::ensure!(
                valid_id(&page.slide_id)
                    && page.teaching.as_ref().is_none_or(|t| t.valid())
                    && page_ids.insert(&page.slide_id)
                    && page
                        .source_hash
                        .strip_prefix("sha256:")
                        .is_some_and(valid_hash)
                    && page.slide_part == format!("ppt/slides/slide{}.xml", index + 1)
                    && (1..=200).contains(&page.elements.len()),
                "COURSEWARE_INVALID: invalid scene page metadata at page {} ({})",
                index + 1, page.slide_id
            );
            anyhow::ensure!(
                page.elements.len() == objects.len(),
                "COURSEWARE_INVALID: scene object count differs at page {} ({}): exported {}, parsed {}",
                index + 1, page.slide_id, page.elements.len(), objects.len()
            );
            let mut element_ids = HashSet::new();
            let mut shape_ids = HashSet::new();
            for element in &page.elements {
                let expected_types: &[&str] = match element.kind.as_str() {
                    // Explicit textboxes import as text; older exports used shapes with text.
                    "native_text" => &["text", "shape"],
                    "native_shape" => &["shape"],
                    "image_layer" => &["image"],
                    "connector" => &["line"],
                    _ => return Err(anyhow!("COURSEWARE_INVALID: unsupported scene object type")),
                };
                let matches: Vec<_> = objects
                    .iter()
                    .filter(|object| {
                        object["sourceShapeId"].as_str() == Some(&element.source_shape_id)
                    })
                    .collect();
                anyhow::ensure!(
                    bounded_text(&element.element_id, 200)
                        && element.object_name == element.element_id
                        && element_ids.insert(&element.element_id)
                        && shape_ids.insert(&element.source_shape_id)
                        && element
                            .source_shape_id
                            .parse::<u32>()
                            .is_ok_and(|id| id > 0)
                        && matches.len() == 1
                        && matches[0]["type"]
                            .as_str()
                            .is_some_and(|kind| expected_types.contains(&kind))
                        && element.spoken_aliases.len() <= 50
                        && element
                            .spoken_aliases
                            .iter()
                            .all(|text| bounded_text(text, 500))
                        && [
                            &element.semantic_role,
                            &element.action_description,
                            &element.observed_semantic_role,
                            &element.source_text,
                            &element.regeneration_prompt
                        ]
                        .iter()
                        .all(|text| text.as_ref().is_none_or(|text| bounded_text(text, 8000)))
                        && element
                            .animation_policy
                            .as_ref()
                            .is_none_or(|value| matches!(
                                value.as_str(),
                                "static" | "appear_on_first_mention" | "emphasize_on_repeat"
                            ))
                        && element.object_kind.as_ref().is_none_or(|value| matches!(
                            value.as_str(),
                            "person" | "animal" | "prop" | "unknown"
                        )),
                    "COURSEWARE_INVALID: scene object does not match saved source at page {} ({}), object {}",
                    index + 1, page.slide_id, element.element_id
                );
            }
        }
        Ok(())
    }
}

fn bounded_text(text: &str, max: usize) -> bool {
    !text.trim().is_empty() && text.encode_utf16().count() <= max
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SceneObjectsRecord {
    schema_version: String,
    source_sha256: String,
    mapping: GeneratedSceneMapping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneSemanticEvidence {
    pub object_id: String,
    pub role: String,
    pub aliases: Vec<String>,
    pub text: String,
    pub teaching_target: bool,
}

impl Database {
    pub(super) fn restore_portable_scene_objects(
        &self,
        workspace: &str,
        project: &CoursewareProject,
        scene: &portable::SceneObjects,
    ) -> Result<()> {
        scene.validate()?;
        let original_hash = scene.original_identity["sourceSha256"].as_str().unwrap();
        let key = identities::identity_key(workspace, &project.project_id, original_hash)?;
        if let Some(current) = self.kv_get(identities::IDENTITY_NAMESPACE, &key)? {
            anyhow::ensure!(
                current == scene.original_identity,
                "COURSEWARE_CONFLICT: portable original scene identity differs"
            );
        } else {
            self.kv_set(
                identities::IDENTITY_NAMESPACE,
                &key,
                &scene.original_identity,
            )?;
        }
        self.kv_set(
            SCENE_OBJECTS_NAMESPACE,
            &storage_key(workspace, &project.project_id)?,
            &serde_json::to_value(SceneObjectsRecord {
                schema_version: "deckwise-scene-objects/1".into(),
                source_sha256: original_hash.into(),
                mapping: scene.mapping.clone(),
            })?,
        )
    }

    /// Evidence updates metadata only; saved identities and layer geometry remain authoritative.
    pub(super) fn save_scene_semantic_evidence(
        &self, workspace: &str, project: &CoursewareProject, page_id: &str, evidence: &[SceneSemanticEvidence],
    ) -> Result<()> {
        if evidence.is_empty() { return Ok(()); }
        anyhow::ensure!(project.task_type == "scene" && evidence.len() <= 200, "COURSEWARE_INVALID: invalid semantic evidence scope");
        let projection = self.courseware_scene_objects(workspace, project)?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: generated scene mapping missing"))?;
        let page = projection["pages"].as_array().into_iter().flatten().find(|p| p["pageId"] == page_id);
        let native_saved = self.has_native_save_receipt(workspace, project)?;
        let identity = self.scene_object_identity(workspace, &project.project_id, &project.source.sha256)?;
        let current_page = identity.value()["pages"].as_array().into_iter().flatten().find(|p| p["logicalId"] == page_id);
        let key = storage_key(workspace, &project.project_id)?;
        let saved = self.kv_get(SCENE_OBJECTS_NAMESPACE, &key)?.ok_or_else(|| anyhow!("COURSEWARE_INVALID: semantic mapping missing"))?;
        let mut record: SceneObjectsRecord = serde_json::from_value(saved)?;
        let mut target = record.mapping.pages.iter_mut().find(|p| page.is_some_and(|page| p.slide_id == page["planPageId"]));
        let mut seen = HashSet::new();
        for annotation in evidence {
            anyhow::ensure!(seen.insert(&annotation.object_id) && bounded_text(&annotation.role, 1000)
                && annotation.aliases.len() <= 50 && annotation.aliases.iter().all(|a| bounded_text(a, 500))
                && annotation.text.encode_utf16().count() <= 4000, "COURSEWARE_INVALID: invalid semantic annotation");
            let object = page.and_then(|p| p["objects"].as_array()).into_iter().flatten().find(|o| o["objectId"] == annotation.object_id && o["status"] == "mapped");
            let Some(object) = object else {
                anyhow::ensure!(native_saved && current_page.and_then(|p| p["objects"].as_array()).into_iter().flatten()
                    .any(|o| o["logicalId"] == annotation.object_id),
                    "COURSEWARE_CONFLICT: semantic object changed or is unknown");
                // Fresh vision evidence can authorize this narration, but cannot relabel an original layer with a different UUID.
                continue;
            };
            let element = target.as_mut().and_then(|t| t.elements.iter_mut().find(|e| e.element_id == object["element"]["elementId"]))
                .ok_or_else(|| anyhow!("COURSEWARE_INVALID: semantic element missing"))?;
            element.observed_semantic_role = Some(annotation.role.clone());
            element.semantic_role = Some(annotation.role.clone());
            element.spoken_aliases = annotation.aliases.clone();
            element.spoken_aliases.sort(); element.spoken_aliases.dedup();
            if !annotation.teaching_target { element.animation_policy = Some("static".into()); }
            else if element.animation_policy.is_none() {
                element.animation_policy = Some("emphasize_on_repeat".into());
            }
            element.source_text = (!annotation.text.trim().is_empty()).then(|| annotation.text.clone());
        }
        let original = self.scene_object_identity(workspace, &project.project_id, &record.source_sha256)?;
        record.mapping.validate_source(&original)?;
        self.kv_set(SCENE_OBJECTS_NAMESPACE, &key, &serde_json::to_value(record)?)
    }

    pub fn initialize_generated_scene_objects(
        &self,
        workspace: &str,
        project: &CoursewareProject,
        mapping: &GeneratedSceneMapping,
    ) -> Result<()> {
        anyhow::ensure!(
            project.task_type == "scene",
            "COURSEWARE_INVALID: scene task required"
        );
        let identity =
            self.scene_object_identity(workspace, &project.project_id, &project.source.sha256)?;
        mapping.validate_source(&identity)?;
        let value = serde_json::to_value(SceneObjectsRecord {
            schema_version: "deckwise-scene-objects/1".into(),
            source_sha256: project.source.sha256.clone(),
            mapping: mapping.clone(),
        })?;
        let key = storage_key(workspace, &project.project_id)?;
        if let Some(existing) = self.kv_get(SCENE_OBJECTS_NAMESPACE, &key)? {
            anyhow::ensure!(
                existing == value,
                "COURSEWARE_CONFLICT: generated scene objects already differ"
            );
        } else {
            self.kv_set(SCENE_OBJECTS_NAMESPACE, &key, &value)?;
        }
        Ok(())
    }

    fn scene_object_identity(
        &self,
        workspace: &str,
        project_id: &str,
        sha256: &str,
    ) -> Result<SavedSourceIdentity> {
        let value = self
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(workspace, project_id, sha256)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: scene object identity is missing"))?;
        let identity = SavedSourceIdentity::parse(&serde_json::to_vec(&value)?)?;
        anyhow::ensure!(
            value["sourceSha256"] == sha256 && value.get("mappingRevision").is_some(),
            "COURSEWARE_INVALID: scene object identity is unbound or stale"
        );
        Ok(identity)
    }

    pub(super) fn portable_scene_objects(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<Option<portable::SceneObjects>> {
        if self.courseware_scene_objects(workspace, project)?.is_none() {
            return Ok(None);
        }
        let record: SceneObjectsRecord = serde_json::from_value(
            self.kv_get(
                SCENE_OBJECTS_NAMESPACE,
                &storage_key(workspace, &project.project_id)?,
            )?
            .unwrap(),
        )?;
        let mut original_identity = self
            .scene_object_identity(workspace, &project.project_id, &record.source_sha256)?
            .value()
            .clone();
        original_identity["diagnostics"] = serde_json::json!([]);
        let result = portable::SceneObjects {
            original_identity,
            mapping: record.mapping,
        };
        result.validate()?;
        Ok(Some(result))
    }

    pub(super) fn courseware_scene_objects(
        &self,
        workspace: &str,
        project: &CoursewareProject,
    ) -> Result<Option<Value>> {
        let Some(raw) = self.kv_get(
            SCENE_OBJECTS_NAMESPACE,
            &storage_key(workspace, &project.project_id)?,
        )?
        else {
            return Ok(None);
        };
        anyhow::ensure!(
            serde_json::to_vec(&raw)?.len() <= MAX_BYTES,
            "COURSEWARE_INVALID: scene object record exceeds limits"
        );
        let record: SceneObjectsRecord = serde_json::from_value(raw)
            .map_err(|error| anyhow!("COURSEWARE_INVALID: invalid scene object record: {error}"))?;
        anyhow::ensure!(
            record.schema_version == "deckwise-scene-objects/1"
                && valid_hash(&record.source_sha256),
            "COURSEWARE_INVALID: invalid scene object record version or hash"
        );
        let original =
            self.scene_object_identity(workspace, &project.project_id, &record.source_sha256)?;
        record.mapping.validate_source(&original)?;
        let current =
            self.scene_object_identity(workspace, &project.project_id, &project.source.sha256)?;
        let pages = record.mapping.pages.iter().zip(original.value()["pages"].as_array().into_iter().flatten())
            .map(|(page, old_page)| {
                let current_page = current.value()["pages"].as_array().into_iter().flatten()
                    .find(|candidate| candidate["logicalId"] == old_page["logicalId"]);
                let objects: Result<Vec<Value>> = page.elements.iter().map(|element| {
                    let old = old_page["objects"].as_array().into_iter().flatten()
                        .find(|object| object["sourceShapeId"] == element.source_shape_id)
                        .ok_or_else(|| anyhow!("COURSEWARE_INVALID: generated scene object is missing"))?;
                    let live = current_page.and_then(|p| p["objects"].as_array()).into_iter().flatten()
                        .find(|object| object["logicalId"] == old["logicalId"]);
                    let status = match live {
                        None => "missing",
                        Some(object) if object["contentFingerprint"] != old["contentFingerprint"] => "content_changed",
                        Some(_) if element.identity_mismatch == Some(true) => "identity_mismatch",
                        Some(_) => "mapped",
                    };
                    Ok(serde_json::json!({"objectId":old["logicalId"], "element":element, "status":status,
                        "currentSourceShapeId":live.map(|object| &object["sourceShapeId"])}))
                }).collect();
                Ok(serde_json::json!({"pageId":old_page["logicalId"], "planPageId":page.slide_id, "teaching":page.teaching,
                    "status":if current_page.is_some() { "present" } else { "missing" }, "objects":objects?}))
            }).collect::<Result<Vec<Value>>>()?;
        Ok(Some(
            serde_json::json!({"schemaVersion":"deckwise-scene-objects/1",
            "sourceSha256":project.source.sha256, "originalSourceSha256":record.source_sha256,
            "requiresReview":true, "pages":pages}),
        ))
    }
}

#[cfg(test)]
mod tests;
