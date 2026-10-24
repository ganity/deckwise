use super::*;
use sha2::{Digest, Sha256};
use std::io::Read;

impl Parser {
    pub fn narration_page_text(&self, id: &str, workspace: &Path, page: usize) -> Result<String> {
        page_text(&self.narration_page_ir(id, workspace, page)?)
    }

    pub fn narration_page_notes(&self, id: &str, workspace: &Path, page: usize) -> Result<String> {
        let ir = self.narration_page_ir(id, workspace, page)?;
        let notes = ir["notes"].as_str().ok_or_else(|| anyhow!("COURSEWARE_NOTES_EMPTY: page has no speaker notes"))?;
        page_notes(notes)
    }

    fn narration_page_ir(&self, id: &str, workspace: &Path, page: usize) -> Result<Value> {
        let seed = self.saved_project_seed(id, workspace)?;
        if page == 0 || page > seed.pages {
            bail!("COURSEWARE_INVALID: invalid current page");
        }
        let job = self.get(id)?;
        let output = job.directory.join("output");
        let source = open_source(&output, &output.join("slide-ir.json"))?;
        let mut bytes = Vec::new();
        source
            .file
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        let status = self.status(id)?;
        if bytes.len() > 64 * 1024 * 1024
            || status["summary"]["irSha256"] != hex::encode(Sha256::digest(&bytes))
        {
            bail!("COURSEWARE_CONFLICT: parsed page content changed");
        }
        let ir: Value = serde_json::from_slice(&bytes)?;
        let target = ir["pages"]
            .as_array()
            .and_then(|pages| pages.get(page - 1))
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: missing page"))?;
        Ok(target.clone())
    }
}

fn page_notes(html: &str) -> Result<String> {
    let breaks = regex::Regex::new(r"(?i)<br\s*/?>|</p\s*>|</div\s*>")?;
    let tags = regex::Regex::new(r"<[^>]*>")?;
    let entities = regex::Regex::new(r"&(?:amp|lt|gt|quot|apos|nbsp|#(?:x[0-9a-fA-F]+|[0-9]+));")?;
    let lines = breaks.replace_all(html, "\n");
    let plain = tags.replace_all(&lines, "");
    let text = entities.replace_all(&plain, |captures: &regex::Captures<'_>| {
        match &captures[0][1..captures[0].len() - 1] {
            "amp" => "&".to_string(), "lt" => "<".to_string(), "gt" => ">".to_string(),
            "quot" => "\"".to_string(), "apos" => "'".to_string(), "nbsp" => " ".to_string(),
            number if number.starts_with("#x") => u32::from_str_radix(&number[2..], 16).ok().and_then(char::from_u32).map(|c| c.to_string()).unwrap_or_default(),
            number => number[1..].parse::<u32>().ok().and_then(char::from_u32).map(|c| c.to_string()).unwrap_or_default(),
        }
    });
    let text = text.lines().map(str::trim).filter(|line| !line.is_empty()).collect::<Vec<_>>().join("\n");
    if text.is_empty() { bail!("COURSEWARE_NOTES_EMPTY: page has no speaker notes"); }
    if text.encode_utf16().count() > 2500 || text.contains('&') && regex::Regex::new(r"&[A-Za-z#][A-Za-z0-9#]*;")?.is_match(&text) {
        bail!("COURSEWARE_INVALID: page notes are too long or contain unsupported entities");
    }
    Ok(text)
}

// Keep text and table cells only; never send asset URLs, notes, other pages or paths.
fn page_text(page: &Value) -> Result<String> {
    fn collect(
        value: &Value,
        output: &mut Vec<String>,
        remaining: &mut usize,
        depth: usize,
    ) -> Result<()> {
        if depth > 32 {
            bail!("COURSEWARE_INVALID: page content is too deeply nested");
        }
        match value {
            Value::Object(fields) => {
                for (key, value) in fields {
                    if ["content", "text"].contains(&key.as_str()) {
                        if let Some(text) = value.as_str() {
                            let size = text.encode_utf16().count() + 1;
                            if size > *remaining {
                                bail!("COURSEWARE_INVALID: page text exceeds narration limit");
                            }
                            *remaining -= size;
                            output.push(text.to_owned());
                        }
                    } else if ["elements", "data", "cells", "rows"].contains(&key.as_str()) {
                        collect(value, output, remaining, depth + 1)?;
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    collect(item, output, remaining, depth + 1)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut parts = Vec::new();
    collect(page, &mut parts, &mut 32000, 0)?;
    let text = parts.join("\n");
    if text.trim().is_empty() {
        bail!("COURSEWARE_INVALID: this page has no supported source text; image/video understanding is not mounted");
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_is_page_local_bounded_and_excludes_notes_and_assets() {
        let page = json!({"notes":"private", "elements":[{"type":"shape","content":"<p>Hello</p>","src":"secret"},{"type":"table","data":[[{"text":"Cell"}]]}]});
        assert_eq!(page_text(&page).unwrap(), "<p>Hello</p>\nCell");
        assert!(page_text(&json!({"elements":[{"content":"x".repeat(32001)}]})).is_err());
        assert!(page_text(&json!({"elements":[{"src":"image"}]})).is_err());
    }

    #[test]
    fn page_notes_become_bounded_editable_text() {
        assert_eq!(page_notes("<p>Good &amp; kind</p><p>Great job!<br/>继续。</p>").unwrap(), "Good & kind\nGreat job!\n继续。");
        assert!(page_notes("<p></p>").is_err());
        assert!(page_notes(&format!("<p>{}</p>", "x".repeat(2501))).is_err());
    }
}
