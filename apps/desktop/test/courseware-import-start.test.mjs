import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const exports={};
new Function('exports',ts.transpileModule(readFileSync(new URL('../src/components/courseware/import-start.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText)(exports);
const {isImportedEditorPath,importTeachingSummary}=exports;
test('editor path matches workspace-relative events without accepting another workspace or traversal',()=>{
 assert(isImportedEditorPath('/workspace/.deckwise-ppt/imports/a.pptx','.deckwise-ppt/imports/a.pptx','/workspace'));
 assert(isImportedEditorPath('C:\\workspace\\a.pptx','a.pptx','C:\\workspace'));
 assert(isImportedEditorPath('/workspace/a.pptx','/workspace/a.pptx','/workspace'));
 assert(!isImportedEditorPath('/workspace/a.pptx','a.pptx','/other'));
 assert(!isImportedEditorPath('/workspace/a.pptx','../workspace/a.pptx','/other'));
 assert(!isImportedEditorPath('/workspace/a.pptx','b.pptx','/workspace'));
});
test('saved progress does not count blank speech or missing audio as complete',()=>{
 const result=importTeachingSummary({project:{pages:[{actions:[]},{actions:[{type:'speech',text:'Hello',audioAssetId:'tts-a'}]},{actions:[{type:'speech',text:'World'},{type:'interaction_checkpoint',checkpointKind:'chapter_summary'}]},{actions:[{type:'speech',text:' ',audioAssetId:'tts-b'}]}]}});
 assert.deepEqual(result,{total:4,narration:2,audio:1,activities:1});
});
