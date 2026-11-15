use super::*;
use serde_json::json;

pub(crate) const FIXTURE: &[u8] = include_bytes!("fixtures/identity.json");
const IR: &[u8] = include_bytes!("fixtures/slide-ir.json");

fn online_mapping(identity: &SavedSourceIdentity) -> Value {
    json!({ "revision":"online-mapping-1", "sourceRevision":"remote-source-1",
        "sourceSha256":identity.value()["sourceSha256"],
        "pages": identity.value()["pages"].as_array().unwrap().iter().enumerate().map(|(p, page)| json!({
            "pageId":format!("remote-page-{p}"), "importPageId":page["importPageId"],
            "objects":page["objects"].as_array().unwrap().iter().enumerate().map(|(o, object)| json!({
                "objectId":format!("remote-object-{p}-{o}"), "importElementId":object["importElementId"]
            })).collect::<Vec<_>>()
        })).collect::<Vec<_>>() })
}

#[test]
fn online_mapping_preserves_exact_fresh_identity_and_remote_ids() {
    let identity = SavedSourceIdentity::parse(FIXTURE).unwrap();
    let mapping = online_mapping(&identity);
    let bound = identity.bind_mapping(&mapping).unwrap();
    assert!(bound.same_export(&identity));
    assert_eq!(bound.value()["mappingRevision"], mapping["revision"]);
    assert_eq!(bound.value()["pages"][0]["logicalId"], "remote-page-0");
    assert_eq!(
        bound.value()["pages"][0]["objects"][3]["logicalId"],
        "remote-object-0-3"
    );
    assert!(bound.bind_mapping(&mapping).is_err());
}

#[test]
fn online_mapping_rejects_incomplete_reordered_unknown_and_duplicate_bindings() {
    let identity = SavedSourceIdentity::parse(FIXTURE).unwrap();
    for case in 0..12 {
        let mut mapping = online_mapping(&identity);
        match case {
            0 => mapping["sourceSha256"] = json!("a".repeat(64)),
            1 => mapping["sourceRevision"] = Value::Null,
            2 => mapping["revision"] = json!("../unsafe"),
            3 => mapping["pages"][0]["importPageId"] = json!("wrong"),
            4 => mapping["pages"][0]["objects"]
                .as_array_mut()
                .unwrap()
                .reverse(),
            5 => {
                mapping["pages"][0]["objects"].as_array_mut().unwrap().pop();
            }
            6 => {
                mapping["pages"][0]["objects"][1]["objectId"] =
                    mapping["pages"][0]["objects"][0]["objectId"].clone()
            }
            7 => {
                mapping["pages"][0]["objects"][0]["objectId"] =
                    mapping["pages"][0]["pageId"].clone()
            }
            8 => mapping["pages"][0]["objects"][0]["objectId"] = json!(".."),
            9 => mapping["pages"][0]["unknown"] = json!(true),
            10 => mapping["pages"][0]["objects"][0]["contentFingerprint"] = json!("a".repeat(64)),
            _ => mapping["pages"].as_array_mut().unwrap().clear(),
        }
        assert!(identity.bind_mapping(&mapping).is_err(), "case {case}");
    }
}

#[test]
fn online_mapping_rejects_page_reorder_even_when_page_count_is_equal() {
    let mut value: Value = serde_json::from_slice(FIXTURE).unwrap();
    let mut second = value["pages"][0].clone();
    second["logicalId"] = json!("second-raw-page");
    second["importPageId"] = json!("page_2");
    for (i, object) in second["objects"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        object["logicalId"] = json!(format!("second-raw-object-{i}"));
    }
    value["pages"].as_array_mut().unwrap().push(second);
    let identity = SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).unwrap();
    let mut mapping = online_mapping(&identity);
    assert!(identity.bind_mapping(&mapping).is_ok());
    mapping["pages"].as_array_mut().unwrap().reverse();
    assert!(identity.bind_mapping(&mapping).is_err());
}

