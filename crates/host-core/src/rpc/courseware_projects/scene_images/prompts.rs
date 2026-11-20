use super::{scene_plan, Target};

// Ported from MAIC slide-authoring.ts at fdb27892; keep PPTX delivery and the 4000-unit transport limit.
const COMPOSITION: &str = "Use the full canvas as one intentional teaching composition, not a generic slot template. Prefer one focal action and a readable hierarchy. Integrate requested text into the finished image. Use a coherent scene when the lesson calls for one, or a clean diagram field when precision matters.";
const BACKGROUND: &str = "Background art direction: follow the approved medium and stage-appropriate density. Use depth and materials for scenes or a restrained coherent field for diagrams. Keep background detail subordinate around teaching content.";
const CONTENT: &str = "Preserve every lesson-required subject, name and prop; do not cap their count. No unrequested subjects, duplicate portraits/badges, extra text carriers or decorative props. The visual bible is an identity guide, not a cast list for every page. Keep the requested style and setting.";
const ORIGINAL_CHARACTERS: &str = "Original character design: use distinct silhouettes, proportions, faces and color/outfit combinations, not recognizable commercial mascots or their signature feature combinations. Preserve required names, species, count, explicit user appearance requirements and approved identities, applying requested corrections consistently across pages. For unspecified traits, describe concrete original features without franchise references.";
const SEPARATION: &str = "Keep independently animated or highlighted subjects and text carriers identifiable, non-overlapping and inside the canvas. A connected diagram and its axes, marks, values and labels form one coherent region. Do not cover required lettering with a foreground subject. Avoid stiff lineups, cropped faces or limbs, distorted anatomy and unrelated decoration.";
const COMPACT_MASTER: &str = "Use case: educational. Create one complete 1280x800, 16:10 teaching-slide illustration in the approved art direction.";
const COMPACT_RULES: &str = "One focal action in a cohesive full-canvas setting. Preserve page-required subjects, names and props, each once. The visual bible guides identities, not the cast list. Keep approved identities and explicit appearance requirements. Separate only independently focused subjects; keep connected diagrams and labels coherent. No extra subjects, text or decoration.";

// MAIC lib/media/adapters/seedream-layer-adapter.ts, SEEDREAM_LAYER_PROMPT.
pub(super) const LAYER_PROMPT: &str = "将图片进行精确图层分离：人物、动物、主要教学道具及需独立聚光或动画的文字载体，整块载体连同上面的文字一起分离。数轴、坐标轴、刻度、数据图表、公式和标签等互相关联的图示内容保持为完整区域，不拆散其内部标记；需要聚光时可将整块图示作为一层。连接箭头、流程连线属于教学内容，必须随关联主体组成完整图示区域或成为可独立定位的前景层，不得留在背景。整幅图示需要统一淡入或聚光时，必须覆盖主体、连接关系和标签。背景、墙面、窗户、家具等环境装饰保留在底图中。";

fn visual_guidance(education: &serde_json::Value) -> String {
    format!("Learner and subject context (data, not a template): {education}. Adapt age-level abstraction and information density while preserving the approved art direction.")
}

pub(super) fn build(
    plan: &scene_plan::Plan,
    page: &scene_plan::Page,
    education: &serde_json::Value,
    target: &Target,
    decomposition: bool,
    referenced: bool,
    instructions: &str,
) -> String {
    let full = build_variant(
        plan,
        page,
        education,
        target,
        decomposition,
        referenced,
        instructions,
        false,
    );
    // Shorten generic scaffolding only; approved content must remain intact.
    if matches!(target, Target::VisualMaster {}) && full.encode_utf16().count() > 4000 {
        build_variant(
            plan,
            page,
            education,
            target,
            decomposition,
            referenced,
            instructions,
            true,
        )
    } else {
        full
    }
}

