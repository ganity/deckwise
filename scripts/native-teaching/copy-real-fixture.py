"""Copy one explicitly selected local project, never its private provider receipts."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import uuid
import xml.etree.ElementTree as ET
import zipfile


def copy_fixture(profile, workspace, output):
    output.mkdir(parents=True, exist_ok=False)
    db = sqlite3.connect(f'file:{profile / "pi.sqlite"}?mode=ro', uri=True)
    with db:
        rows = [(key, json.loads(value)) for key, value in db.execute(
            'SELECT key,value_json FROM kv WHERE ns=?', ('coursewareProjects.v1',))
            if json.loads(key)[0] == str(workspace)]
        if len(rows) != 1:
            raise ValueError('Select a workspace containing exactly one teaching project')
        key, project = rows[0]
        digest = project['source']['sha256']
        identity_key = json.dumps([key, digest], separators=(',', ':'), ensure_ascii=False)
        identity_row = db.execute('SELECT value_json FROM kv WHERE ns=? AND key=?',
                                 ('coursewareIdentities.v1', identity_key)).fetchone()
        if not identity_row:
            raise ValueError('Missing exact source identity')
        identity = json.loads(identity_row[0])
        classroom_row = db.execute('SELECT value_json FROM kv WHERE ns=? AND key=?', ('coursewareClassrooms.v1', key)).fetchone()
        classroom = json.loads(classroom_row[0])['classroom'] if classroom_row else None
        audio = {json.loads(v)['audio']['sha256']: json.loads(v)['audio'] for (v,) in db.execute(
            'SELECT value_json FROM kv WHERE ns=? AND key LIKE ?', ('coursewareTtsAudio.v1', '%' + str(workspace) + '%'))}
    source = next((p for p in workspace.glob('.deckwise-ppt/revisions/**/document.pptx')
                   if hashlib.sha256(p.read_bytes()).hexdigest() == digest), None)
    if not source:
        raise ValueError('No archived PPTX matches the teaching source hash')
    shutil.copyfile(source, output / 'original.pptx')
    media = []
    for asset in sorted({a['audioAssetId'] for page in project['pages'] for a in page['actions'] if a.get('audioAssetId')}):
        if not asset.startswith('tts-') or asset[4:] not in audio:
            raise ValueError('Unresolved adopted audio')
        sha = asset[4:]
        data = (profile / 'courseware-assets' / (sha + '.bin')).read_bytes()
        record = audio[sha]
        if hashlib.sha256(data).hexdigest() != sha or len(data) != record['byteLength']:
            raise ValueError('Audio digest mismatch')
        media.append(dict(id=asset, sha256=sha, mimeType=record['mimeType'], byteLength=len(data),
                          durationMs=record['durationMs'], data=__import__('base64').b64encode(data).decode()))
    # The selected source also keeps Quiz/assessment narration outside the old
    # teaching project. Convert these pages to the new native checkpoint format.
    assessment_pages = 0
    if classroom:
        by_id = {m['id']: m for m in media}
        scenes = classroom['scenes']
        if len(scenes) != len(project['pages']):
            raise ValueError('Classroom/native page count differs')
        for page, scene in zip(project['pages'], scenes):
            checkpoints = [a for a in scene.get('actions', []) if a['type'] == 'interaction_checkpoint']
            quiz = scene.get('content', {}).get('type') == 'quiz'
            if not quiz and not checkpoints:
                continue
            assessment_pages += 1
            converted = []
            for action in scene.get('actions', []):
                if action['type'] != 'speech':
                    continue
                # The same unvoiced prompt already belongs to the teacher checkpoint.
                if not action.get('audioId') and any(checkpoint.get('question') == action['text'] for checkpoint in checkpoints):
                    continue
                speech = dict(id=action['id'], type='speech', text=action['text'], source='original')
                asset = action.get('audioId')
                if asset:
                    if asset not in by_id:
                        manifest = [m for m in classroom.get('audioManifest', []) if m.get('sceneId') == scene['id'] and m.get('actionId') == action['id']]
                        if len(manifest) != 1 or not asset.startswith('tts-'):
                            raise ValueError('Unresolved assessment audio')
                        relative = Path(manifest[0]['url'])
                        path = (workspace / relative).resolve()
                        if relative.is_absolute() or not path.is_relative_to(workspace.resolve()):
                            raise ValueError('Assessment audio must be workspace local')
                        data = path.read_bytes()
                        sha = hashlib.sha256(data).hexdigest()
                        if asset != 'tts-' + sha:
                            raise ValueError('Assessment audio digest mismatch')
                        # ffprobe performs a local decode/probe, without a media service.
                        import subprocess
                        duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(path)]))
                        item = dict(id=asset, sha256=sha, mimeType=manifest[0]['mimeType'], byteLength=len(data), durationMs=round(duration*1000), data=__import__('base64').b64encode(data).decode())
                        media.append(item); by_id[asset] = item
                    speech['audioAssetId'] = asset
                converted.append(speech)
            if quiz:
                for question in scene['content']['questions']:
                    kind = question['type']
                    options = question.get('options', [])
                    answers = question.get('answer', [])
                    if isinstance(answers, str):
                        answers = [answers]
                    response = dict(kind=kind, options=[o['label'] for o in options], answerIndices=[i for i,o in enumerate(options) if o['value'] in answers])
                    converted.append(dict(id='quiz-' + question['id'], type='interaction_checkpoint', checkpointId=question['id'], checkpointKind='chapter_summary',
                        chapterId=scene['stageId'], chapterTitle=scene['title'], question=question['question'], response=response,
                        referenceAnswer=dict(summary=question.get('explanation', ''), keyPoints=[]), context=dict(chapterSummary=scene['title'], sourceSceneIds=[scene['id']])))
            else:
                for checkpoint in checkpoints:
                    portable = {key: value for key, value in checkpoint.items() if key != 'constraintPrompt'}
                    if checkpoint.get('constraintPrompt'):
                        portable['context'] = dict(portable['context'])
                        portable['context']['chapterSummary'] += '\n' + checkpoint['constraintPrompt']
                    converted.append(portable)
            page['actions'] = converted
    if classroom:
        scene_pages = {scene['id']: page['pageId'] for scene, page in zip(classroom['scenes'], project['pages'])}
        for page in project['pages']:
            for action in page['actions']:
                if action.get('context', {}).get('sourceSceneIds'):
                    action['context']['sourceSceneIds'] = [scene_pages.get(source, source) for source in action['context']['sourceSceneIds']]
        adopted = {action['audioId'] for scene in classroom['scenes'] for action in scene.get('actions', []) if action.get('audioId')}
        if adopted - {asset['id'] for asset in media}:
            raise ValueError('Classroom adopted audio omitted from native package')
    identity = dict(pages=[dict(pageId=page['pageId'], objects=original['objects'])
                          for page, original in zip(project['pages'], identity['pages'])])
    # A content revision identifies the teaching payload, not the self-containing PPTX.
    envelope = dict(schemaVersion='deckwise-native-teaching/1', documentId=str(uuid.uuid4()),
                    revision=str(uuid.uuid4()), pages=project['pages'], identity=identity, media=media)
    media_parts = [(m["id"], m["sha256"], m.pop("data")) for m in media]
    root = ET.Element('{urn:deckwise:native-teaching:1}teaching')
    root.text = json.dumps(envelope, ensure_ascii=False, separators=(',', ':'))
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(output / 'native.pptx', 'w', zipfile.ZIP_DEFLATED) as dst:
        for name in src.namelist():
            data = src.read(name)
            if name == 'ppt/_rels/presentation.xml.rels':
                rels = ET.fromstring(data)
                ET.SubElement(rels, '{http://schemas.openxmlformats.org/package/2006/relationships}Relationship',
                              Id='rIdDeckwiseNativeTeaching', Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml', Target='../customXml/deckwise-native.xml')
                for index in range(len(media_parts)):
                    ET.SubElement(rels, '{http://schemas.openxmlformats.org/package/2006/relationships}Relationship',
                                  Id=f'rIdDeckwiseNativeMedia{index}', Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml', Target=f'../customXml/deckwise-media-{index}.xml')
                data = ET.tostring(rels, encoding='utf-8', xml_declaration=True)
            dst.writestr(name, data)
        dst.writestr('customXml/deckwise-native.xml', ET.tostring(root, encoding='utf-8', xml_declaration=True))
        for index, (asset_id, sha256, data) in enumerate(media_parts):
            part = ET.Element('{urn:deckwise:native-teaching-media:1}media')
            part.text = json.dumps(dict(id=asset_id, sha256=sha256, data=data), separators=(',', ':'))
            dst.writestr(f'customXml/deckwise-media-{index}.xml', ET.tostring(part, encoding='utf-8', xml_declaration=True))
    (output / 'teaching.json').write_text(json.dumps(envelope, ensure_ascii=False), encoding='utf-8')
    report = dict(source=str(source), sourceSha256=digest, pages=len(envelope['pages']),
                  actions=sum(len(p['actions']) for p in envelope['pages']), media=len(media),
                  assessmentPages=assessment_pages, mediaBytes=sum(m['byteLength'] for m in media), schema=envelope['schemaVersion'])
    (output / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    copy_fixture(args.profile, args.workspace, args.output)
