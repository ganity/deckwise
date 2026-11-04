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
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_option"
    )]
    pub video: Option<Music>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Question {
    pub text: String,
    pub response: question::Response,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present_option")]
    pub reference_answer: Option<ReferenceAnswer>,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "present_option")]
    pub constraint_prompt: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReferenceAnswer { pub summary: String, pub key_points: Vec<String> }
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
            && (matches!(self.page_type.as_str(), "slide" | "quiz") || self.question.is_some())
            && self
                .question
                .as_ref()
                .is_none_or(|q| text(&q.text, 160) && q.response.valid()
                    && q.reference_answer.as_ref().is_none_or(|r| text(&r.summary, 4000) && r.key_points.len() <= 20 && r.key_points.iter().all(|p| text(p, 500)))
                    && q.constraint_prompt.as_ref().is_none_or(|p| text(p, 4000)))
            && self
                .music
                .as_ref()
                .is_none_or(|m| text(&m.purpose, 500) && text(&m.prompt, 4000))
            && self
                .video
                .as_ref()
                .is_none_or(|m| text(&m.purpose, 500) && text(&m.prompt, 4000))
    }
}

pub(super) fn question_matches(action: &Value, expected: &Value) -> bool {
    action["question"]
        .as_str()
        .zip(expected["text"].as_str())
        .is_some_and(|(a, b)| a.trim() == b.trim())
        && !expected["response"].is_null()
        && action["response"] == expected["response"]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn approved_question_contract_matches_shared_fixtures() {
        let cases: Value = serde_json::from_str(include_str!("../../../../../packages/shared/src/courseware-scene-teaching.fixtures/requirements.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                question_matches(&case["action"], &case["expected"]),
                case["matches"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        let legacy = json!({"pageType":"slide","phase":"opening","objective":"Greet","durationSeconds":30,"requiredObjects":[]});
        let parsed: Teaching = serde_json::from_value(legacy.clone()).unwrap();
        assert!(parsed.valid());
        assert_eq!(serde_json::to_value(&parsed).unwrap(), legacy);
        let mut video = legacy.clone();
        video["video"] = json!({"purpose":"Show a wave","prompt":"A five-second silent wave"});
        assert!(serde_json::from_value::<Teaching>(video).unwrap().valid());
    }
}
