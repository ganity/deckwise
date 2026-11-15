import JSZip from 'jszip';
import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { crc32 } from 'node:zlib';
import { candidateHash } from '../page-candidate-baseline';
import { inspectPageImageAssets } from '../page-asset-locks';
import { generatePagePptxCandidate } from '../page-pptx-candidate';
import { generatePageStyleBatchCandidate } from '../page-style-batch-candidate';
import { compileSceneToPptx } from '../kindergarten/scene-to-pptx';
import { pageFixture, png } from './page-candidate-fixtures';

export async function fixture() {
  const original = await pageFixture(), zip = await JSZip.loadAsync(original.sourcePptx);
  const part = 'ppt/slides/slide2.xml';
  const picture = '<p:pic><p:nvPicPr><p:cNvPr id="3" name="Locked image"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdLocked"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="914400" y="1828800"/><a:ext cx="1828800" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
  zip.file(part, (await zip.file(part)!.async('string')).replace('</p:spTree>', picture+'</p:spTree>'));
  const rels = 'ppt/slides/_rels/slide2.xml.rels';
  zip.file(rels, (await zip.file(rels)!.async('string')).replace('</Relationships>', '<Relationship Id="rIdLocked" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/locked.png"/></Relationships>'));
  zip.file('ppt/media/locked.png', png);
  const sourcePptx = await zip.generateAsync({ type:'nodebuffer' });
  const baseline = {...original.baseline,sourceHash:candidateHash(sourcePptx)};
  const [image] = await inspectPageImageAssets(sourcePptx, part);
  const lock = {...image,objectId:'stable-image-id',assetSha256:image.assetSha256!};
  return {...original,sourcePptx,baseline,scene:{...original.scene,sourceHash:baseline.sourceHash,elements:[...original.scene.elements,
    {...original.scene.elements[0],id:'supporting-text',bboxPx:[80,400,1000,160],content:'B supporting editable text',zIndex:2}]},part,lock,picture};
}

