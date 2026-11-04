use super::*;

pub(super) fn valid_canvas(canvas: &Value) -> bool {
    if !text(&canvas["id"]) {
        return false;
    }
    let Some(elements) = canvas["elements"].as_array() else {
        return false;
    };
    let mut ids = HashSet::new();
    elements.iter().all(|e| {
        text(&e["id"])
            && ids.insert(e["id"].as_str().unwrap())
            && matches!(
                e["type"].as_str(),
                Some(
                    "text"
                        | "image"
                        | "shape"
                        | "line"
                        | "chart"
                        | "table"
                        | "latex"
                        | "video"
                        | "audio"
                )
            )
            && ["left", "top", "width", "height", "rotate"]
                .iter()
                .all(|key| e.get(key).is_none_or(Value::is_number))
    })
}

pub(super) fn validate_action(action: &Value, scene: &Value, scenes: &[Value]) -> Result<()> {
    let ty = action["type"].as_str().unwrap_or("");
    invalid(
        [
            "audioAssetId",
            "visualCues",
            "response",
            "durationMs",
            "videoAssetId",
        ]
        .iter()
        .all(|key| action.get(key).is_none()),
        "local teaching fields cannot enter MAIC actions",
    )?;
    let has = |key: &str| text(&action[key]);
    let number = |key: &str| action[key].is_number();
    let elements = scene["content"]["canvas"]["elements"].as_array();
    let target = |id: &Value| elements.is_some_and(|es| es.iter().any(|e| e["id"] == *id));
    match ty {
        "spotlight" | "laser" | "play_video" | "play_audio" | "element_animation" => {
            invalid(
                scene["type"] == "slide" && has("elementId") && target(&action["elementId"]),
                "action target is not owned by its slide",
            )?;
            if let Some(ids) = action.get("elementIds") {
                invalid(
                    ids.as_array().is_some_and(|ids| ids.iter().all(target)),
                    "missing spotlight target",
                )?;
            }
            if ty == "play_video" || ty == "play_audio" {
                invalid(
                    elements.unwrap().iter().any(|e| {
                        e["id"] == action["elementId"]
                            && e["type"] == if ty == "play_video" { "video" } else { "audio" }
                    }),
                    "media action targets the wrong element type",
                )?;
            }
            if ty == "element_animation" {
                invalid(
                    has("effect")
                        && matches!(
                            action["animationType"].as_str(),
                            Some("in" | "out" | "attention")
                        )
                        && action["duration"].as_f64().is_some_and(|n| n >= 0.)
                        && matches!(
                            action["pptistTrigger"].as_str(),
                            Some("click" | "meantime" | "auto")
                        ),
                    "invalid element animation",
                )?;
            }
        }
        "speech" => invalid(action["text"].is_string(), "speech text is required")?,
        "discussion" => invalid(action["topic"].is_string(), "discussion topic is required")?,
        "wb_delete" => invalid(has("elementId"), "whiteboard delete target required")?,
        "wb_draw_text" | "wb_draw_latex" => invalid(
            number("x")
                && number("y")
                && action[if ty == "wb_draw_text" {
                    "content"
                } else {
                    "latex"
                }]
                .is_string(),
            "invalid whiteboard text",
        )?,
        "wb_draw_shape" | "wb_draw_chart" | "wb_draw_table" => {
            invalid(
                ["x", "y", "width", "height"].iter().all(|key| number(key)),
                "invalid whiteboard geometry",
            )?;
            if ty == "wb_draw_shape" {
                invalid(
                    matches!(
                        action["shape"].as_str(),
                        Some("rectangle" | "circle" | "triangle")
                    ),
                    "invalid whiteboard shape",
                )?;
            }
            if ty == "wb_draw_chart" {
                invalid(
                    matches!(
                        action["chartType"].as_str(),
                        Some(
                            "bar"
                                | "column"
                                | "line"
                                | "pie"
                                | "ring"
                                | "area"
                                | "radar"
                                | "scatter"
                        )
                    ) && action["data"]["labels"]
                        .as_array()
                        .is_some_and(|a| a.iter().all(Value::is_string))
                        && action["data"]["legends"]
                            .as_array()
                            .is_some_and(|a| a.iter().all(Value::is_string))
                        && action["data"]["series"].as_array().is_some_and(|a| {
                            a.iter().all(|r| {
                                r.as_array().is_some_and(|r| r.iter().all(Value::is_number))
                            })
                        }),
                    "invalid whiteboard chart",
                )?;
            }
            if ty == "wb_draw_table" {
                invalid(
                    action["data"].as_array().is_some_and(|a| {
                        a.iter()
                            .all(|r| r.as_array().is_some_and(|r| r.iter().all(Value::is_string)))
                    }),
                    "invalid whiteboard table",
                )?;
            }
        }
        "wb_draw_line" => invalid(
            ["startX", "startY", "endX", "endY"]
                .iter()
                .all(|key| number(key)),
            "invalid whiteboard line",
        )?,
        "interaction_checkpoint" => {
            invalid(has("checkpointId"), "checkpoint ID required")?;
            if action["checkpointKind"] == "chapter_summary" {
                invalid(
                    action["context"]["sourceSceneIds"]
                        .as_array()
                        .is_some_and(|ids| {
                            ids.iter().all(|id| scenes.iter().any(|s| s["id"] == *id))
                        }),
                    "checkpoint references a missing scene",
                )?;
                for (object, field) in [("referenceAnswer", "label"), ("context", "chapterSummary")]
                {
                    invalid(
                        action[object].get(field).is_none_or(Value::is_string),
                        "invalid checkpoint metadata",
                    )?;
                }
                for field in ["sourceOutlineIds", "keyTerms"] {
                    invalid(
                        action["context"].get(field).is_none_or(|a| {
                            a.as_array().is_some_and(|a| a.iter().all(Value::is_string))
                        }),
                        "invalid checkpoint context metadata",
                    )?;
                }
            } else if action["checkpointKind"] == "media_playback" {
                invalid(
                    target(&action["elementId"])
                        && elements.unwrap().iter().any(|e| {
                            e["id"] == action["elementId"] && e["type"] == action["mediaType"]
                        }),
                    "media checkpoint target is not owned by its slide",
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn safe_source(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        !s.is_empty()
            && s.len() <= MAX_CLASSROOM_BYTES
            && (s.starts_with("https://")
                || s.starts_with("http://")
                || [
                    "data:image/",
                    "data:audio/",
                    "data:video/",
                    "/api/classroom-media/",
                ]
                .iter()
                .any(|prefix| s.starts_with(prefix))
                || managed_hash(s).is_some()
                || (s.starts_with("assets/") && !s.split('/').any(|c| c == "..")))
    })
}
fn media_ref(scene: &Value, entry: &Value) -> bool {
    if scene["type"] == "quiz" {
        return scene["content"]["questions"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|q| {
                let matched = |id: String, image: &Value| {
                    entry["assetType"] == "image"
                        && entry["elementId"] == id
                        && (image["assetId"] == entry["assetId"] || image["src"] == entry["src"])
                };
                matched(
                    format!("quiz-question:{}", q["id"].as_str().unwrap_or("")),
                    &q["image"],
                ) || q["options"].as_array().into_iter().flatten().any(|o| {
                    matched(
                        format!(
                            "quiz-option:{}:{}",
                            q["id"].as_str().unwrap_or(""),
                            o["value"].as_str().unwrap_or("")
                        ),
                        &o["image"],
                    )
                })
            });
    }
    if scene["type"] != "slide" {
        return false;
    }
    let canvas = &scene["content"]["canvas"];
    if entry["elementId"] == "__background__" {
        return entry["assetType"] == "image"
            && canvas["background"]["type"] == "image"
            && (canvas["background"]["image"]["src"] == entry["src"]
                || canvas["background"]["image"]["assetId"] == entry["assetId"]);
    }
    canvas["elements"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|e| {
            e["id"] == entry["elementId"]
                && ((e["type"] == entry["assetType"]
                    && (e["src"] == entry["src"] || e["assetId"] == entry["assetId"]))
                    || (e["type"] == "shape"
                        && entry["assetType"] == "image"
                        && (e["pattern"] == entry["src"]
                            || e["patternAssetId"] == entry["assetId"])))
        })
}
pub(super) fn validate_manifests(value: &Value) -> Result<()> {
    let scenes = value["scenes"].as_array().unwrap();
    for field in ["mediaManifest", "audioManifest"] {
        let Some(manifest) = value.get(field) else {
            continue;
        };
        let entries = manifest
            .as_array()
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: asset manifest must be an array"))?;
        let mut keys = HashSet::new();
        for e in entries {
            invalid(
                text(&e["assetId"]) && text(&e["mimeType"]),
                "invalid asset identity",
            )?;
            if let Some(path) = e.get("zipPath") {
                invalid(
                    path.as_str().is_some_and(|s| {
                        s.starts_with("assets/") && !s.split('/').any(|c| c == "..")
                    }),
                    "invalid archive asset path",
                )?;
            }
            if field == "mediaManifest" {
                invalid(
                    text(&e["elementId"])
                        && matches!(e["assetType"].as_str(), Some("image" | "audio" | "video"))
                        && safe_source(&e["src"])
                        && e["originalSrc"].is_string()
                        && keys.insert((
                            e["sceneId"].clone().to_string(),
                            e["elementId"].clone().to_string(),
                        )),
                    "invalid media manifest entry",
                )?;
                invalid(
                    scenes.iter().any(|scene| {
                        (e.get("sceneId").is_none() || e["sceneId"] == scene["id"])
                            && media_ref(scene, e)
                    }),
                    "media asset is not owned by its scene",
                )?;
            } else {
                invalid(
                    text(&e["sceneId"])
                        && text(&e["actionId"])
                        && text(&e["audioId"])
                        && safe_source(&e["url"])
                        && e["originalUrl"].is_string()
                        && keys.insert((
                            e["sceneId"].clone().to_string(),
                            e["actionId"].clone().to_string(),
                        )),
                    "invalid audio manifest entry",
                )?;
                invalid(
                    scenes.iter().any(|s| {
                        s["id"] == e["sceneId"]
                            && s["actions"].as_array().into_iter().flatten().any(|a| {
                                a["id"] == e["actionId"]
                                    && a["type"] == "speech"
                                    && (a["audioId"] == e["audioId"] || a["audioUrl"] == e["url"])
                            })
                    }),
                    "audio asset is not owned by its speech action",
                )?;
            }
        }
    }
    Ok(())
}

fn quiz_speech(scene: &Value) -> Value {
    json!(scene["content"]["questions"].as_array().into_iter().flatten().map(|q| json!({
        "id":q["id"], "question":q["question"],"type":q["type"],"analysis":q["analysis"].as_str().unwrap_or(""),
        "commentPrompt":q["commentPrompt"].as_str().unwrap_or(""),"answer":q.get("answer").cloned().unwrap_or(json!([])),
        "hasAnswer":q["hasAnswer"],"referenceAnswer":q["referenceAnswer"],"keyPoints":q["keyPoints"],
        "options":q["options"].as_array().into_iter().flatten().map(|o| json!({"value":o["value"],"label":o["label"]})).collect::<Vec<_>>()
    })).collect::<Vec<_>>())
}

pub(super) fn invalidate_edited_audio(previous: &Value, next: &mut Value) {
    let mut changed_actions = HashSet::new();
    if let Some(scenes) = next.get_mut("scenes").and_then(Value::as_array_mut) {
        for scene in scenes {
            let old = previous["scenes"]
                .as_array()
                .and_then(|ss| ss.iter().find(|s| s["id"] == scene["id"]));
            let Some(old) = old else {
                continue;
            };
            let checkpoint_fields = |s: &Value| {
                s["actions"].as_array().into_iter().flatten().filter(|a| a["type"] == "interaction_checkpoint").map(|a| json!({"id":a["id"],"question":a["question"],"referenceAnswer":a["referenceAnswer"],"constraintPrompt":a["constraintPrompt"]})).collect::<Vec<_>>()
            };
            let edited = (scene["type"] == "quiz" && quiz_speech(old) != quiz_speech(scene))
                || checkpoint_fields(old) != checkpoint_fields(scene);
            let scene_id = scene["id"].as_str().unwrap_or("").to_owned();
            if let Some(actions) = scene.get_mut("actions").and_then(Value::as_array_mut) {
                for action in actions.iter_mut().filter(|a| a["type"] == "speech") {
                    let old_action = old["actions"].as_array().and_then(|aa| {
                        aa.iter()
                            .find(|a| a["id"] == action["id"] && a["type"] == "speech")
                    });
                    let text_changed = old_action.is_some_and(|a| a["text"] != action["text"]);
                    if edited || text_changed {
                        changed_actions.insert((
                            scene_id.clone(),
                            action["id"].as_str().unwrap_or("").to_owned(),
                        ));
                        if let Some(a) = action.as_object_mut() {
                            for field in ["audioId", "audioUrl", "resolvedAudioUrl", "timingTrack"]
                            {
                                a.remove(field);
                            }
                        }
                    }
                }
                for action in actions
                    .iter_mut()
                    .filter(|a| a["type"] == "element_animation")
                {
                    if changed_actions.contains(&(
                        scene_id.clone(),
                        action["speechCue"]["speechActionId"]
                            .as_str()
                            .unwrap_or("")
                            .to_owned(),
                    )) {
                        action.as_object_mut().unwrap().remove("speechCue");
                    }
                }
            }
        }
    }
    if let Some(manifest) = next.get_mut("audioManifest").and_then(Value::as_array_mut) {
        manifest.retain(|e| {
            !changed_actions.contains(&(
                e["sceneId"].as_str().unwrap_or("").to_owned(),
                e["actionId"].as_str().unwrap_or("").to_owned(),
            ))
        });
    }
}

fn managed_hash(source: &str) -> Option<&str> {
    let name = source.strip_prefix(".deckwise-ppt/classroom-assets/")?;
    let (hash, extension) = name.rsplit_once('.')?;
    (hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
        && !extension.is_empty()
        && extension.len() <= 12
        && extension.bytes().all(|c| c.is_ascii_alphanumeric()))
    .then_some(hash)
}

/// Managed asset references are content-addressed and confined to this persisted workspace.
pub(super) fn validate_workspace_assets(workspace: &str, classroom: &Value) -> Result<()> {
    fn collect(value: &Value, sources: &mut HashSet<String>) {
        match value {
            Value::String(s) if s.starts_with(".deckwise-ppt/classroom-assets/") => {
                sources.insert(s.to_owned());
            }
            Value::Array(a) => {
                for value in a {
                    collect(value, sources);
                }
            }
            Value::Object(o) => {
                for (key, value) in o {
                    if [
                        "src",
                        "resolvedSrc",
                        "url",
                        "audioUrl",
                        "resolvedAudioUrl",
                        "poster",
                        "pattern",
                        "originalSrc",
                        "originalUrl",
                    ]
                    .contains(&key.as_str())
                    {
                        collect(value, sources);
                    } else if value.is_array() || value.is_object() {
                        collect(value, sources);
                    }
                }
            }
            _ => {}
        }
    }
    let mut sources = HashSet::new();
    collect(classroom, &mut sources);
    for source in sources {
        let hash = managed_hash(&source)
            .ok_or_else(|| anyhow!("COURSEWARE_INVALID: invalid managed classroom asset"))?;
        crate::courseware::source_candidates::verify_live_source(
            Path::new(workspace),
            &Path::new(workspace).join(&source),
            hash,
        )?;
    }
    Ok(())
}
