//! Speech-scoped focus intent. Decoded audio, never model timing, supplies its interval.
use super::*;
use serde_json::json;

pub(super) fn targets(value: &Value) -> Result<Vec<String>> {
    let ids = value["objectIds"].as_array();
    anyhow::ensure!(
        value
            .as_object()
            .is_some_and(|fields| fields
                .keys()
                .all(|key| ["type", "objectIds", "animation"].contains(&key.as_str())))
            && matches!(value["type"].as_str(), Some("highlight" | "spotlight"))
            && value.get("animation").is_none_or(|effect| matches!(
                effect.as_str(),
                Some(
                    "fadeIn"
                        | "fadeOut"
                        | "pulse"
                        | "zoomIn"
                        | "slideInLeft"
                        | "slideInRight"
                        | "gentleRotate"
                )
            ))
            && ids.is_some_and(|ids| (1..=200).contains(&ids.len())),
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

pub(super) fn cues(value: &Value, action_id: &str, duration_ms: u64) -> Result<Vec<Value>> {
    let mut focus = cue(value, action_id, duration_ms)?;
    let mut cues = Vec::new();
    if let Some(effect) = value.get("animation") {
        let end = if duration_ms <= 600 && effect != "fadeOut" {
            (duration_ms / 2).max(1)
        } else {
            duration_ms.min(600)
        };
        let exit = effect == "fadeOut";
        let at = if exit { duration_ms } else { 0 };
        anyhow::ensure!(
            at + end <= 3_600_000,
            "COURSEWARE_INVALID: animation exceeds the supported timeline"
        );
        for (index, id) in targets(value)?.iter().enumerate() {
            cues.push(
                json!({"id":format!("motion-{action_id}-{index}"),"atMs":at,"endMs":at+end,
                "trigger":{"version":1,"kind":if exit { "end" } else { "start" }},
                "effect":{"type":"element_animation","elementId":id,"effect":effect}}),
            );
        }
        // The native motion owns its interval, even on a one-millisecond clip.
        if !exit {
            if end == duration_ms {
                return Ok(cues);
            }
            focus["atMs"] = json!(end);
        }
    }
    cues.push(focus);
    Ok(cues)
}

/// Retained speech can already have a timed focus when an agent adds another intent.
pub(super) fn sequence_focus(cues: Vec<Value>) -> Result<Vec<Value>> {
    let times: Vec<_> = cues
        .iter()
        .map(|c| match (c["atMs"].as_u64(), c["endMs"].as_u64()) {
            (Some(a), Some(b)) if a < b && b <= 3_600_000 => Ok((a, b)),
            _ => Err(anyhow!("COURSEWARE_INVALID: invalid saved focus timing")),
        })
        .collect::<Result<_>>()?;
    let rank = |c: &Value| match c["effect"]["type"].as_str() {
        Some("element_animation") if c.get("nativeAnimation").is_some() => 0,
        Some("element_animation")
            if matches!(
                c["effect"]["effect"].as_str(),
                Some("pulse" | "gentleRotate")
            ) =>
        {
            2
        }
        Some("element_animation") => 1,
        Some("spotlight") => 3,
        _ => 4,
    };
    let mut order: Vec<_> = (0..cues.len()).collect();
    order.sort_by_key(|&i| rank(&cues[i]));
    let mut kept: Vec<(usize, u64, u64)> = Vec::new();
    for i in order {
        let (a, b) = times[i];
        let effect = &cues[i]["effect"];
        let mut occupied: Vec<_> = kept
            .iter()
            .copied()
            .filter(|&(_, x, y)| x < b && a < y)
            .collect();
        if effect["type"] == "element_animation" {
            if occupied.iter().all(|&(j, x, y)| {
                x == a
                    && y == b
                    && cues[j]["effect"]["effect"] == effect["effect"]
                    && cues[j]["effect"]["elementId"] != effect["elementId"]
            }) {
                kept.push((i, a, b));
            }
            continue;
        }
        occupied.sort_by_key(|&(_, x, _)| x);
        let mut start = a;
        let mut best = (a, a);
        for (_, x, y) in occupied.into_iter().chain(std::iter::once((i, b, b))) {
            if x.saturating_sub(start) > best.1 - best.0 {
                best = (start, x);
            }
            start = start.max(y);
        }
        if best.1 > best.0 {
            kept.push((i, best.0, best.1));
        }
    }
    kept.sort_by_key(|&(i, _, _)| i);
    Ok(kept
        .into_iter()
        .map(|(i, a, b)| {
            let mut cue = cues[i].clone();
            cue["atMs"] = json!(a);
            cue["endMs"] = json!(b);
            cue
        })
        .collect())
}

impl Database {
    /// Automatic readiness applies only to generated scene teaching after durable audio adoption.
    pub(super) fn finish_generated_scene_page(
        &self,
        workspace: &str,
        project: CoursewareProject,
        page_id: &str,
    ) -> Result<CoursewareProject> {
        let page = project
            .pages
            .iter()
            .find(|p| p.page_id == page_id)
            .ok_or_else(|| anyhow!("COURSEWARE_PAGE_NOT_FOUND: generated teaching page missing"))?;
        let speeches: Vec<_> = page
            .actions
            .iter()
            .filter(|a| a["type"] == "speech")
            .collect();
        if project.task_type != "scene"
            || page.locked
            || page
                .actions
                .iter()
                .any(|a| matches!(a["type"].as_str(), Some("video_slot" | "music_slot")))
            || speeches.is_empty()
            || speeches.iter().any(|a| {
                a["source"] != "generated"
                    || a.get("attention").is_some()
                    || a["text"].as_str().is_none_or(|text| text.trim().is_empty())
                    || !a["audioAssetId"].is_string()
            })
        {
            return Ok(project);
        }
        anyhow::ensure!(
            !self.conn.is_autocommit(),
            "COURSEWARE_INVALID: generated readiness requires adoption transaction"
        );
        let mut scoped = project.clone();
        scoped.pages.retain(|p| p.page_id == page_id);
        let targets = reviews::effects::referenced(&scoped)?;
        for (_, target) in targets {
            self.validate_narration_attention(
                workspace,
                &project,
                page_id,
                &[json!({"attention":{"type":"highlight","objectIds":[target]}})],
            )?;
        }
        self.validate_courseware_review_audio(workspace, &scoped, &scoped)?;
        self.review_courseware_page(
            workspace,
            &project.project_id,
            page_id,
            &project.source.revision,
            &project.teaching_revision,
        )
    }

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
    fn retained_focus_and_new_motion_share_the_verified_speech_clock() {
        let mut marks = cues(
            &json!({"type":"spotlight","objectIds":["figure"],"animation":"pulse"}),
            "speech",
            4000,
        )
        .unwrap();
        marks.push(json!({"id":"old","atMs":0,"endMs":4000,"effect":{"type":"highlight","elementIds":["label"]}}));
        let result = sequence_focus(marks).unwrap();
        let times: Vec<_> = result
            .iter()
            .map(|c| (c["atMs"].as_u64().unwrap(), c["endMs"].as_u64().unwrap()))
            .collect();
        assert_eq!(times, [(0, 600), (600, 4000)]);
    }

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
        let parts: Vec<_> = (0..11).map(|i| format!("part-{i}")).collect();
        let diagram = cues(
            &json!({"type":"spotlight","objectIds":parts,"animation":"fadeIn"}),
            "diagram",
            4000,
        )
        .unwrap();
        assert_eq!(diagram.len(), 12);
        for c in diagram {
            reviews::effects::cue_targets(&c).unwrap();
        }
        let over_limit: Vec<_> = (0..201).map(|i| format!("part-{i}")).collect();
        assert!(targets(&json!({"type":"highlight","objectIds":over_limit})).is_err());
        let exit = cues(
            &json!({"type":"spotlight","objectIds":["one"],"animation":"fadeOut"}),
            "speech",
            2345,
        )
        .unwrap();
        assert_eq!(exit[0]["atMs"], 2345);
        assert_eq!(exit[0]["endMs"], 2945);
        assert_eq!(exit[0]["trigger"], json!({"version":1,"kind":"end"}));
        reviews::effects::cue_targets(&exit[0]).unwrap();
        for duration in [1, 100, 2345] {
            let planned = cues(
                &json!({"type":"highlight","objectIds":["one"],"animation":"fadeIn"}),
                "speech",
                duration,
            )
            .unwrap();
            assert_eq!(planned.len(), if duration == 1 { 1 } else { 2 });
            for cue in planned {
                assert!(cue["atMs"].as_u64().unwrap() < cue["endMs"].as_u64().unwrap());
                assert!(cue["endMs"].as_u64().unwrap() <= duration);
                reviews::effects::cue_targets(&cue).unwrap();
                if cue["effect"]["type"] == "element_animation" {
                    assert_eq!(cue["trigger"], json!({"version":1,"kind":"start"}));
                }
            }
        }
    }
}
