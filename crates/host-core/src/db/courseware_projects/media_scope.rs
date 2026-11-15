use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmissionScope {
    pub session_id: String,
    #[serde(deserialize_with = "required_team_project")]
    pub team_project_id: Option<String>,
}

fn required_team_project<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

impl SubmissionScope {
    pub fn valid(&self) -> bool {
        valid_id(&self.session_id)
            && self.session_id != "."
            && self.session_id != ".."
            && self
                .team_project_id
                .as_ref()
                .is_none_or(|id| uuid::Uuid::parse_str(id).is_ok())
    }
}

impl Database {
    // The caller holds the same Host state lock as task binding until begin is durable.
    pub fn courseware_media_submission_scope(&self, session_id: &str) -> Result<SubmissionScope> {
        let task = self.kv_get("coursewareTask.v1", session_id)?;
        anyhow::ensure!(
            task.as_ref().is_none_or(Value::is_object),
            "COURSEWARE_INVALID: invalid stored courseware task"
        );
        let team_project_id = task
            .as_ref()
            .and_then(|task| task.get("teamProjectId"))
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow!("COURSEWARE_INVALID: invalid stored team project"))
            })
            .transpose()?;
        let scope = SubmissionScope {
            session_id: session_id.into(),
            team_project_id,
        };
        anyhow::ensure!(scope.valid(), "COURSEWARE_INVALID: invalid media scope");
        Ok(scope)
    }
}
