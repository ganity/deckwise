use super::{scene_plan, Target};

// Ported from MAIC slide-authoring.ts at fdb27892; keep PPTX delivery and the 4000-unit transport limit.
const COMPOSITION: &str = "Use the full canvas as one intentional teaching composition, not a generic background or slot template. Prefer one focal action, no collage or disconnected vignettes, generous breathing room. Integrate the requested text components into the finished composition at natural readable locations. Continue one environment, floor, light, and perspective across the full canvas.";
const BACKGROUND: &str = "Background art direction: preserve a cohesive full-canvas setting, not a blank wall or generic gradient. Use depth, light, color and materials for atmosphere, not piles of objects. Keep background detail subordinate and calm around subjects and text.";
const CONTENT: &str = "Preserve every lesson-required subject, name and prop; do not cap their count. No unrequested subjects, duplicate portraits/badges, extra text carriers or decorative props. The visual bible is an identity guide, not a cast list for every page. Keep the requested style and setting.";
const ORIGINAL_CHARACTERS: &str = "Original character design: use distinct silhouettes, proportions, faces and color/outfit combinations, not recognizable commercial mascots or their signature feature combinations. Preserve required names, species, count, explicit user appearance requirements and approved identities, applying requested corrections consistently across pages. For unspecified traits, describe concrete original features without franchise references.";
const SEPARATION: &str = "Every foreground subject and readable text component must be independent, non-touching, non-overlapping and fully inside the canvas, with visible background gutters. Keep glyph edges crisp and opaque with a thick high-contrast outline. No lettering, outline, ribbon, bubble or accent may touch or cover a foreground subject. Avoid stiff front-facing lineups, repeated clip-art spacing, excessive empty space, cropped faces or limbs, distorted anatomy and unrelated decoration.";
const COMPACT_MASTER: &str = "Use case: scientific-educational. Create one complete 1280x800, 16:10 teaching-slide illustration in the approved art direction.";
const COMPACT_RULES: &str = "One focal action in a cohesive full-canvas setting with calm depth, light and texture. Preserve page-required subjects, names and props, each once. The visual bible guides identities, not the cast list. Keep approved identities and explicit appearance requirements; use original silhouettes, proportions, faces and outfits, avoiding commercial mascot designs. Keep subjects and crisp outlined lettering independent, non-touching and inside the canvas with background gutters. No extra subjects, text, logos or decoration; avoid stiff lineups and cropped limbs.";

// MAIC lib/media/adapters/seedream-layer-adapter.ts, SEEDREAM_LAYER_PROMPT.
pub(super) const LAYER_PROMPT: &str = "将图片进行精确图层分离，只分离所有可独立编辑的前景教学元素：人物、动物、植物、主要教学道具，以及所有文字、卡片、气泡、按钮等文字载体（整块载体连同上面的文字一起分离）。背景、墙面、窗户、家具、地毯、绿植、挂画、旗帜等环境装饰全部保留在底图中，不要单独分离。";

pub(super) fn build(
    plan: &scene_plan::Plan,
    page: &scene_plan::Page,
    target: &Target,
    decomposition: bool,
    referenced: bool,
    instructions: &str,
) -> String {
    let full = build_variant(
        plan,
        page,
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
            if objects.len() >= 3 {
                prompt.push_str(if compact { " Keep separate full-body silhouettes under 45% of canvas height, without detached accents." } else { " Keep each as a separate non-touching full-body silhouette with background gutters, at most 45% of canvas height. No detached shadows, motion lines, glow or accents around movable subjects." });
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
        if let Some(bible) = &plan.visual_bible {
            prompt.push_str(&format!(
                "\nCourse visual bible: Art direction: {}. Character identities: {}. Setting: {}.",
                bible.art_direction, bible.characters, bible.setting
            ));
        } else if matches!(target, Target::VisualMaster {}) {
            prompt.push_str("\nArt direction: follow the user-requested medium, materials, palette and lighting in the page brief. When no medium is specified, use premium hand-painted kindergarten picture-book illustration with rounded silhouettes, expressive faces, warm depth and large readable teaching objects. Keep expressive subjects and large readable teaching objects.");
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
            let prompt = build_variant(&plan, &plan.pages[0], &Target::VisualMaster {}, false, false, "", compact);
            assert!(prompt.contains("NO readable text"));
            assert!(prompt.contains("editable PowerPoint text"));
            assert!(!prompt.contains("render each exact string once"));
            assert!(!prompt.contains("render only these exact readable text targets"));
        }
        assert!(serde_json::from_value::<scene_plan::Plan>(json!({
            "title":"Invalid", "textMode":"raster", "pages":[]
        })).is_err());
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
            &Target::VisualMaster {},
            false,
            true,
            "Warm light",
        );
        for text in [
            "Clay 3D",
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
            &Target::CleanPlate {},
            true,
            true,
            "",
        );
        assert_eq!(decomposition, LAYER_PROMPT);
        assert_eq!(build(&plan, &plan.pages[0], &Target::CleanPlate {}, true, true, "Legacy instructions"), LAYER_PROMPT);
        assert!(decomposition.contains("整块载体连同上面的文字一起分离"));
        assert!(!decomposition.contains("Remove every readable title"));
        let mut page: scene_plan::Page = serde_json::from_value(json!({"title":"Quiet scene", "visibleText":[], "visualIntent":"A landscape", "narration":"Listen"})).unwrap();
        assert!(
            build(&plan, &page, &Target::VisualMaster {}, false, false, "")
                .contains("Render no readable text")
        );
        page.visible_text = vec!["Text \"with quotes\"\nSecond line".into()];
        assert!(
            build(&plan, &page, &Target::VisualMaster {}, false, false, "")
                .contains(r#"Text \"with quotes\"\nSecond line"#)
        );
        let mut legacy = plan;
        legacy.visual_bible = None;
        let prompt = build(&legacy, &page, &Target::VisualMaster {}, false, false, "");
        assert!(prompt.contains("Original character design:"));
        assert!(prompt.contains("follow the user-requested medium"));
        assert!(prompt.contains("premium hand-painted kindergarten picture-book"));
    }
}
