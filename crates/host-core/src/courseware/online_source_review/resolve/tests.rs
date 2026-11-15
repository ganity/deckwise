use super::*;

fn fixture() -> (
    tempfile::TempDir,
    ReviewCache,
    source_candidates::ParsedOutput,
    ResolveRequest,
) {
    let dir = tempfile::tempdir().unwrap();
    let (old, mut project, mapping) = super::super::tests::fixture();
    let objects = mapping["pages"][0]["objects"].as_array().unwrap();
    assert!(objects.len() >= 2);
    project.pages[0].locked = false;
    project.pages[0].actions=json!([
        {"id":"speech-1","type":"speech","text":"Good!","audioAssetId":"55555555-5555-4555-8555-555555555555","pauseAfterMs":1000,"visualCues":[
            {"id":"highlight","atMs":0,"endMs":1000,"effect":{"type":"highlight","elementIds":["old-object-0","old-object-1"],"color":"#FFCC00"}},
            {"id":"spotlight","atMs":1000,"endMs":2000,"effect":{"type":"spotlight","elementId":"old-object-0"}}
        ]},
        {"id":"music","type":"audio_clip","audioAssetId":"66666666-6666-4666-8666-666666666666"},
        {"id":"wait","type":"interaction_checkpoint","checkpointKind":"teacher_continue","checkpointId":"wait-1"}
    ]).as_array().unwrap().clone();
    assert!(project.validate().is_err());
    project.validate_online().unwrap();
    let mut cache = ReviewCache::default();
    let id = cache
        .baseline("chat-1", dir.path(), old, project, mapping)
        .unwrap()["baselineId"]
        .as_str()
        .unwrap()
        .to_owned();
    let (parsed, target) = super::super::tests::target();
    let review = cache
        .review("chat-1", dir.path(), &id, parsed.clone(), target.clone())
        .unwrap();
    let ids = parsed.identity.as_ref().unwrap()["pages"][0]["objects"]
        .as_array()
        .unwrap();
    let request=serde_json::from_value(json!({"sessionId":"chat-1","baselineId":id,"reviewId":review["reviewId"],"jobId":"real-job",
        "target":target,"pages":[{"kind":"carry","targetImportPageId":"page_1","oldPageId":"old-page","confirmReady":false}],"removedPages":[],"cues":[
        {"oldPageId":"old-page","actionId":"speech-1","cueId":"highlight","deleteCue":false,"targets":[
            {"oldObjectId":"old-object-0","decision":"keep","targetImportElementId":ids[0]["importElementId"]},
            {"oldObjectId":"old-object-1","decision":"rebind","targetImportElementId":ids[1]["importElementId"]}]},
        {"oldPageId":"old-page","actionId":"speech-1","cueId":"spotlight","deleteCue":false,"targets":[
            {"oldObjectId":"old-object-0","decision":"rebind","targetImportElementId":ids[1]["importElementId"]}]}]})).unwrap();
    (dir, cache, parsed, request)
}

#[test]
fn resolve_is_complete_deterministic_read_only_and_preserves_baseline_audio_and_actions() {
    let (dir, mut cache, parsed, mut request) = fixture();
    let original = serde_json::to_value(&cache.0.as_ref().unwrap().project).unwrap();
    let result = cache.resolve(dir.path(), parsed.clone(), &request).unwrap();
    let project = &result["project"];
    assert_eq!(project["teachingRevision"], original["teachingRevision"]);
    assert_eq!(
        project["source"],
        serde_json::to_value(&request.target.source).unwrap()
    );
    assert_eq!(project["pages"][0]["reviewState"], "review");
    let actions = &project["pages"][0]["actions"];
    assert_eq!(
        actions[0]["text"],
        original["pages"][0]["actions"][0]["text"]
    );
    assert_eq!(actions[0]["pauseAfterMs"], 1000);
    assert_eq!(actions[1], original["pages"][0]["actions"][1]);
    assert_eq!(actions[2], original["pages"][0]["actions"][2]);
    assert_eq!(
        result["assetIds"],
        json!([
            "55555555-5555-4555-8555-555555555555",
            "66666666-6666-4666-8666-666666666666"
        ])
    );
    assert_eq!(
        result["mapping"]["pages"][0]["objects"][0]["objectId"],
        "old-object-0"
    );
    let new_id = &result["mapping"]["pages"][0]["objects"][1]["objectId"];
    assert_ne!(new_id, "old-object-1");
    assert_eq!(
        actions[0]["visualCues"][0]["effect"]["elementIds"],
        json!(["old-object-0", new_id])
    );
    assert_eq!(actions[0]["visualCues"][1]["effect"]["elementId"], *new_id);
    assert_eq!(
        result["mapping"]["pages"][0]["objects"]
            .as_array()
            .unwrap()
            .len(),
        parsed.identity.as_ref().unwrap()["pages"][0]["objects"]
            .as_array()
            .unwrap()
            .len()
    );
    request.cues.reverse();
    request.cues[1].targets.reverse();
    request.job_id = "new-parser-job".into();
    assert_eq!(
        cache.resolve(dir.path(), parsed.clone(), &request).unwrap(),
        result
    );
    assert_eq!(
        serde_json::to_value(&cache.0.as_ref().unwrap().project).unwrap(),
        original
    );
    assert_eq!(cache.resolve(dir.path(), parsed, &request).unwrap(), result);
}

