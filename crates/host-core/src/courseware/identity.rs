//! D's saved-source identity envelope; logical IDs become authoritative only after Host binding.
use anyhow::{bail, ensure, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;

pub const SCHEMA: &str = "maic-saved-source-identity/1";
const MAX_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SavedSourceIdentity(Value);

fn fields(value: &Value, allowed: &[&str]) -> Result<()> {
    ensure!(
        value
            .as_object()
            .is_some_and(|object| object.keys().all(|key| allowed.contains(&key.as_str()))),
        "unexpected identity fields"
    );
    Ok(())
}

fn id(value: &Value) -> bool {
    value
        .as_str()
        .is_some_and(|text| (1..=200).contains(&text.encode_utf16().count()))
}

fn hash(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() == 64
            && text
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

impl SavedSourceIdentity {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let parsed = (|| {
            ensure!(
                bytes.len() as u64 <= MAX_BYTES,
                "identity exceeds size limit"
            );
            let value: Value = serde_json::from_slice(bytes)?;
            fields(
                &value,
                &[
                    "schemaVersion",
                    "sourceSha256",
                    "mappingRevision",
                    "pages",
                    "diagnostics",
                ],
            )?;
            ensure!(
                value["schemaVersion"] == SCHEMA && hash(&value["sourceSha256"]),
                "invalid identity schema/source"
            );
            ensure!(
                value.get("mappingRevision").is_none_or(id),
                "invalid mapping revision"
            );
            let pages = value["pages"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("missing identity pages"))?;
            ensure!(
                (1..=100).contains(&pages.len()),
                "invalid identity page count"
            );
            let mut logical_ids = HashSet::new();
            let mut import_ids = HashSet::new();
            let mut count = 0;
            for page in pages {
                fields(
                    page,
                    &["logicalId", "importPageId", "contentFingerprint", "objects"],
                )?;
                ensure!(
                    id(&page["logicalId"])
                        && id(&page["importPageId"])
                        && hash(&page["contentFingerprint"]),
                    "invalid page identity"
                );
                ensure!(
                    logical_ids.insert(page["logicalId"].as_str())
                        && import_ids.insert(page["importPageId"].as_str()),
                    "duplicate page identity"
                );
                let objects = page["objects"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("missing identity objects"))?;
                count += objects.len();
                ensure!(count <= 10000, "identity exceeds object limit");
                let mut element_ids = HashSet::new();
                for object in objects {
                    fields(
                        object,
                        &[
                            "logicalId",
                            "importElementId",
                            "type",
                            "contentFingerprint",
                            "geometryFingerprint",
                            "sourceShapeId",
                        ],
                    )?;
                    ensure!(
                        ["logicalId", "importElementId", "type"]
                            .iter()
                            .all(|key| id(&object[key]))
                            && hash(&object["contentFingerprint"])
                            && hash(&object["geometryFingerprint"])
                            && object.get("sourceShapeId").is_none_or(id),
                        "invalid object identity"
                    );
                    ensure!(
                        logical_ids.insert(object["logicalId"].as_str())
                            && element_ids.insert(object["importElementId"].as_str()),
                        "duplicate object identity"
                    );
                }
            }
            let diagnostics = value["diagnostics"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("missing identity diagnostics"))?;
            for diagnostic in diagnostics {
                fields(diagnostic, &["code", "message", "severity", "pageIndex"])?;
                ensure!(
                    id(&diagnostic["code"])
                        && diagnostic["message"].is_string()
                        && diagnostic.get("severity").is_none_or(|severity| matches!(
                            severity.as_str(),
                            Some("info" | "warning" | "error")
                        ))
                        && diagnostic
                            .get("pageIndex")
                            .is_none_or(|index| index.as_u64().is_some()),
                    "invalid identity diagnostic"
                );
            }
            Ok(Self(value))
        })();
        parsed.map_err(|error: anyhow::Error| anyhow::anyhow!("COURSEWARE_INVALID: {error}"))
    }

    pub fn value(&self) -> &Value {
        &self.0
    }

    pub fn matches_source(&self, source: &str, pages: usize) -> bool {
        self.0["sourceSha256"] == source
            && self.0["pages"]
                .as_array()
                .is_some_and(|items| items.len() == pages)
    }

    pub fn check_ir(&self, ir: &Value) -> Result<()> {
        let pages = ir["pages"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("COURSEWARE_INVALID: missing IR pages"))?;
        ensure!(
            self.0.get("mappingRevision").is_none()
                && self.0["pages"]
                    .as_array()
                    .is_some_and(|items| items.len() == pages.len()),
            "COURSEWARE_INVALID: incomplete or already bound worker identity"
        );
        for (identity, page) in self.0["pages"].as_array().into_iter().flatten().zip(pages) {
            let objects = identity["objects"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("COURSEWARE_INVALID: missing objects"))?;
            let elements = page["elements"]
                .as_array()
                .ok_or_else(|| anyhow::anyhow!("COURSEWARE_INVALID: missing IR elements"))?;
            ensure!(
                identity["importPageId"] == page["id"]
                    && objects.len() == elements.len()
                    && objects.iter().zip(elements).all(|(object, element)| object
                        ["importElementId"]
                        == element["id"]
                        && object["type"] == element["type"]),
                "COURSEWARE_INVALID: identity does not cover parsed pages/objects"
            );
        }
        Ok(())
    }

    pub fn bind(&self, page_ids: &[&str]) -> Result<Self> {
        let mut value = self.0.clone();
        let pages = value["pages"]
            .as_array_mut()
            .ok_or_else(|| anyhow::anyhow!("COURSEWARE_INVALID: missing pages"))?;
        ensure!(
            self.0.get("mappingRevision").is_none() && pages.len() == page_ids.len(),
            "COURSEWARE_INVALID: cannot bind identity"
        );
        for (page, id) in pages.iter_mut().zip(page_ids) {
            page["logicalId"] = (*id).into();
            for object in page["objects"].as_array_mut().into_iter().flatten() {
                object["logicalId"] = uuid::Uuid::new_v4().to_string().into();
            }
        }
        value["mappingRevision"] = uuid::Uuid::new_v4().to_string().into();
        Self::parse(&serde_json::to_vec(&value)?)
    }

    /// Bind pinned remote logical IDs only after the complete parsed import IDs match.
    pub fn bind_mapping(&self, mapping: &Value) -> Result<Self> {
        let logical_id = |value: &Value| {
            value.as_str().is_some_and(|text| {
                !text.is_empty()
                    && text.len() <= 128
                    && text != "."
                    && text != ".."
                    && text
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte))
            })
        };
        fields(
            mapping,
            &["revision", "sourceRevision", "sourceSha256", "pages"],
        )?;
        ensure!(
            serde_json::to_vec(mapping)?.len() <= 2 * 1024 * 1024
                && self.0.get("mappingRevision").is_none()
                && logical_id(&mapping["revision"])
                && logical_id(&mapping["sourceRevision"])
                && mapping["sourceSha256"] == self.0["sourceSha256"],
            "COURSEWARE_INVALID: invalid online source mapping"
        );
        let mapped = mapping["pages"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("COURSEWARE_INVALID: missing online mapping pages"))?;
        let mut value = self.0.clone();
        let pages = value["pages"].as_array_mut().unwrap();
        ensure!(
            mapped.len() == pages.len(),
            "COURSEWARE_CONFLICT: incomplete online mapping"
        );
        for (page, supplied) in pages.iter_mut().zip(mapped) {
            fields(supplied, &["pageId", "importPageId", "objects"])?;
            ensure!(
                logical_id(&supplied["pageId"]) && supplied["importPageId"] == page["importPageId"],
                "COURSEWARE_CONFLICT: online mapping page differs from parsed source"
            );
            let supplied_objects = supplied["objects"].as_array().ok_or_else(|| {
                anyhow::anyhow!("COURSEWARE_INVALID: missing online mapping objects")
            })?;
            let objects = page["objects"].as_array_mut().unwrap();
            ensure!(
                objects.len() == supplied_objects.len(),
                "COURSEWARE_CONFLICT: incomplete online object mapping"
            );
            for (object, supplied_object) in objects.iter_mut().zip(supplied_objects) {
                fields(supplied_object, &["objectId", "importElementId"])?;
                ensure!(
                    logical_id(&supplied_object["objectId"])
                        && supplied_object["importElementId"] == object["importElementId"],
                    "COURSEWARE_CONFLICT: online mapping object differs from parsed source"
                );
                object["logicalId"] = supplied_object["objectId"].clone();
            }
            page["logicalId"] = supplied["pageId"].clone();
        }
        value["mappingRevision"] = mapping["revision"].clone();
        Self::parse(&serde_json::to_vec(&value)?)
    }

    pub fn same_export(&self, other: &Self) -> bool {
        fn unbound(identity: &SavedSourceIdentity) -> Value {
            let mut value = identity.0.clone();
            if let Some(object) = value.as_object_mut() {
                object.remove("mappingRevision");
            }
            for page in value["pages"].as_array_mut().into_iter().flatten() {
                page["logicalId"] = Value::Null;
                for object in page["objects"].as_array_mut().into_iter().flatten() {
                    object["logicalId"] = Value::Null;
                }
            }
            value
        }
        unbound(self) == unbound(other)
    }
}

