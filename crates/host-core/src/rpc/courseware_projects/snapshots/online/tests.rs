use super::*;

fn request() -> Value {
    let project: Value = serde_json::from_slice(include_bytes!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/shared/src/courseware-contract.fixtures/accepted.json"
    )))
    .unwrap();
    json!({ "sessionId":"chat-1", "jobId":"job-1", "snapshotId":"snapshot-1", "sourceByteLength":123,
        "project":project["project"], "mapping":{}, "assets":[] })
}

#[test]
fn online_import_envelope_rejects_unknown_fields_and_local_receipt_provenance() {
    let good = request();
    assert!(serde_json::from_value::<Import>(good.clone()).is_ok());
    for case in 0..5 {
        let mut value = good.clone();
        match case {
            0 => value["path"] = json!("/forged"),
            1 => value["sourceByteLength"] = json!(-1),
            2 => {
                value["assets"] = json!([{ "asset":{"id":"voice-1","sha256":"a".repeat(64),"mimeType":"audio/wav"}, "path":"voice.wav", "tts":{"principalKey":"x","intentId":"y"} }])
            }
            3 => {
                value["assets"] = json!([{ "asset":{"id":"voice-1","sha256":"a".repeat(64),"mimeType":"audio/wav"}, "music":null, "path":"voice.wav" }])
            }
            _ => {
                value.as_object_mut().unwrap().remove("sourceByteLength");
            }
        }
        assert!(
            serde_json::from_value::<Import>(value).is_err(),
            "case {case}"
        );
    }
}
