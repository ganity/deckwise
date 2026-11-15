use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PageTextParams {
    pub(super) session_id: String,
    pub(super) job_id: String,
    pub(super) page_number: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct GetParams {
    pub(super) session_id: String,
    pub(super) project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskSetParams {
    pub(super) session_id: String,
    pub(super) task_type: String,
    #[serde(default)]
    pub(super) story_first: bool,
    #[serde(default)]
    pub(super) education_context:
        Option<crate::db::courseware_projects::CoursewareEducationContext>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskGetParams {
    pub(super) session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskEducationParams {
    pub(super) session_id: String,
    pub(super) expected_education_context:
        crate::db::courseware_projects::CoursewareEducationContext,
    pub(super) education_context: crate::db::courseware_projects::CoursewareEducationContext,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskBindTeamParams {
    pub(super) session_id: String,
    pub(super) team_project_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskAttachImportParams {
    pub(super) session_id: String,
    pub(super) path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct TaskAttachGeneratedParams {
    pub(super) session_id: String,
    pub(super) path: String,
    pub(super) project_id: String,
    pub(super) source_sha256: String,
    #[serde(default)]
    pub(super) scene_proof: Option<scene_images::GenerationProof>,
}

pub(super) const TASK_NAMESPACE: &str = "coursewareTask.v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OpenSavedParams {
    pub(super) session_id: String,
    pub(super) job_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InitializeGeneratedParams {
    pub(super) session_id: String,
    pub(super) job_id: String,
    pub(super) source_sha256: String,
    pub(super) title: String,
    pub(super) narrations: Vec<String>,
    #[serde(default)]
    pub(super) scene_proof: Option<scene_images::GenerationProof>,
    #[serde(default)]
    pub(super) scene_mapping:
        Option<crate::db::courseware_projects::scene_objects::GeneratedSceneMapping>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AdoptReviewParams {
    pub(super) session_id: String,
    pub(super) job_id: String,
    pub(super) review_id: String,
    pub(super) bindings: Vec<Option<String>>,
    #[serde(default)]
    pub(super) effect_bindings: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct WriteParams {
    pub(super) session_id: String,
    pub(super) write: TeachingWrite,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct LockParams {
    pub(super) session_id: String,
    pub(super) project_id: String,
    pub(super) page_id: String,
    pub(super) expected_source_revision: String,
    pub(super) expected_teaching_revision: String,
    pub(super) locked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ConfirmParams {
    pub(super) session_id: String,
    pub(super) project_id: String,
    pub(super) page_id: String,
    pub(super) expected_source_revision: String,
    pub(super) expected_teaching_revision: String,
    #[serde(default)]
    pub(super) resolution: Option<crate::db::courseware_projects::chat_changes::ResolutionRequest>,
}
