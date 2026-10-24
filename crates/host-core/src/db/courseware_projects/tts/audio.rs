//! Private decoded-audio receipts; explicit adoption is an atomic teaching CAS.
use super::*;
use crate::db::courseware_projects::snapshots::Asset;

const AUDIO: &str = "coursewareTtsAudio.v1";
pub const MAX_AUDIO_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Audio {
    pub task_ref: TaskRef,
    pub sha256: String,
    pub mime_type: String,
    pub byte_length: u64,
    /// Main must supply actual decoder output, never the server's optional duration.
    pub duration_ms: u64,
}

impl Audio {
    pub fn validate(&self) -> Result<()> {
        anyhow::ensure!(
            valid_hash(&self.sha256)
                && matches!(self.mime_type.as_str(), "audio/wav" | "audio/mpeg")
                && (1..=MAX_AUDIO_BYTES).contains(&self.byte_length)
                && (1..=86_400_000).contains(&self.duration_ms),
            "COURSEWARE_INVALID: invalid decoded TTS audio"
        );
        Ok(())
    }

    pub fn asset(&self) -> Asset {
        Asset {
            id: format!("tts-{}", self.sha256),
            sha256: self.sha256.clone(),
            mime_type: self.mime_type.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub audio: Audio,
    pub adopted_teaching_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bound_source: Option<CoursewareSource>,
}

impl Record {
    pub fn matches_source(&self, intent: &Intent, source: &CoursewareSource) -> bool {
        self.bound_source.as_ref().map_or_else(
            || {
                intent.selection.expected_source_revision == source.revision
                    && intent.source_sha256 == source.sha256
            },
            |bound| bound.revision == source.revision && bound.sha256 == source.sha256,
        )
    }
}

impl Database {
    pub fn get_courseware_tts_audio(
        &self,
        workspace: &str,
        project_id: &str,
        principal_key: &str,
        intent_id: &str,
    ) -> Result<Record> {
        let intent = self.tts_intent(workspace, project_id, principal_key, intent_id)?;
        let value = self
            .kv_get(
                AUDIO,
                &key(workspace, project_id, principal_key, intent_id)?,
            )?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: TTS audio not found"))?;
        let record: Record = serde_json::from_value(value)?;
        record.audio.validate()?;
        anyhow::ensure!(
            intent.task_ref.as_ref() == Some(&record.audio.task_ref)
                && record
                    .adopted_teaching_revision
                    .as_ref()
                    .is_none_or(|revision| valid_id(revision))
                && record.bound_source.as_ref().is_none_or(|source| {
                    record.adopted_teaching_revision.is_some()
                        && valid_id(&source.revision)
                        && valid_hash(&source.sha256)
                }),
            "COURSEWARE_INVALID: TTS audio receipt differs from intent"
        );
        Ok(record)
    }

    pub fn stage_courseware_tts_audio(
        &self,
        workspace: &str,
        project_id: &str,
        principal_key: &str,
        intent_id: &str,
        audio: Audio,
    ) -> Result<Record> {
        audio.validate()?;
        let tx = self.conn.unchecked_transaction()?;
        let intent = self.tts_intent(workspace, project_id, principal_key, intent_id)?;
        anyhow::ensure!(
            intent.task_ref.as_ref() == Some(&audio.task_ref),
            "COURSEWARE_CONFLICT: audio task differs from retained TTS task"
        );
        let key = key(workspace, project_id, principal_key, intent_id)?;
        let record = if self.kv_get(AUDIO, &key)?.is_some() {
            let saved =
                self.get_courseware_tts_audio(workspace, project_id, principal_key, intent_id)?;
            anyhow::ensure!(
                serde_json::to_value(&saved.audio)? == serde_json::to_value(&audio)?,
                "COURSEWARE_CONFLICT: task already has different audio"
            );
            saved
        } else {
            let record = Record {
                audio,
                adopted_teaching_revision: None,
                bound_source: None,
            };
            let value = serde_json::to_value(&record)?;
            let inserted = self.conn.execute(
                "INSERT INTO kv(ns,key,value_json,updated_at) VALUES(?1,?2,?3,?4)",
                params![AUDIO, key, serde_json::to_string(&record)?, now_ms()],
            )?;
            anyhow::ensure!(
                inserted == 1 && self.kv_get(AUDIO, &key)? == Some(value),
                "COURSEWARE_CONFLICT: TTS audio was not saved"
            );
            record
        };
        tx.commit()?;
        self.source_adoption_barrier()?;
        Ok(record)
    }

    pub fn adopt_courseware_tts_audio(
        &self,
        workspace: &str,
        project_id: &str,
        principal_key: &str,
        intent_id: &str,
        expected_teaching_revision: &str,
        expected_audio_asset_id: Option<&str>,
    ) -> Result<CoursewareProject> {
        let tx = self.conn.unchecked_transaction()?;
        self.ensure_no_source_adoption(workspace)?;
        let intent = self.tts_intent(workspace, project_id, principal_key, intent_id)?;
        let mut record =
            self.get_courseware_tts_audio(workspace, project_id, principal_key, intent_id)?;
        let project = self
            .get_courseware_project(workspace, project_id)?
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: project not found"))?;
        let page = project
            .pages
            .iter()
            .find(|page| page.page_id == intent.selection.page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_PAGE_NOT_FOUND: logical page not found"))?;
        let action = page
            .actions
            .iter()
            .find(|action| action["id"] == intent.selection.action_id)
            .ok_or_else(|| anyhow!("COURSEWARE_NOT_FOUND: speech action not found"))?;
        anyhow::ensure!(
            record.matches_source(&intent, &project.source)
                && action["type"] == "speech"
                && action["text"] == intent.request.input,
            "COURSEWARE_CONFLICT: TTS source or speech changed"
        );
        let asset_id = record.audio.asset().id;
        // A lost adoption response can be read again without changing the project a second time.
        if record.adopted_teaching_revision.is_some() {
            anyhow::ensure!(
                action["audioAssetId"] == asset_id,
                "COURSEWARE_CONFLICT: adopted audio was replaced"
            );
            tx.commit()?;
            self.source_adoption_barrier()?;
            return Ok(project);
        }
        anyhow::ensure!(
            !page.locked,
            "COURSEWARE_LOCKED: unlock the page before attaching audio"
        );
        anyhow::ensure!(
            project.teaching_revision == expected_teaching_revision
                && action.get("audioAssetId").is_none_or(Value::is_string)
                && action["audioAssetId"].as_str() == expected_audio_asset_id,
            "COURSEWARE_CONFLICT: teaching or previous audio changed"
        );
        anyhow::ensure!(
            ["audioId", "audioUrl", "audioData"]
                .iter()
                .all(|field| action.get(field).is_none()),
            "COURSEWARE_INVALID: legacy speech audio needs explicit migration"
        );
        let mut actions = page.actions.clone();
        actions
            .iter_mut()
            .find(|action| action["id"] == intent.selection.action_id)
            .unwrap()["audioAssetId"] = Value::String(asset_id);
        let saved = self.write_courseware_teaching(
            workspace,
            &TeachingWrite {
                project_id: project_id.into(),
                page_id: intent.selection.page_id.clone(),
                expected_source_revision: project.source.revision.clone(),
                expected_teaching_revision: expected_teaching_revision.into(),
                actions,
            },
        )?;
        record.adopted_teaching_revision = Some(saved.teaching_revision.clone());
        let key = key(workspace, project_id, principal_key, intent_id)?;
        let changed = self.conn.execute(
            "UPDATE kv SET value_json=?1,updated_at=?2 WHERE ns=?3 AND key=?4",
            params![serde_json::to_string(&record)?, now_ms(), AUDIO, key],
        )?;
        anyhow::ensure!(
            changed == 1
                && self.kv_get(AUDIO, &key)? == Some(serde_json::to_value(&record)?)
                && serde_json::to_value(self.get_courseware_project(workspace, project_id)?)?
                    == serde_json::to_value(Some(&saved))?,
            "COURSEWARE_CONFLICT: audio adoption was not saved"
        );
        tx.commit()?;
        self.source_adoption_barrier()?;
        Ok(saved)
    }

    pub(in crate::db) fn validate_courseware_review_audio(
        &self,
        workspace: &str,
        previous: &CoursewareProject,
        next: &CoursewareProject,
    ) -> Result<()> {
        self.review_audio(workspace, previous, next, false)
    }

    /// Called only inside an explicit source-change transaction; paid intents stay immutable.
    pub(in crate::db) fn rebind_courseware_review_audio(
        &self,
        workspace: &str,
        previous: &CoursewareProject,
        next: &CoursewareProject,
    ) -> Result<()> {
        self.review_audio(workspace, previous, next, true)
    }

    fn review_audio(
        &self,
        workspace: &str,
        previous: &CoursewareProject,
        next: &CoursewareProject,
        rebind: bool,
    ) -> Result<()> {
        anyhow::ensure!(
            !self.conn.is_autocommit(),
            "COURSEWARE_INVALID: audio rebinding requires source-review transaction"
        );
        self.review_courseware_music(workspace, previous, next, rebind)?;
        if !next
            .pages
            .iter()
            .flat_map(|page| &page.actions)
            .any(|action| action.get("audioAssetId").is_some())
        {
            return Ok(());
        }
        let scope = storage_key(workspace, &previous.project_id)?;
        let prefix = format!("[{},", serde_json::to_string(&scope)?);
        let mut statement = self.conn.prepare("SELECT key,value_json FROM kv WHERE ns=?1 AND substr(key,1,length(?2))=?2 ORDER BY key LIMIT 1001")?;
        let records = statement
            .query_map(params![AUDIO, prefix], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        anyhow::ensure!(
            records.len() <= MAX_INTENTS,
            "COURSEWARE_INVALID: too many audio receipts for source review"
        );
        let mut matched = std::collections::HashSet::new();
        for (key, original) in records {
            let (saved_scope, principal, intent_id): (String, String, String) =
                serde_json::from_str(&key)?;
            anyhow::ensure!(
                saved_scope == scope,
                "COURSEWARE_INVALID: audio receipt scope differs"
            );
            let intent =
                self.tts_intent(workspace, &previous.project_id, &principal, &intent_id)?;
            let mut record = self.get_courseware_tts_audio(
                workspace,
                &previous.project_id,
                &principal,
                &intent_id,
            )?;
            let asset_id = record.audio.asset().id;
            let matches = |project: &CoursewareProject| {
                project.pages.iter().any(|page| {
                    page.page_id == intent.selection.page_id
                        && page.actions.iter().any(|action| {
                            action["id"] == intent.selection.action_id
                                && action["type"] == "speech"
                                && action["text"] == intent.request.input
                                && action["audioAssetId"] == asset_id
                        })
                })
            };
            if record.adopted_teaching_revision.is_none()
                || !record.matches_source(&intent, &previous.source)
                || !matches(previous)
                || !matches(next)
            {
                continue;
            }
            if rebind {
                record.bound_source = Some(next.source.clone());
                let changed = self.conn.execute(
                    "UPDATE kv SET value_json=?1,updated_at=?2 WHERE ns=?3 AND key=?4 AND value_json=?5",
                    params![serde_json::to_string(&record)?, now_ms(), AUDIO, key, original],
                )?;
                anyhow::ensure!(
                    changed == 1
                        && self.kv_get(AUDIO, &key)? == Some(serde_json::to_value(&record)?),
                    "COURSEWARE_CONFLICT: source audio binding was not saved"
                );
            }
            matched.insert((
                intent.selection.page_id,
                intent.selection.action_id,
                asset_id,
            ));
        }
        for page in &next.pages {
            for action in &page.actions {
                if let Some(asset) = action.get("audioAssetId").filter(|_| action["type"] == "speech") {
                    anyhow::ensure!(matched.contains(&(page.page_id.clone(), action["id"].as_str().unwrap_or_default().into(), asset.as_str().unwrap_or_default().into())),
                        "COURSEWARE_AUDIO_REQUIRED: source review requires a matching previously adopted audio receipt");
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
