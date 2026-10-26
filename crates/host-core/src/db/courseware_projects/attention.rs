//! Speech-scoped focus intent. Decoded audio, never model timing, supplies its interval.
use super::*;
use serde_json::json;

pub(super) fn targets(value: &Value) -> Result<Vec<String>> {
    let ids = value["objectIds"].as_array();
    anyhow::ensure!(
        value.as_object().is_some_and(|fields| fields.len() == 2)
            && matches!(value["type"].as_str(), Some("highlight" | "spotlight"))
            && ids.is_some_and(|ids| (1..=8).contains(&ids.len())),
        "COURSEWARE_INVALID: invalid speech attention"
    );
    let mut unique = std::collections::HashSet::new();
    ids.unwrap()
        .iter()
        .map(|id| {
            let id = id.as_str().unwrap_or_default();
            anyhow::ensure!(
                !id.is_empty() && id.encode_utf16().count() <= 200 && unique.insert(id),
                "COURSEWARE_INVALID: invalid or duplicate attention target"
            );
            Ok(id.to_owned())
        })
        .collect()
}

pub(super) fn cue(value: &Value, action_id: &str, duration_ms: u64) -> Result<Value> {
    let ids = targets(value)?;
    anyhow::ensure!(
        (1..=3_600_000).contains(&duration_ms),
        "COURSEWARE_INVALID: attention audio exceeds timing limit"
    );
    let effect = if value["type"] == "highlight" {
        json!({"type":"highlight","elementIds":ids})
    } else {
        json!({"type":"spotlight","elementId":ids[0],"elementIds":ids[1..]})
    };
    Ok(json!({"id":format!("focus-{action_id}"),"atMs":0,"endMs":duration_ms,"effect":effect}))
}

impl Database {
    pub(super) fn validate_narration_attention(
        &self,
        workspace: &str,
        project: &CoursewareProject,
        page_id: &str,
        actions: &[Value],
    ) -> Result<()> {
        let targets = actions
            .iter()
            .filter_map(|a| a.get("attention"))
            .map(targets)
            .collect::<Result<Vec<_>>>()?;
        if targets.is_empty() {
            return Ok(());
        }
        let mapping = self.courseware_mapping(workspace, project)?;
        let identity = self
            .kv_get(
                identities::IDENTITY_NAMESPACE,
                &identities::identity_key(workspace, &project.project_id, &project.source.sha256)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: attention identity missing"))?;
        let page = mapping["pages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["pageId"] == page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: attention page mapping is missing"))?;
        anyhow::ensure!(
            targets.iter().flatten().all(|id| page["objects"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|o| o["objectId"] == *id)),
            "COURSEWARE_INVALID: unknown or cross-page attention target"
        );
        let identity_page = identity["pages"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["logicalId"] == page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: attention identity page missing"))?;
        anyhow::ensure!(
            targets.iter().flatten().all(|id| identity_page["objects"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|o| o["logicalId"] == *id
                    && matches!(o["type"].as_str(), Some("text" | "shape" | "image")))),
            "COURSEWARE_INVALID: unsupported attention object kind"
        );
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timing_uses_decoded_speech_and_rejects_unbounded_intents() {
        let intent = json!({"type":"spotlight","objectIds":["one","two"]});
        assert_eq!(
            cue(&intent, "speech", 2345).unwrap(),
            json!({"id":"focus-speech","atMs":0,"endMs":2345,"effect":{"type":"spotlight","elementId":"one","elementIds":["two"]}})
        );
        assert!(targets(&json!({"type":"laser","objectIds":["one"]})).is_err());
        assert!(targets(&json!({"type":"highlight","objectIds":["one","one"]})).is_err());
        assert!(cue(&intent, "speech", 0).is_err());
    }
}
