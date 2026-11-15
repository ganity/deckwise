//! Read trusted, hash-pinned parser output for an explicit canonical source refresh.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;

impl Parser {
    pub fn classroom_source(&self, id: &str, workspace: &Path) -> Result<Value> {
        self.saved_project_seed(id, workspace)?;
        let job = self.get(id)?;
        let output = job.directory.join("output");
        let mut bytes = Vec::new();
        open_source(&output, &output.join("slide-ir.json"))?
            .file
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        anyhow::ensure!(
            bytes.len() <= 64 * 1024 * 1024
                && self.status(id)?["summary"]["irSha256"] == hex::encode(Sha256::digest(&bytes)),
            "COURSEWARE_CONFLICT: parsed content changed"
        );
        let ir: Value = serde_json::from_slice(&bytes)?;
        let mut ids = HashSet::new();
        fn collect(v: &Value, ids: &mut HashSet<String>) {
            match v {
                Value::String(s) => {
                    if let Some(id) = s.strip_prefix("import-asset:local:") {
                        ids.insert(id.to_owned());
                    }
                }
                Value::Array(a) => {
                    for v in a {
                        collect(v, ids);
                    }
                }
                Value::Object(o) => {
                    for v in o.values() {
                        collect(v, ids);
                    }
                }
                _ => {}
            }
        }
        collect(&ir, &mut ids);
        let mut assets = Vec::new();
        let mut total = 0;
        for id in ids {
            anyhow::ensure!(
                id.len() <= 80 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'),
                "COURSEWARE_INVALID: invalid parsed asset ID"
            );
            let mut metadata = Vec::new();
            open_source(&output, &output.join(format!("assets/{id}.json")))?
                .file
                .take(4097)
                .read_to_end(&mut metadata)?;
            anyhow::ensure!(
                metadata.len() <= 4096,
                "COURSEWARE_INVALID: parsed asset metadata oversized"
            );
            let metadata: Value = serde_json::from_slice(&metadata)?;
            let ext = metadata["ext"].as_str().unwrap_or("");
            let mime = metadata["mimeType"].as_str().unwrap_or("");
            anyhow::ensure!(
                !ext.is_empty()
                    && ext.len() <= 12
                    && ext.bytes().all(|c| c.is_ascii_alphanumeric())
                    && (mime.starts_with("image/")
                        || mime.starts_with("audio/")
                        || mime.starts_with("video/")),
                "COURSEWARE_INVALID: invalid parsed asset metadata"
            );
            let path = output.join(format!("assets/{id}.{ext}"));
            let mut content = Vec::new();
            open_source(&output, &path)?
                .file
                .take(64 * 1024 * 1024 + 1)
                .read_to_end(&mut content)?;
            // The trusted importer names assets from their SHA-1 content checksum.
            let checksum = hex::encode(
                ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, &content).as_ref(),
            );
            anyhow::ensure!(
                metadata["checksum"] == checksum
                    && id
                        == format!(
                            "{}_{}",
                            metadata["assetType"].as_str().unwrap_or(""),
                            &checksum[..20]
                        ),
                "COURSEWARE_CONFLICT: parsed asset bytes changed"
            );
            total += content.len();
            anyhow::ensure!(
                total <= 128 * 1024 * 1024,
                "COURSEWARE_INVALID: parsed assets exceed limit"
            );
            assets.push(json!({"id":id,"path":path,"sha256":hex::encode(Sha256::digest(&content)),"mimeType":mime}));
        }
        Ok(json!({"ir":ir,"assets":assets,"sourcePath":job.input}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn source_refresh_checks_workspace_source_ir_and_imported_asset_bytes() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().canonicalize().unwrap();
        let input = workspace.join(".deckwise-ppt/revisions/document/r0001/source.pptx");
        std::fs::create_dir_all(input.parent().unwrap()).unwrap();
        let source = b"saved native source";
        std::fs::write(&input, source).unwrap();
        let directory = workspace.join("job");
        let output = directory.join("output");
        std::fs::create_dir_all(output.join("assets")).unwrap();
        let image = b"parsed image bytes";
        let checksum = hex::encode(
            ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, image).as_ref(),
        );
        let id = format!("image_{}", &checksum[..20]);
        let image_path = output.join(format!("assets/{id}.png"));
        std::fs::write(&image_path, image).unwrap();
        std::fs::write(output.join(format!("assets/{id}.json")),serde_json::to_vec(&json!({"assetType":"image","mimeType":"image/png","ext":"png","checksum":checksum})).unwrap()).unwrap();
        let ir = json!({"pages":[{"id":"page_1","elements":[{"id":"image","type":"image","src":format!("import-asset:local:{id}")}]}]});
        let bytes = serde_json::to_vec(&ir).unwrap();
        let ir_path = output.join("slide-ir.json");
        std::fs::write(&ir_path, &bytes).unwrap();
        let status = json!({"status":"SUCCEEDED","summary":{"sourceSha256":hex::encode(Sha256::digest(source)),"irSha256":hex::encode(Sha256::digest(&bytes)),"pages":1}});
        let task = tokio::spawn(async {});
        while !task.is_finished() {
            tokio::task::yield_now().await;
        }
        let (cancel, _rx) = watch::channel(false);
        let parser = Parser {
            job: Some(Job {
                id: "job".into(),
                portable_project: None,
                workspace: workspace.clone(),
                input: input.clone(),
                directory,
                state: Arc::new(Mutex::new(status)),
                cancel,
                task,
            }),
            ..Default::default()
        };
        let value = parser.classroom_source("job", &workspace).unwrap();
        assert_eq!(value["ir"], ir);
        assert_eq!(value["assets"][0]["id"], id);
        assert_eq!(
            value["assets"][0]["sha256"],
            hex::encode(Sha256::digest(image))
        );
        let foreign = tempfile::tempdir().unwrap();
        assert!(parser.classroom_source("job", foreign.path()).is_err());
        std::fs::write(&image_path, b"tampered image").unwrap();
        assert!(parser
            .classroom_source("job", &workspace)
            .unwrap_err()
            .to_string()
            .contains("parsed asset bytes changed"));
        std::fs::write(&image_path, image).unwrap();
        std::fs::write(&ir_path, b"{}").unwrap();
        assert!(parser.classroom_source("job", &workspace).is_err());
        std::fs::write(&ir_path, &bytes).unwrap();
        std::fs::write(&input, b"new native source").unwrap();
        assert!(parser.classroom_source("job", &workspace).is_err());
    }
}
