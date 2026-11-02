use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub kind: String,
    pub options: Vec<String>,
    pub answer_indices: Vec<usize>,
}
impl Response {
    pub fn valid(&self) -> bool {
        if self.options.len() > 8 || self.options.iter().any(|o| o.trim().is_empty() || o.encode_utf16().count() > 500)
            || self.options.iter().collect::<HashSet<_>>().len() != self.options.len()
            || self.answer_indices.iter().collect::<HashSet<_>>().len() != self.answer_indices.len()
            || self.answer_indices.iter().any(|i| *i >= self.options.len()) { return false; }
        match self.kind.as_str() {
            "single" => self.options.len() >= 2 && self.answer_indices.len() == 1,
            "judge" => self.options.len() == 2 && self.answer_indices.len() == 1,
            "multiple" => self.options.len() >= 2 && !self.answer_indices.is_empty(),
            "short_answer" | "discussion" | "practice" | "pbl" => self.options.is_empty() && self.answer_indices.is_empty(),
            _ => false,
        }
    }
}
pub fn valid(value: &serde_json::Value) -> bool {
    serde_json::from_value::<Response>(value.clone()).is_ok_and(|v| v.valid())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn question_types_keep_bounded_answer_keys_without_trusting_model_grades() {
        for kind in ["single", "multiple", "judge", "short_answer", "discussion", "practice", "pbl"] {
            let choice = ["single", "multiple", "judge"].contains(&kind);
            let mut value = json!({"kind":kind,"options":if choice {vec!["Hello","Bye"]} else {vec![]},"answerIndices":if choice {vec![0]} else {vec![]}});
            assert!(valid(&value), "{kind}");
            value["answerIndices"] = json!([8]); assert!(!valid(&value));
            value["answerIndices"] = json!([]); value["options"] = json!(["Same","Same"]); assert!(!valid(&value));
            value["graded"] = json!(true); assert!(!valid(&value));
        }
    }
}