#[test]
fn resolve_requires_full_page_coverage_new_and_explicit_unlocked_deletion() {
    let (dir, mut cache, parsed, request) = fixture();
    let mut value = serde_json::to_value(&request).unwrap();
    value["pages"] = json!([{"kind":"new","targetImportPageId":"page_1","confirmReady":true}]);
    value["cues"] = json!([]);
    assert!(cache
        .resolve(
            dir.path(),
            parsed.clone(),
            &serde_json::from_value(value.clone()).unwrap()
        )
        .is_err());
    value["removedPages"] = json!([{"oldPageId":"old-page","confirmDelete":true}]);
    let result = cache
        .resolve(
            dir.path(),
            parsed.clone(),
            &serde_json::from_value(value.clone()).unwrap(),
        )
        .unwrap();
    assert_eq!(result["removedPageIds"], json!(["old-page"]));
    assert_eq!(result["assetIds"], json!([]));
    assert_eq!(result["project"]["pages"][0]["actions"], json!([]));
    assert_eq!(result["project"]["pages"][0]["reviewState"], "ready");
    assert_ne!(result["project"]["pages"][0]["pageId"], "old-page");
    cache.0.as_mut().unwrap().project.pages[0].locked = true;
    let review = cache
        .review(
            "chat-1",
            dir.path(),
            &request.baseline_id,
            parsed.clone(),
            request.target.clone(),
        )
        .unwrap();
    value["reviewId"] = review["reviewId"].clone();
    assert!(cache
        .resolve(dir.path(), parsed, &serde_json::from_value(value).unwrap())
        .is_err());
}

