use super::*;
use crate::db::courseware_projects::asset_locks::ImageProof;

#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Context { session_id:String, project_id:String, page_id:String, expected_source_revision:String, expected_teaching_revision:String }
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Set { session_id:String, project_id:String, page_id:String, expected_source_revision:String, expected_teaching_revision:String,
    expected_lock_revision:Option<String>, object_id:String, locked:bool, proof:Option<ImageProof> }

pub(super) async fn handle(state:Arc<Mutex<AppState>>,method:&str,params:Value)->Result<Value,JsonRpcError>{
    let invalid=|e:serde_json::Error|rpc_err(1002,e.to_string(),"INVALID_PARAMS");
    if method=="courseware.assetLocks.context" {
        let p:Context=serde_json::from_value(params).map_err(invalid)?;
        let state=state.lock().await; let root=workspace(&state,&p.session_id)?;
        state.db.courseware_asset_lock_context(&root,&p.project_id,&p.page_id,&p.expected_source_revision,&p.expected_teaching_revision).map_err(error)
    } else {
        let p:Set=serde_json::from_value(params).map_err(invalid)?;
        let state=state.lock().await; let root=workspace(&state,&p.session_id)?;
        state.db.set_courseware_asset_lock(&root,&p.project_id,&p.page_id,&p.expected_source_revision,&p.expected_teaching_revision,
            p.expected_lock_revision.as_deref(),&p.object_id,p.locked,p.proof).map_err(error)
    }
}