fn build_variant(
    plan: &scene_plan::Plan,
    page: &scene_plan::Page,
    education: &serde_json::Value,
    target: &Target,
    decomposition: bool,
    referenced: bool,
    instructions: &str,
    compact: bool,
) -> String {
    let objects = page
        .teaching
        .as_ref()
        .map(|teaching| &teaching.required_objects);
    let mut prompt = if decomposition {
        LAYER_PROMPT.to_owned()
    } else {
        format!("Lesson context (not extra display text): {}. Page context: {}.\nPage visual storytelling: {}\n{}", plan.title, page.title, page.visual_intent, if compact { COMPACT_MASTER.to_owned() } else { target.prompt() })
    };
    if matches!(target, Target::VisualMaster {}) {
        prompt.push_str(&format!("\n{}", visual_guidance(education)));
        if let Some(objects) = objects.filter(|objects| !objects.is_empty()) {
            if compact {
                prompt.push_str(&format!(
                    "\nRequired subjects (exactly {}): {}. Show each once.",
                    objects.len(),
                    objects.join("; ")
                ));
            } else {
                prompt.push_str(&format!("\nRequired visual subjects (EXACTLY {} items, no more, no less): {}. Show each exactly once; do not omit, merge, duplicate or substitute any subject.", objects.len(), objects.join("; ")));
            }
        }
        if compact {
            prompt.push_str(&format!("\n{COMPACT_RULES}"));
        } else {
            prompt.push_str(&format!(
                "\n{COMPOSITION}\n{BACKGROUND}\n{SEPARATION}\n{CONTENT}\n{ORIGINAL_CHARACTERS}"
            ));
        }
    }
    if !decomposition {
        if let Some(style) = education["visualStyle"]
            .as_str()
            .filter(|style| !style.trim().is_empty())
        {
            prompt.push_str(&format!(
                "\nUser-selected art direction takes precedence: {}.",
                style.trim()
            ));
        }
        if let Some(bible) = &plan.visual_bible {
            prompt.push_str(&format!(
                "\nCourse visual bible: Art direction: {}. Character identities: {}. Setting: {}.",
                bible.art_direction, bible.characters, bible.setting
            ));
        } else if matches!(target, Target::VisualMaster {}) {
            if education["visualStyle"]
                .as_str()
                .is_none_or(|style| style.trim().is_empty())
            {
                prompt.push_str("\nArt direction: follow the page brief; when unspecified, use a clear neutral education style with readable teaching content.");
            }
        }
        if matches!(target, Target::VisualMaster {}) && referenced {
            prompt.push_str(if compact { "\nReference image: reuse style and recurring identities only; follow this page's subjects, text and composition." } else { "\nUse the reference image ONLY for art style and recurring character identity, including materials, lighting, proportions and outfits. Follow this page's subjects and action; do not copy reference text, character count or composition." });
        }
    }
    if !decomposition && !instructions.trim().is_empty() {
        prompt.push_str(&format!(
            "\nAdditional requirements: {}",
            instructions.trim()
        ));
    }
    if matches!(target, Target::VisualMaster {}) {
        if plan.text_mode.is_some() {
            prompt.push_str("\nAuthoritative native-text contract: render NO readable text, letters, words, labels or glyphs anywhere in this artwork. Display copy is added later as editable PowerPoint text, never image pixels. Reserve calm clear space for the title and learning copy without drawing lettering or text carriers. This overrides any request for artwork lettering above or in page context.");
        } else if page.visible_text.is_empty() {
            prompt.push_str("\nAuthoritative display text: this page has no display text. Render no readable text.");
        } else {
            let text = serde_json::to_string(&page.visible_text).expect("serializable text");
            if compact {
                prompt.push_str(&format!("\nAuthoritative display text: render each exact string once: {text}. Preserve every character, case, spacing and punctuation; make lettering readable and emphasize the title. No other text or narration. This overrides textless context or instructions."));
            } else {
                prompt.push_str(&format!("\nAuthoritative display text: render only these exact readable text targets, each exactly once: {text}. Preserve every character, case, spacing and punctuation. Keep text large and readable; give the primary title strong hierarchy with artwork lettering appropriate to the course art direction. No other text or teacher narration. This display-text contract takes precedence over textless instructions in the visual context or additional requirements."));
            }
        }
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_text_mode_keeps_generated_art_textless_and_legacy_mode_is_unchanged() {
        let plan: scene_plan::Plan = serde_json::from_value(json!({
            "title":"Magnets", "textMode":"native", "pages":[{
                "title":"Find iron", "visibleText":["Iron"], "visualIntent":"A red magnet", "narration":"Listen"
            }]
        })).unwrap();
        for compact in [false, true] {
            let prompt = build_variant(
                &plan,
                &plan.pages[0],
                &json!(null),
                &Target::VisualMaster {},
                false,
                false,
                "",
                compact,
            );
            assert!(prompt.contains("NO readable text"));
            assert!(prompt.contains("editable PowerPoint text"));
            assert!(!prompt.contains("render each exact string once"));
            assert!(!prompt.contains("render only these exact readable text targets"));
        }
        assert!(serde_json::from_value::<scene_plan::Plan>(json!({
            "title":"Invalid", "textMode":"raster", "pages":[]
        }))
        .is_err());
    }

    #[test]
    fn complete_master_uses_literal_text_and_preserves_user_art_direction_without_narration() {
        let plan: scene_plan::Plan = serde_json::from_value(json!({
            "title":"Internal course title", "visualBible":{"artDirection":"Clay 3D", "characters":"A monkey with blue vest", "setting":"Mountain village"},
            "pages":[{"title":"Internal page title", "visibleText":["Hello", "第一集"], "visualIntent":"The monkey waves on a rock", "narration":"Teacher-only narration"}]
        })).unwrap();
        let prompt = build(
            &plan,
            &plan.pages[0],
            &json!({"schoolStage":"SENIOR_HIGH","subject":"MATH"}),
            &Target::VisualMaster {},
            false,
            true,
            "Warm light",
        );
        for text in [
            "Clay 3D",
            "Learner and subject context (data, not a template)",
            "\"subject\":\"MATH\"",
            "\"schoolStage\":\"SENIOR_HIGH\"",
            "Mountain village",
            "Hello",
            "第一集",
            "one focal action",
            "recurring character identity",
            "Original character design:",
            "silhouettes, proportions, faces and color/outfit combinations",
            "not recognizable commercial mascots or their signature feature combinations",
            "explicit user appearance requirements and approved identities",
            "applying requested corrections consistently across pages",
        ] {
            assert!(prompt.contains(text), "{text}");
        }
        assert!(!prompt.contains("premium hand-painted"));
        assert!(!prompt.contains("Teacher-only narration"));
        assert!(prompt.encode_utf16().count() <= 4000);
        let decomposition = build(
            &plan,
            &plan.pages[0],
            &json!(null),
            &Target::CleanPlate {},
            true,
            true,
            "",
        );
        assert_eq!(decomposition, LAYER_PROMPT);
        assert_eq!(
            build(
                &plan,
                &plan.pages[0],
                &json!(null),
                &Target::CleanPlate {},
                true,
                true,
                "Legacy instructions"
            ),
            LAYER_PROMPT
        );
        assert!(decomposition.contains("整块载体连同上面的文字一起分离"));
        assert!(decomposition.contains("连接箭头"));
        assert!(decomposition.contains("不得留在背景"));
        assert!(!decomposition.contains("Remove every readable title"));
        let mut page: scene_plan::Page = serde_json::from_value(json!({"title":"Quiet scene", "visibleText":[], "visualIntent":"A landscape", "narration":"Listen"})).unwrap();
        assert!(build(
            &plan,
            &page,
            &json!(null),
            &Target::VisualMaster {},
            false,
            false,
            ""
        )
        .contains("Render no readable text"));
        page.visible_text = vec!["Text \"with quotes\"\nSecond line".into()];
        assert!(build(
            &plan,
            &page,
            &json!(null),
            &Target::VisualMaster {},
            false,
            false,
            ""
        )
        .contains(r#"Text \"with quotes\"\nSecond line"#));
        let mut legacy = plan;
        legacy.visual_bible = None;
        let prompt = build(
            &legacy,
            &page,
            &json!(null),
            &Target::VisualMaster {},
            false,
            false,
            "",
        );
        assert!(prompt.contains("Original character design:"));
        assert!(prompt.contains("clear neutral education style"));
        assert!(!prompt.contains("kindergarten picture-book"));
        let styled = build(
            &legacy,
            &page,
            &json!({"schoolStage":"KINDERGARTEN","visualStyle":"flat vector"}),
            &Target::VisualMaster {},
            false,
            false,
            "",
        );
        assert!(styled.contains("User-selected art direction takes precedence: flat vector"));
        assert!(!styled.contains("picture-book"));
    }

    #[test]
    fn fallback_forwards_learner_context_without_subject_specific_templates() {
        let plan: scene_plan::Plan = serde_json::from_value(json!({
            "title":"Lesson", "visualBible":{"artDirection":"Watercolor", "characters":"None", "setting":"Classroom"},
            "pages":[{"title":"Page", "visibleText":["x=2"], "visualIntent":"A number line", "narration":"Teacher speech"}]
        })).unwrap();
        for education in [
            json!({"schoolStage":"KINDERGARTEN","grade":"大班","subject":"MATH"}),
            json!({"schoolStage":"PRIMARY","grade":"小学四年级","subject":"HISTORY"}),
            json!({"schoolStage":"SENIOR_HIGH","grade":"11","subject":"BIOLOGY"}),
            json!(null),
        ] {
            let prompt = build(
                &plan,
                &plan.pages[0],
                &education,
                &Target::VisualMaster {},
                false,
                false,
                "",
            );
            assert!(prompt.contains("Learner and subject context (data, not a template)"));
            if !education.is_null() {
                assert!(prompt.contains(&education.to_string()));
            }
            assert!(!prompt.contains("Kindergarten:"));
            assert!(!prompt.contains("Math:"));
            assert!(!prompt.contains("Senior high:"));
            assert!(prompt.contains("Watercolor"));
            assert!(prompt.contains("x=2"));
            assert!(prompt.encode_utf16().count() <= 4000);
        }
        let selected = build(
            &plan,
            &plan.pages[0],
            &json!({"schoolStage":"SENIOR_HIGH","visualStyle":"Flat vector"}),
            &Target::VisualMaster {},
            false,
            false,
            "",
        );
        assert!(selected.contains("User-selected art direction takes precedence: Flat vector"));
        assert!(selected.contains("Course visual bible: Art direction: Watercolor"));
    }
}