describe('locked page images', () => {
  it('keeps an embedded image above eight MiB eligible for preservation', async () => {
    const f = await fixture(), zip = await JSZip.loadAsync(f.sourcePptx);
    const chunk = Buffer.alloc(9 * 1024 * 1024 + 12);
    chunk.writeUInt32BE(chunk.length - 12); chunk.write('caBX', 4);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
    const bytes = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
    zip.file('ppt/media/locked.png', bytes);
    const [image] = await inspectPageImageAssets(await zip.generateAsync({ type: 'nodebuffer' }), f.part);
    expect(image).toMatchObject({ eligible: true, assetSha256: candidateHash(bytes).slice(7) });
  });

  it('inspects and preserves a real Office-saved plain image without counting slide transitions as objects', async () => {
    // Captured from the real Main controller and compiled Office bridge. Office
    // writes mc:AlternateContent containing p:transition after p:cSld/spTree.
    const sourcePptx = await readFile(new URL('./fixtures/office-saved-plain-image.pptx', import.meta.url));
    expect(candidateHash(sourcePptx)).toBe('sha256:c17a85b10cc8b2eeb7c44d7715f41fe3f2b44a9075f9754e5a4eb7d6a0f24f27');
    const f = await fixture(), [image] = await inspectPageImageAssets(sourcePptx, f.part);
    expect(image).toMatchObject({eligible:true,zIndex:1});
    const baseline = {...f.baseline,sourceHash:candidateHash(sourcePptx)};
    const candidate = await generatePagePptxCandidate({...f,sourcePptx,baseline,target:{pageId:baseline.pageId,slidePart:f.part},instruction:'New style',
      preservedImages:[{...image,objectId:f.lock.objectId,assetSha256:image.assetSha256!}],getCurrentBaseline:async()=>baseline,
      generate:async()=>({scene:{...f.scene,sourceHash:baseline.sourceHash},assets:f.assets})});
    const retained = (await inspectPageImageAssets(candidate.pptx,f.part)).find(item=>item.assetSha256===image.assetSha256);
    expect(retained).toMatchObject({eligible:true,pictureSha256:image.pictureSha256,zIndex:image.zIndex});
  });

  it.each([
    '<a:effectLst><a:outerShdw blurRad="1000"/></a:effectLst>',
    '<a:effectDag/>',
    '<a:extLst/>',
    '<a:srcRect l="100"/>',
  ])('still rejects unsupported picture content in real Office output: %s', async unsupported => {
    const zip = await JSZip.loadAsync(await readFile(new URL('./fixtures/office-saved-plain-image.pptx', import.meta.url)));
    const part = 'ppt/slides/slide2.xml';
    zip.file(part,(await zip.file(part)!.async('string')).replace('</p:spPr></p:pic>',`${unsupported}</p:spPr></p:pic>`));
    const [image] = await inspectPageImageAssets(await zip.generateAsync({type:'nodebuffer'}),part);
    expect(image).toMatchObject({eligible:false,reason:expect.stringContaining('plain top-level')});
  });

  it('grafts the exact picture, media and layer into an editable candidate, renumbering only a colliding native id', async () => {
    const f = await fixture();
    expect(f.lock).toMatchObject({eligible:true,zIndex:1});
    const result = await generatePagePptxCandidate({...f,target:{pageId:f.baseline.pageId,slidePart:f.part},instruction:'New style',preservedImages:[f.lock],getCurrentBaseline:async()=>f.baseline,generate:async()=>({scene:f.scene,assets:f.assets})});
    const after=await JSZip.loadAsync(result.pptx), before=await JSZip.loadAsync(f.sourcePptx);
    expect(await after.file('ppt/media/locked.png')!.async('nodebuffer')).toEqual(png);
    expect(await after.file('ppt/slides/slide1.xml')!.async('string')).toBe(await before.file('ppt/slides/slide1.xml')!.async('string'));
    expect(await after.file('ppt/slides/slide3.xml')!.async('string')).toBe(await before.file('ppt/slides/slide3.xml')!.async('string'));
    const images=await inspectPageImageAssets(result.pptx,f.part);
    expect(images.find(image=>image.assetSha256===f.lock.assetSha256)).toMatchObject({pictureSha256:f.lock.pictureSha256,zIndex:f.lock.zIndex});
    expect(result.report.preservedImages).toEqual([expect.objectContaining({objectId:'stable-image-id',assetSha256:f.lock.assetSha256})]);
    expect(result.report.preservedImages![0].outputShapeId).not.toBe(f.lock.sourceShapeId);
    const xml=await after.file(f.part)!.async('string');
    expect(xml).toContain('B candidate'); expect(xml).toContain('Locked image');
    const ids=[...xml.matchAll(/<p:cNvPr id="([^"]+)"/gu)].map(match=>match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('refuses stale geometry/hash and duplicate identities rather than removing the lock', async () => {
    const f=await fixture(), generate=vi.fn(async()=>({scene:f.scene,assets:f.assets}));
    const input={...f,target:{pageId:f.baseline.pageId,slidePart:f.part},instruction:'New style',getCurrentBaseline:async()=>f.baseline,generate};
    for (const locks of [[{...f.lock,assetSha256:'0'.repeat(64)}],[{...f.lock,pictureSha256:'0'.repeat(64)}],[f.lock,f.lock]])
      await expect(generatePagePptxCandidate({...input,preservedImages:locks})).rejects.toThrow();
    expect(generate).not.toHaveBeenCalled();
  });

  it('makes cropped pictures visibly ineligible', async () => {
    const f=await fixture(),zip=await JSZip.loadAsync(f.sourcePptx);
    zip.file(f.part,(await zip.file(f.part)!.async('string')).replace('<a:stretch>','<a:srcRect l="100"/><a:stretch>'));
    const [image]=await inspectPageImageAssets(await zip.generateAsync({type:'nodebuffer'}),f.part);
    expect(image).toMatchObject({eligible:false,reason:expect.stringContaining('plain top-level')});
  });

  it('keeps the source image relationship when the compiler uses that same local rId, including the next redo', async () => {
    const f=await fixture(),compiled=await compileSceneToPptx(f.scene,f.assets),compiler=await JSZip.loadAsync(compiled.pptx);
    const relationships=await compiler.file('ppt/slides/_rels/slide1.xml.rels')!.async('string');
    const imageRel=relationships.match(/<Relationship\b[^>]*Type="[^"]+\/image"[^>]*\/>/u)![0];
    const id=imageRel.match(/\bId="([^"]+)"/u)![1];
    const zip=await JSZip.loadAsync(f.sourcePptx),relsPart='ppt/slides/_rels/slide2.xml.rels';
    let rels=await zip.file(relsPart)!.async('string'),slide=await zip.file(f.part)!.async('string');
    if(rels.includes(`Id="${id}"`)){
      rels=rels.replace(`Id="${id}"`,`Id="rIdOriginalCollision"`);
      for(const attribute of ['embed','id','link'])slide=slide.replaceAll(`r:${attribute}="${id}"`,`r:${attribute}="rIdOriginalCollision"`);
    }
    zip.file(relsPart,rels.replaceAll('rIdLocked',id));zip.file(f.part,slide.replaceAll('rIdLocked',id));
    let source=await zip.generateAsync({type:'nodebuffer'});
    const [original]=await inspectPageImageAssets(source,f.part);
    for(let revision=1;revision<=2;revision++){
      const [image]=await inspectPageImageAssets(source,f.part),baseline={...f.baseline,sourceRevision:revision,sourceHash:candidateHash(source)};
      const candidate=await generatePagePptxCandidate({...f,sourcePptx:source,baseline,target:{pageId:f.baseline.pageId,slidePart:f.part},instruction:'New style',
        preservedImages:[{objectId:f.lock.objectId,...image,assetSha256:image.assetSha256!}],getCurrentBaseline:async()=>baseline,generate:async()=>({scene:{...f.scene,sourceHash:baseline.sourceHash},assets:f.assets})});
      const out=await JSZip.loadAsync(candidate.pptx),ids=[...(await out.file(relsPart)!.async('string')).matchAll(/\bId="([^"]+)"/gu)].map(match=>match[1]);
      expect(new Set(ids).size).toBe(ids.length);
      const retained=(await inspectPageImageAssets(candidate.pptx,f.part)).find(image=>image.assetSha256===original.assetSha256)!;
      expect(retained).toMatchObject({pictureSha256:original.pictureSha256,zIndex:original.zIndex});
      expect(await out.file(f.part)!.async('string')).toContain(`r:embed="${id}"`);
      source=candidate.pptx;
    }
  });

  it('real packaged worker exports unchanged locked image identity after native id collision; fixture is usable by Host', async () => {
    const f=await fixture(), temporary=await mkdtemp(path.join(os.tmpdir(),'locked-image-worker-'));
    try {
      const result=await generatePagePptxCandidate({...f,target:{pageId:f.baseline.pageId,slidePart:f.part},instruction:'New style',preservedImages:[f.lock],getCurrentBaseline:async()=>f.baseline,generate:async()=>({scene:f.scene,assets:f.assets})});
      const worker=path.join(path.resolve(process.env.DECKWISE_NATIVE_WORKER_DIRECTORY ?? '../../apps/desktop/resources/pptx-worker'), 'pptx-worker.mjs');
      const parse=async(name:string,bytes:Uint8Array)=>{
        const input=path.join(temporary,`${name}.pptx`),output=path.join(temporary,name);await writeFile(input,bytes);
        await promisify(execFile)(process.execPath,[worker,input,output],{maxBuffer:2*1024*1024});
        return JSON.parse(await readFile(path.join(output,'identity.json'),'utf8'));
      };
      const before=await parse('before',f.sourcePptx),after=await parse('after',result.pptx);
      const old=before.pages[1].objects.find((object:any)=>object.sourceShapeId===f.lock.sourceShapeId);
      const retained=result.report.preservedImages![0];
      const current=after.pages[1].objects.find((object:any)=>object.sourceShapeId===retained.outputShapeId);
      expect(old.type).toBe('image');expect(current.type).toBe('image');
      expect(current.contentFingerprint).toBe(old.contentFingerprint);expect(current.geometryFingerprint).toBe(old.geometryFingerprint);
      expect(before.pages[1].objects.indexOf(old)).toBe(f.lock.zIndex);expect(after.pages[1].objects.indexOf(current)).toBe(f.lock.zIndex);
      const secondBaseline={...f.baseline,sourceRevision:'8',sourceHash:result.hash,contentHash:candidateHash('B candidate')};
      const second=await generatePagePptxCandidate({...f,sourcePptx:result.pptx,baseline:secondBaseline,pageText:'B candidate',target:{pageId:f.baseline.pageId,slidePart:f.part},instruction:'Second new style',
        preservedImages:[{objectId:f.lock.objectId,sourceShapeId:retained.outputShapeId,assetSha256:f.lock.assetSha256,pictureSha256:f.lock.pictureSha256,zIndex:f.lock.zIndex}],
        getCurrentBaseline:async()=>secondBaseline,generate:async()=>({scene:{...f.scene,sourceHash:result.hash},assets:f.assets})});
      const secondIdentity=await parse('second',second.pptx),secondRetained=second.report.preservedImages![0];
      const secondImage=secondIdentity.pages[1].objects.find((object:any)=>object.sourceShapeId===secondRetained.outputShapeId);
      expect(secondImage.contentFingerprint).toBe(old.contentFingerprint);expect(secondImage.geometryFingerprint).toBe(old.geometryFingerprint);
      expect(secondIdentity.pages[1].objects.indexOf(secondImage)).toBe(f.lock.zIndex);
      expect((await inspectPageImageAssets(second.pptx,f.part)).find(image=>image.sourceShapeId===secondRetained.outputShapeId)).toMatchObject({pictureSha256:f.lock.pictureSha256});
      if (process.env.DECKWISE_LOCKED_IMAGES_FIXTURE) await writeFile(process.env.DECKWISE_LOCKED_IMAGES_FIXTURE,
        JSON.stringify({before,after,second:secondIdentity,lock:{sourceShapeId:f.lock.sourceShapeId,assetSha256:f.lock.assetSha256,pictureSha256:f.lock.pictureSha256,zIndex:f.lock.zIndex},outputShapeId:retained.outputShapeId,secondOutputShapeId:secondRetained.outputShapeId},null,2));
      if (process.env.DECKWISE_LOCKED_IMAGES_SOURCE) await writeFile(process.env.DECKWISE_LOCKED_IMAGES_SOURCE, f.sourcePptx);
    } finally { await rm(temporary,{recursive:true,force:true}); }
  },30000);

  it('batch restyles the unlocked siblings while preserving locked images and refuses a representative with different locks', async () => {
    const f=await fixture(),instruction='New style';
    const representative=await generatePagePptxCandidate({...f,target:{pageId:f.baseline.pageId,slidePart:f.part},instruction,preservedImages:[f.lock],getCurrentBaseline:async()=>f.baseline,generate:async()=>({scene:f.scene,assets:f.assets})});
    const project={schemaVersion:'deckwise-courseware/1',projectId:f.baseline.projectId,title:'Locked images',taskType:'plain',source:{revision:String(f.baseline.sourceRevision),sha256:f.baseline.sourceHash.slice(7)},teachingRevision:String(f.baseline.teachingRevision),
      pages:['first',f.baseline.pageId,'last'].map(pageId=>({pageId,actions:[],reviewState:'review',locked:false}))};
    const mapping={revision:'m1',sourceSha256:project.source.sha256,pages:project.pages.map((page,index)=>({pageId:page.pageId,importPageId:`page_${index+1}`,objects:[]}))};
    const targets=project.pages.slice(1).map((page,index)=>({context:{project,documentId:f.baseline.documentId,pageId:page.pageId,pageText:index?'Preserved third page':f.pageText,clean:true,readOnly:false},slidePart:`ppt/slides/slide${index+2}.xml`}));
    const rep={...representative,baseline:{...representative.baseline,sourceRevision:project.source.revision,teachingRevision:project.teachingRevision},reference:{candidateId:representative.candidateId,projectId:project.projectId,source:project.source,teachingRevision:project.teachingRevision,targetPageIds:[f.baseline.pageId],outputSha256:representative.hash.slice(7)}};
    const request={sourcePptx:f.sourcePptx,sourceMapping:mapping,representative:rep,instruction,preservedImages:{[f.baseline.pageId]:[{objectId:f.lock.objectId,sourceShapeId:f.lock.sourceShapeId,assetSha256:f.lock.assetSha256,pictureSha256:f.lock.pictureSha256,zIndex:f.lock.zIndex}]},
      confirmation:{representativeCandidateId:representative.candidateId,representativeOutputSha256:representative.hash.slice(7),instructionHash:candidateHash(instruction),pageIds:targets.map(t=>t.context.pageId)},targets,getCurrentContexts:async()=>targets.map(t=>t.context),
      generate:async(request:any)=>({scene:{...f.scene,slideId:request.pageId,sourceHash:request.sourceHash},assets:f.assets})};
    const output=await generatePageStyleBatchCandidate(request);
    const images=await inspectPageImageAssets(output.pptx,f.part);
    expect(images.find(image=>image.assetSha256===f.lock.assetSha256)).toMatchObject({pictureSha256:f.lock.pictureSha256,zIndex:f.lock.zIndex});
    expect(output.report.preservedImages).toHaveLength(1);expect(output.report.preservedImages[0].pageId).toBe(f.baseline.pageId);
    await expect(generatePageStyleBatchCandidate({...request,preservedImages:{}})).rejects.toThrow('Representative locked images changed');
  });
});
