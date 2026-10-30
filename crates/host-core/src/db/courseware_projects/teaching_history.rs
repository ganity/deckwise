use super::*;
use crate::courseware::SavedProjectSeed;
use serde_json::json;

const PAGE_LIMIT: usize = 20;
const MAX_SKIPPED: usize = 1_000_000;

// A historical page is all-or-nothing: future/unsupported action kinds cannot
// silently become an incomplete teaching restoration.
fn projection(page: &CoursewarePage) -> Option<(Vec<Value>, usize, usize)> {
    let mut actions = Vec::new();
    let mut audio = 0;
    let mut cues = 0;
    for action in &page.actions {
        match action["type"].as_str()? {
            "audio_clip" => audio += 1,
            "delay" if valid_teaching_delay(action) => {
                actions.push(json!({"id":uuid::Uuid::new_v4().to_string(), "type":"delay", "durationMs":action["durationMs"]}));
            }
            "video_slot" if video::valid_slot(action) => {
                actions.push(json!({"id":uuid::Uuid::new_v4().to_string(), "type":"video_slot", "prompt":action["prompt"]}));
            }
            "video_clip" if video::valid_clip(action) => {
                // Archived video remains historical until its saved source can be rebound.
                return None;
            }
            "speech" => {
                let text = action["text"].as_str()?;
                if text.encode_utf16().count() > 32000 {
                    return None;
                }
                let mut projected =
                    json!({"id":uuid::Uuid::new_v4().to_string(), "type":"speech", "text":text});
                if let Some(source) = action.get("source") {
                    if !matches!(
                        source.as_str()?,
                        "notes" | "external" | "original" | "light_rewrite" | "generated"
                    ) {
                        return None;
                    }
                    projected["source"] = source.clone();
                }
                if let Some(pause) = action.get("pauseAfterMs") {
                    if pause.as_u64()? > 30000 {
                        return None;
                    }
                    projected["pauseAfterMs"] = pause.clone();
                }
                if let Some(asset) = action.get("audioAssetId") {
                    if !valid_id(asset.as_str()?) {
                        return None;
                    }
                    audio += 1;
                }
                if let Some(visual) = action.get("visualCues") {
                    let visual = visual.as_array()?;
                    if visual.len() > 200 {
                        return None;
                    }
                    cues += visual.len();
                }
                if let Some(intent) = action.get("attention") {
                    attention::targets(intent).ok()?;
                    cues += 1;
                }
                actions.push(projected);
            }
            "interaction_checkpoint" if valid_teaching_checkpoint(action) => {
                // A recovered question must be local to the deleted page, not stale cross-page context.
                if action["checkpointKind"] == "chapter_summary"
                    && action["context"]["sourceSceneIds"] != json!([page.page_id])
                {
                    return None;
                }
                let mut projected = action.clone();
                projected["id"] = json!(uuid::Uuid::new_v4().to_string());
                projected["checkpointId"] = json!(uuid::Uuid::new_v4().to_string());
                actions.push(projected);
            }
            _ => return None,
        }
    }
    (!actions.is_empty()).then_some((actions, audio, cues))
}

impl Database {
    /// Read only deleted logical pages from this exact project's saved history.
    /// Audio and object bindings remain historical and are never rebound here.
    pub fn list_courseware_teaching_history(
        &self,
        workspace: &str,
        seed: &SavedProjectSeed,
    ) -> Result<Value> {
        let key = storage_key(workspace, &seed.project_id)?;
        let tx = self.conn.unchecked_transaction()?;
        let current = self
            .get_courseware_project(workspace, &seed.project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        anyhow::ensure!(
            current.source.sha256 == seed.sha256 && current.pages.len() == seed.pages,
            "COURSEWARE_CONFLICT: saved source no longer matches current teaching"
        );
        let prefix = format!("[{},", serde_json::to_string(&key)?);
        let upper = format!("{prefix}~");
        let mut cursor: Option<(i64, String)> = None;
        let mut entries = Vec::new();
        let mut skipped = 0;
        let mut response_bytes = 64;
        'history: loop {
            // (ns,key) is indexed. Restrict before loading any history value;
            // keyset batches also bound memory when this project has many edits.
            let rows = {
                let mut stmt = self.conn.prepare_cached(
                    "SELECT key,value_json,updated_at FROM kv WHERE ns=?1 AND key>=?2 AND key<?3
                     AND (?4 IS NULL OR updated_at<?4 OR (updated_at=?4 AND key<?5))
                     ORDER BY updated_at DESC,key DESC LIMIT 20",
                )?;
                let rows = stmt.query_map(
                    params![
                        HISTORY_NAMESPACE,
                        prefix,
                        upper,
                        cursor.as_ref().map(|v| v.0),
                        cursor.as_ref().map(|v| &v.1)
                    ],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            if rows.is_empty() {
                break;
            }
            for (history_key, raw, updated_at) in rows {
                cursor = Some((updated_at, history_key.clone()));
                let invalid = || anyhow!("COURSEWARE_INVALID: invalid stored teaching history");
                anyhow::ensure!(
                    raw.len() <= MAX_BYTES,
                    "COURSEWARE_INVALID: oversized teaching history"
                );
                let (stored_key, revision): (String, String) =
                    serde_json::from_str(&history_key).map_err(|_| invalid())?;
                let project: CoursewareProject =
                    serde_json::from_str(&raw).map_err(|_| invalid())?;
                project.validate().map_err(|_| invalid())?;
                anyhow::ensure!(
                    stored_key == key
                        && project.project_id == seed.project_id
                        && project.teaching_revision == revision,
                    "COURSEWARE_INVALID: teaching history identity mismatch"
                );
                for (index, page) in project.pages.iter().enumerate() {
                    if current.pages.iter().any(|p| p.page_id == page.page_id) {
                        continue;
                    }
                    let Some((actions, omitted_audio, omitted_cues)) = projection(page) else {
                        skipped += 1;
                        anyhow::ensure!(
                            skipped <= MAX_SKIPPED,
                            "COURSEWARE_INVALID: teaching history exceeds recovery limit"
                        );
                        continue;
                    };
                    let entry = json!({"teachingRevision":project.teaching_revision, "sourceRevision":project.source.revision,
                        "pageId":page.page_id, "pageNumber":index+1, "actions":actions,
                        "omittedAudioCount":omitted_audio, "omittedCueCount":omitted_cues});
                    let bytes = serde_json::to_vec(&entry)?.len() + 1;
                    if response_bytes + bytes > MAX_BYTES {
                        skipped += 1;
                        anyhow::ensure!(
                            skipped <= MAX_SKIPPED,
                            "COURSEWARE_INVALID: teaching history exceeds recovery limit"
                        );
                        continue;
                    }
                    response_bytes += bytes;
                    entries.push(entry);
                    if entries.len() == PAGE_LIMIT {
                        break 'history;
                    }
                }
            }
        }
        tx.commit()?;
        Ok(json!({"entries":entries,"skippedEntryCount":skipped}))
    }
}

#[cfg(test)]
mod tests;