#[test]
fn resolve_partial_removal_preserves_cue_and_full_or_primary_removal_requires_delete() {
    let (dir, mut cache, parsed, request) = fixture();
    let mut value = serde_json::to_value(&request).unwrap();
    value["cues"][0]["targets"][1] = json!({"oldObjectId":"old-object-1","decision":"remove"});
    let result = cache
        .resolve(
            dir.path(),
            parsed.clone(),
            &serde_json::from_value(value.clone()).unwrap(),
        )
        .unwrap();
    assert_eq!(
        result["project"]["pages"][0]["actions"][0]["visualCues"][0]["effect"]["elementIds"],
        json!(["old-object-0"])
    );
    value["cues"][1]["targets"][0] = json!({"oldObjectId":"old-object-0","decision":"remove"});
    assert!(cache
        .resolve(
            dir.path(),
            parsed.clone(),
            &serde_json::from_value(value.clone()).unwrap()
        )
        .is_err());
    value["cues"][1]["deleteCue"] = json!(true);
    let result = cache
        .resolve(
            dir.path(),
            parsed.clone(),
            &serde_json::from_value(value.clone()).unwrap(),
        )
        .unwrap();
    assert_eq!(
        result["project"]["pages"][0]["actions"][0]["visualCues"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    value["cues"][0]["targets"][0] = json!({"oldObjectId":"old-object-0","decision":"remove"});
    assert!(cache
        .resolve(
            dir.path(),
            parsed.clone(),
            &serde_json::from_value(value.clone()).unwrap()
        )
        .is_err());
    value["cues"][0]["deleteCue"] = json!(true);
    assert_eq!(
        cache
            .resolve(dir.path(), parsed, &serde_json::from_value(value).unwrap())
            .unwrap()["project"]["pages"][0]["actions"][0]["visualCues"],
        json!([])
    );
}

#[test]
fn resolve_rejects_stale_context_unknown_duplicate_incomplete_or_unsupported_decisions() {
    let (dir, mut cache, parsed, request) = fixture();
    let value = serde_json::to_value(&request).unwrap();
    for case in 0..13 {
        let mut v = value.clone();
        match case {
            0 => v["reviewId"] = json!("wrong"),
            1 => v["sessionId"] = json!("other-chat"),
            2 => v["target"]["callbackId"] = json!("d".repeat(64)),
            3 => v["pages"] = json!([]),
            4 => v["pages"][0]["targetImportPageId"] = json!("unknown"),
            5 => v["pages"][0]["oldPageId"] = json!("unknown"),
            6 => v["cues"] = json!([]),
            7 => v["cues"][0]["targets"][0]["targetImportElementId"] = json!("missing"),
            8 => v["cues"][0]["targets"][0]["oldObjectId"] = json!("missing"),
            9 => v["cues"][1]["targets"][0]["decision"] = json!("keep"),
            10 => v["cues"][0]["deleteCue"] = json!(true),
            11 => v["removedPages"] = json!([{"oldPageId":"old-page","confirmDelete":true}]),
            _ => v["cues"][1]["cueId"] = json!("unknown"),
        }
        assert!(
            cache
                .resolve(
                    dir.path(),
                    parsed.clone(),
                    &serde_json::from_value(v).unwrap()
                )
                .is_err(),
            "case {case}"
        );
    }
    let mut v = value;
    v["pages"][0]["confirmReady"] = Value::Null;
    assert!(serde_json::from_value::<ResolveRequest>(v).is_err());
    assert!(bounded(json!("x".repeat(MAX_RESPONSE_BYTES)), MAX_RESPONSE_BYTES).is_err());
}

#[test]
fn resolve_uuid_music_can_feed_independent_snapshot_without_weakening_local_clips() {
    let (dir, mut cache, parsed, mut request) = fixture();
    match &mut request.pages[0] {
        PageDecision::Carry { confirm_ready, .. } => *confirm_ready = true,
        _ => unreachable!(),
    }
    let result = cache.resolve(dir.path(), parsed.clone(), &request).unwrap();
    let project: CoursewareProject = serde_json::from_value(result["project"].clone()).unwrap();
    assert!(project.validate().is_err());
    project.validate_online().unwrap();
    let mut mapping = result["mapping"].clone();
    mapping["sourceRevision"] = json!(project.source.revision);
    let assets = result["assetIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| {
            serde_json::from_value(json!({"id":id,"sha256":"a".repeat(64),"mimeType":"audio/mpeg"}))
                .unwrap()
        })
        .collect();
    let db = crate::db::Database::open(&dir.path().join("test.db")).unwrap();
    let record = db
        .import_online_courseware_snapshot(
            dir.path().to_str().unwrap(),
            &parsed,
            "snapshot-1",
            project,
            &mapping,
            assets,
        )
        .unwrap();
    record.validate().unwrap();
    assert_eq!(
        record.project.pages[0].actions[1]["audioAssetId"],
        "66666666-6666-4666-8666-666666666666"
    );
    assert!(db
        .get_courseware_project(dir.path().to_str().unwrap(), &record.project.project_id)
        .unwrap()
        .is_none());
}

#[test]
fn resolve_uses_explicit_import_ids_instead_of_decision_array_order() {
    let (dir, mut cache, mut parsed, mut request) = fixture();
    let mut copy = parsed.identity.as_ref().unwrap()["pages"][0].clone();
    copy["logicalId"] = json!("fresh-page-2");
    copy["importPageId"] = json!("page_2");
    for (index, object) in copy["objects"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        object["logicalId"] = json!(format!("fresh-object-{index}"));
    }
    parsed.identity.as_mut().unwrap()["pages"]
        .as_array_mut()
        .unwrap()
        .push(copy);
    parsed.pages = 2;
    request.review_id = cache
        .review(
            "chat-1",
            dir.path(),
            &request.baseline_id,
            parsed.clone(),
            request.target.clone(),
        )
        .unwrap()["reviewId"]
        .as_str()
        .unwrap()
        .into();
    request.pages = serde_json::from_value(json!([
        {"kind":"carry","targetImportPageId":"page_2","oldPageId":"old-page","confirmReady":false},
        {"kind":"new","targetImportPageId":"page_1","confirmReady":true}
    ]))
    .unwrap();
    let result = cache.resolve(dir.path(), parsed.clone(), &request).unwrap();
    assert_eq!(result["mapping"]["pages"][0]["importPageId"], "page_1");
    assert_ne!(result["project"]["pages"][0]["pageId"], "old-page");
    assert_eq!(result["project"]["pages"][0]["actions"], json!([]));
    assert_eq!(result["mapping"]["pages"][1]["pageId"], "old-page");
    request.pages.reverse();
    assert_eq!(
        cache.resolve(dir.path(), parsed.clone(), &request).unwrap(),
        result
    );
    request.pages[0] = request.pages[1].clone();
    assert!(cache.resolve(dir.path(), parsed, &request).is_err());
}
