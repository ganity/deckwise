use super::*;

pub(super) fn fixture() -> (source_candidates::ParsedOutput, CoursewareProject, Value) {
    let raw: Value =
        serde_json::from_slice(include_bytes!("../identity/fixtures/identity.json")).unwrap();
    let parsed = source_candidates::ParsedOutput {
        sha256: raw["sourceSha256"].as_str().unwrap().into(),
        pages: 1,
        identity: Some(raw.clone()),
    };
    let project = serde_json::from_value(json!({"schemaVersion":"deckwise-courseware/1",
        "projectId":"22222222-2222-4222-8222-222222222222","taskType":"import","title":"Original teaching",
        "source":{"revision":"33333333-3333-4333-8333-333333333333","sha256":parsed.sha256},"teachingRevision":"teaching-old",
        "pages":[{"pageId":"old-page","locked":true,"reviewState":"review","actions":[
            {"id":"speech-1","type":"speech","text":"Good!","audioAssetId":"tts-old","visualCues":[{"keep":"opaque"}]}
        ]}]})).unwrap();
    let mapping = json!({"revision":"old-mapping","sourceSha256":parsed.sha256,"pages":[{
        "pageId":"old-page","importPageId":"page_1","objects":raw["pages"][0]["objects"].as_array().unwrap().iter().enumerate().map(|(i,object)|
            json!({"objectId":format!("old-object-{i}"),"importElementId":object["importElementId"]})).collect::<Vec<_>>()
    }]});
    (parsed, project, mapping)
}

pub(super) fn target() -> (source_candidates::ParsedOutput, Target) {
    let (mut parsed, _, _) = fixture();
    parsed.sha256 = "b".repeat(64);
    parsed.identity.as_mut().unwrap()["sourceSha256"] = json!(parsed.sha256);
    let pins = Target {
        source: CoursewareSource {
            revision: "44444444-4444-4444-8444-444444444444".into(),
            sha256: parsed.sha256.clone(),
        },
        byte_length: 123,
        session_epoch: 4,
        callback_id: "c".repeat(64),
    };
    (parsed, pins)
}

fn baseline(cache: &mut ReviewCache, workspace: &Path) -> String {
    let (parsed, project, mapping) = fixture();
    cache
        .baseline("chat-1", workspace, parsed, project, mapping)
        .unwrap()["baselineId"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn online_source_review_preserves_original_pins_actions_and_projects_no_associations() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = ReviewCache::default();
    let id = baseline(&mut cache, dir.path());
    let (mut parsed, pins) = target();
    let mut copy = parsed.identity.as_ref().unwrap()["pages"][0].clone();
    copy["logicalId"] = json!("new-page");
    copy["importPageId"] = json!("page_2");
    for (i, object) in copy["objects"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        object["logicalId"] = json!(format!("new-object-{i}"));
    }
    parsed.identity.as_mut().unwrap()["pages"]
        .as_array_mut()
        .unwrap()
        .insert(0, copy);
    parsed.pages = 2;
    let view = cache
        .review("chat-1", dir.path(), &id, parsed.clone(), pins)
        .unwrap();
    let (_, original, mapping) = fixture();
    assert_eq!(
        view["original"],
        json!({"project":original,"mapping":mapping})
    );
    assert_eq!(
        view["original"]["project"]["source"]["revision"],
        "33333333-3333-4333-8333-333333333333"
    );
    assert_eq!(
        view["target"]["source"]["revision"],
        "44444444-4444-4444-8444-444444444444"
    );
    assert_eq!(view["target"]["callbackId"], "c".repeat(64));
    assert_eq!(view["target"]["pages"][0]["importPageId"], "page_2");
    assert_eq!(view["target"]["pages"].as_array().unwrap().len(), 2);
    assert_eq!(
        view["previousPages"][0]["objects"][0]["objectId"],
        "old-object-0"
    );
    assert_eq!(view["requiresExplicitAssociations"], true);
    assert!(view.get("bindings").is_none() && view.get("mapping").is_none());
    let (_, pins) = target();
    assert_eq!(
        cache
            .review("chat-1", dir.path(), &id, parsed, pins)
            .unwrap(),
        view
    );
}

#[test]
fn online_source_review_replacement_is_single_and_invalid_replacement_clears_old_baseline() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = ReviewCache::default();
    let old = baseline(&mut cache, dir.path());
    let new = baseline(&mut cache, dir.path());
    assert_ne!(old, new);
    assert!(cache.owned("chat-1", dir.path(), &old).is_err());
    for case in 0..5 {
        let id = baseline(&mut cache, dir.path());
        let (mut parsed, mut project, mut mapping) = fixture();
        match case {
            0 => mapping["sourceSha256"] = json!("b".repeat(64)),
            1 => mapping["pages"][0]["objects"][0]["importElementId"] = json!("wrong"),
            2 => mapping["pages"][0]["pageId"] = json!("another-page"),
            3 => project.source.sha256 = "b".repeat(64),
            _ => parsed.identity.as_mut().unwrap()["mappingRevision"] = json!("already-bound"),
        }
        assert!(
            cache
                .baseline("chat-1", dir.path(), parsed, project, mapping)
                .is_err(),
            "case {case}"
        );
        assert!(cache.owned("chat-1", dir.path(), &id).is_err());
    }
}

#[test]
fn online_source_review_is_session_workspace_lifetime_and_restart_scoped() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let mut cache = ReviewCache::default();
    let id = baseline(&mut cache, dir.path());
    assert!(cache.owned("chat-2", dir.path(), &id).is_err());
    assert!(cache.owned("chat-1", other.path(), &id).is_err());
    assert!(cache.owned("chat-1", dir.path(), &id).is_ok());
    cache.0.as_mut().unwrap().created = Instant::now() - TTL;
    assert!(cache.owned("chat-1", dir.path(), &id).is_err());
    assert!(cache.0.is_none());
    let id = baseline(&mut cache, dir.path());
    cache.clear();
    assert!(cache.owned("chat-1", dir.path(), &id).is_err());
    assert!(ReviewCache::default()
        .owned("chat-1", dir.path(), &id)
        .is_err());
}

#[test]
fn online_source_review_rejects_invalid_target_archive_pins_and_oversized_projection() {
    let dir = tempfile::tempdir().unwrap();
    let mut cache = ReviewCache::default();
    let id = baseline(&mut cache, dir.path());
    for case in 0..6 {
        let (parsed, mut pins) = target();
        match case {
            0 => pins.session_epoch = 0,
            1 => pins.session_epoch = 9_007_199_254_740_992,
            2 => pins.callback_id = "bad".into(),
            3 => pins.source.revision = "not-uuid".into(),
            4 => pins.source.sha256 = "f".repeat(64),
            _ => pins.byte_length = 0,
        }
        assert!(
            cache
                .review("chat-1", dir.path(), &id, parsed, pins)
                .is_err(),
            "case {case}"
        );
    }
    let (mut parsed, pins) = target();
    let object = parsed.identity.as_ref().unwrap()["pages"][0]["objects"][0].clone();
    parsed.identity.as_mut().unwrap()["pages"][0]["objects"] = json!((0..10_000)
        .map(|i| {
            let mut object = object.clone();
            object["logicalId"] = json!(format!("logical-{i}"));
            object["importElementId"] = json!(format!("{i:0200}"));
            object
        })
        .collect::<Vec<_>>());
    assert!(cache
        .review("chat-1", dir.path(), &id, parsed, pins)
        .unwrap_err()
        .to_string()
        .contains("size limit"));
}