pub fn read(
    output: &Path,
    digest: &str,
    source: &str,
    pages: usize,
) -> Result<SavedSourceIdentity> {
    let source_file = super::open_source(output, &output.join("identity.json"))?;
    let mut bytes = Vec::new();
    source_file
        .file
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_BYTES && hex::encode(Sha256::digest(&bytes)) == digest,
        "COURSEWARE_INVALID: worker identity digest mismatch"
    );
    let identity = SavedSourceIdentity::parse(&bytes)?;
    ensure!(
        identity.matches_source(source, pages),
        "COURSEWARE_INVALID: worker identity source mismatch"
    );
    Ok(identity)
}

pub fn verify_worker(output: &Path, report: &Value, ir: &Value) -> Result<Option<String>> {
    match (
        report.get("identitySchemaVersion"),
        report.get("identitySha256"),
    ) {
        (None, None) => Ok(None),
        (Some(schema), Some(digest)) if schema == SCHEMA && hash(digest) => {
            let digest = digest
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("COURSEWARE_INVALID: missing digest"))?;
            let source = report["sourceSha256"].as_str().unwrap_or("");
            let pages = ir["pages"].as_array().map_or(0, Vec::len);
            read(output, digest, source, pages)?.check_ir(ir)?;
            Ok(Some(digest.into()))
        }
        _ => bail!("COURSEWARE_INVALID: incomplete worker identity metadata"),
    }
}

#[cfg(test)]
mod tests;
