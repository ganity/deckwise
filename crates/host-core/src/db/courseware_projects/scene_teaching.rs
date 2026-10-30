use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Teaching {
    pub page_type: String,
    pub phase: String,
    pub objective: String,
    pub duration_seconds: u64,
    pub required_objects: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present_option")]
    pub question: Option<Question>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present_option")]
    pub music: Option<Music>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Question { pub text: String, pub response: question::Response }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Music { pub purpose: String, pub prompt: String }
impl Teaching {
    pub fn valid(&self) -> bool {
        let text = |s: &str, n| !s.trim().is_empty() && s.encode_utf16().count() <= n;
        matches!(self.page_type.as_str(), "slide" | "quiz" | "interactive" | "pbl")
            && matches!(self.phase.as_str(), "opening" | "explore" | "practice" | "review")
            && text(&self.objective, 1000) && (5..=1800).contains(&self.duration_seconds)
            && self.required_objects.len() <= 30
            && self.required_objects.iter().all(|s| text(s, 200))
            && self.required_objects.iter().collect::<std::collections::HashSet<_>>().len() == self.required_objects.len()
            && (self.page_type == "slide" || self.question.is_some())
            && self.question.as_ref().is_none_or(|q| text(&q.text, 160) && q.response.valid())
            && self.music.as_ref().is_none_or(|m| text(&m.purpose, 500) && text(&m.prompt, 4000))
    }
}