#[test]
fn d2f_envelope_binds_complete_host_ids_without_changing_fingerprints() {
    let identity = SavedSourceIdentity::parse(FIXTURE).unwrap();
    identity
        .check_ir(&serde_json::from_slice(IR).unwrap())
        .unwrap();
    let bound = identity.bind(&["host-page"]).unwrap();
    assert_eq!(bound.value()["pages"][0]["logicalId"], "host-page");
    assert!(bound.same_export(&identity));
    assert_ne!(
        bound.value()["pages"][0]["objects"][0]["logicalId"],
        identity.value()["pages"][0]["objects"][0]["logicalId"]
    );
    assert!(bound.value()["mappingRevision"].is_string());
    assert!(bound
        .check_ir(&serde_json::from_slice(IR).unwrap())
        .is_err());
    assert!(identity.bind(&[]).is_err());
}

#[test]
fn strict_envelope_rejects_invalid_limits_duplicates_and_optional_nulls() {
    let original: Value = serde_json::from_slice(FIXTURE).unwrap();
    for case in 0..13 {
        let mut value = original.clone();
        match case {
            0 => value["apiKey"] = json!("forged"),
            1 => value["sourceSha256"] = json!("A".repeat(64)),
            2 => value["mappingRevision"] = Value::Null,
            3 => {
                value["pages"][0]["objects"][1]["logicalId"] =
                    value["pages"][0]["objects"][0]["logicalId"].clone()
            }
            4 => {
                value["pages"][0]["objects"][1]["importElementId"] =
                    value["pages"][0]["objects"][0]["importElementId"].clone()
            }
            5 => value["pages"][0]["objects"][0]["sourceShapeId"] = Value::Null,
            6 => value["pages"][0]["objects"][0]["geometryFingerprint"] = json!("bad"),
            7 => {
                value["pages"][0]["objects"][0]["logicalId"] =
                    value["pages"][0]["logicalId"].clone()
            }
            8 => value["diagnostics"][0]["pageIndex"] = json!(-1),
            9 => value["diagnostics"][0]["severity"] = json!("unknown"),
            10 => value["pages"] = json!(vec![value["pages"][0].clone(); 101]),
            11 => {
                value["pages"][0]["objects"] =
                    json!(vec![value["pages"][0]["objects"][0].clone(); 10001])
            }
            _ => value["pages"][0]["logicalId"] = json!("😀".repeat(101)),
        }
        assert!(
            SavedSourceIdentity::parse(&serde_json::to_vec(&value).unwrap()).is_err(),
            "case {case}"
        );
    }
    assert!(SavedSourceIdentity::parse(&vec![b' '; MAX_BYTES as usize + 1]).is_err());
}

#[test]
fn worker_metadata_pins_bytes_source_and_complete_ir_before_admission() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("identity.json");
    std::fs::write(&path, FIXTURE).unwrap();
    let identity = SavedSourceIdentity::parse(FIXTURE).unwrap();
    let digest = hex::encode(Sha256::digest(FIXTURE));
    let ir: Value = serde_json::from_slice(IR).unwrap();
    let report = json!({"identitySchemaVersion": SCHEMA, "identitySha256": digest, "sourceSha256": identity.value()["sourceSha256"]});
    assert_eq!(
        verify_worker(temp.path(), &report, &ir).unwrap(),
        Some(digest.clone())
    );
    assert!(verify_worker(temp.path(), &json!({}), &ir)
        .unwrap()
        .is_none());
    for case in 0..6 {
        let mut report = report.clone();
        let mut ir = ir.clone();
        match case {
            0 => report["identitySha256"] = json!("a".repeat(64)),
            1 => {
                report.as_object_mut().unwrap().remove("identitySha256");
            }
            2 => report["sourceSha256"] = json!("b".repeat(64)),
            3 => ir["pages"][0]["id"] = json!("page_2"),
            4 => ir["pages"][0]["elements"]
                .as_array_mut()
                .unwrap()
                .pop()
                .map(|_| ())
                .unwrap(),
            _ => ir["pages"][0]["elements"][0]["type"] = json!("image"),
        }
        assert!(
            verify_worker(temp.path(), &report, &ir).is_err(),
            "case {case}"
        );
    }
    std::fs::write(&path, b"{}").unwrap();
    assert!(read(
        temp.path(),
        &digest,
        identity.value()["sourceSha256"].as_str().unwrap(),
        1
    )
    .is_err());
    #[cfg(unix)]
    {
        std::fs::remove_file(&path).unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(outside.path(), FIXTURE).unwrap();
        std::os::unix::fs::symlink(outside.path(), &path).unwrap();
        assert!(verify_worker(temp.path(), &report, &ir).is_err());
    }
}
