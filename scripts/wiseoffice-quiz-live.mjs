import { requireEditorContext, getEditorContext } from '@/lib/agent-plugin/editor-bridge';
import { preloadSlidePng, validateSlidePng } from '@/lib/agent-plugin/slide-image-png';
import { withBlockingEditorAction } from '@/lib/agent-plugin/editor-action';
import { preserveNativeRedo } from '@/lib/agent-plugin/native-redo';
import { readSlideShapeText } from '@/lib/agent-plugin/slide-text-read';

/** Main supplies a validated fixed Quiz projection, never arbitrary scripts or URLs. */
export async function applyQuizPage(payload, bridge) {
  const { binding, editGeneration, page, previous, next, assets } = payload;
  const context = bridge.getContext(binding);
  if (context.readOnly || context.page !== page || context.editGeneration !== editGeneration)
    throw new Error('Quiz target changed; refresh before saving');
  if (!previous || !next || previous.slideId !== next.slideId || !Array.isArray(previous.elements) ||
      !Array.isArray(next.elements) || next.elements.length > 64 || previous.elements.length > 64)
    throw new Error('Invalid Quiz projection');
  const native = requireEditorContext(), { api, presentationBuilder: builder, AscCommon: common, Asc } = native;
  const logic = api.WordControl?.m_oLogicDocument, slide = logic?.Slides?.[page - 1], history = common?.History;
  if (!slide || !builder || !history || api.canEdit?.() !== true || logic.CanEdit?.() !== true ||
      logic.IsMasterMode?.() !== false || api.isSlideShow?.() || common.CollaborativeEditing?.Get_GlobalLock() ||
      history._getLongPointIndex?.() !== -1 || logic.IsSelectionLocked(common.changestype_Drawing_Props))
    throw new Error('Quiz page is not writable');
  const originals = [...slide.cSld.spTree];
  const byName = new Map();
  for (const shape of originals) {
    const name = shape.getObjectName();
    if (byName.has(name)) throw new Error('Duplicate native Quiz object name');
    byName.set(name, shape);
  }
  for (const element of previous.elements) {
    if (!byName.has(element.id)) throw new Error('Quiz object binding changed; refresh before saving');
  }
  const old = new Map(previous.elements.map(element => [element.id, element]));
  const changed = next.elements.filter(element => JSON.stringify(element) !== JSON.stringify(old.get(element.id)) ||
    element.type === 'image_layer');
  const replace = new Set([...changed.map(element => element.id), ...previous.elements.filter(element =>
    !next.elements.some(next => next.id === element.id)).map(element => element.id)]);
  const same = () => getEditorContext()?.api === api && logic.Slides[page - 1] === slide && api.getCurrentPage() === page - 1;
  const assertCurrent = () => {
    const now = bridge.getContext(binding);
    if (!same() || now.editGeneration !== editGeneration || slide.cSld.spTree.length !== originals.length ||
        originals.some((shape, index) => slide.cSld.spTree[index] !== shape)) throw new Error('Quiz page changed during image preparation');
  };
  const scaleX = logic.GetWidthMM() / next.canvas.width, scaleY = logic.GetHeightMM() / next.canvas.height;
  if (![scaleX, scaleY].every(value => Number.isFinite(value) && value > 0)) throw new Error('Invalid Quiz canvas');
  return withBlockingEditorAction(api, { BlockInteraction: Asc.c_oAscAsyncActionType.BlockInteraction,
    ApplyChanges: Asc.c_oAscAsyncAction.ApplyChanges }, async () => {
    const images = new Map();
    for (const element of changed) {
      if (!['native_text', 'native_shape', 'image_layer'].includes(element.type) ||
          typeof element.id !== 'string' || !element.id.startsWith(`${next.slideId}_`) ||
          !Array.isArray(element.bboxPx) || element.bboxPx.length !== 4 || !element.bboxPx.every(Number.isFinite))
        throw new Error('Invalid live Quiz element');
      if (element.type !== 'image_layer') continue;
      const bytes = assets[element.assetId];
      const loaded = await preloadSlidePng(bytes, { api, common }, validateSlidePng(bytes));
      assertCurrent(); loaded.ready(); images.set(element.id, loaded);
    }
    assertCurrent();
    const beforeIndex = history.Index, beforePoints = [...history.Points], redo = preserveNativeRedo(history, same);
    let marker;
    const owns = () => same() && history.Index === beforeIndex + 1 && history.Points[beforeIndex + 1] === marker &&
      history._getLongPointIndex() === beforeIndex + 1;
    try {
      history.startGroupPoints(); marker = history.Points[beforeIndex + 1];
      if (!marker || !owns()) throw new Error('Quiz history is unavailable');
      const currentSlide = builder.GetPresentation().GetSlideByIndex(page - 1);
      const rgb = value => { const hex = value.replace('#', ''); return builder.CreateRGBColor(
        parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)); };
      // Build first; removal and insertion are one undoable native transaction.
      const created = new Map();
      for (const element of changed) {
        const [x, y, w, h] = element.bboxPx;
        let drawing;
        if (element.type === 'image_layer') {
          images.get(element.id).ready();
          drawing = logic.GetCurrentController().createImage(images.get(element.id).full, x * scaleX, y * scaleY, w * scaleX, h * scaleY);
          drawing.setParent(slide);
          drawing.setName(element.id);
        } else {
          const shape = builder.CreateShape(element.type === 'native_shape' ? 'roundRect' : 'rect', w * scaleX * 36000,
            h * scaleY * 36000, element.type === 'native_shape' ? builder.CreateSolidFill(rgb(element.fill)) : builder.CreateNoFill(),
            builder.CreateStroke(0, builder.CreateNoFill()));
          shape.SetPosition(x * scaleX * 36000, y * scaleY * 36000);
          drawing = shape.Drawing;
          drawing.setName(element.id);
          if (element.type === 'native_text') {
            shape.SetVerticalTextAlign('top'); shape.SetPaddings(0, 0, 0, 0);
            const content = shape.GetDocContent(); content.RemoveAllElements();
            for (const [index, line] of element.content.split(/\r?\n/u).entries()) {
              const paragraph = index ? builder.CreateParagraph() : content.GetElement(0);
              paragraph.AddText(line); paragraph.SetFontSize(element.style.fontSizePt * 2);
              paragraph.SetBold(element.style.fontWeight >= 600);
              paragraph.SetColor(...element.style.color.slice(1).match(/../gu).map(value => parseInt(value, 16)));
              paragraph.SetFontFamily(element.style.fontFace);
              if (index) content.Push(paragraph);
            }
          }
          // AddObject sets the native parent and registers the drawing with Office.
          if (!currentSlide.AddObject(shape)) throw new Error('Quiz object insertion failed');
          slide.removeFromSpTreeByPos(slide.cSld.spTree.indexOf(drawing));
        }
        created.set(element.id, drawing);
      }
      for (let index = originals.length - 1; index >= 0; index--)
        if (replace.has(originals[index].getObjectName())) slide.removeFromSpTreeByPos(index);
      for (const element of next.elements) {
        const drawing = created.get(element.id);
        if (!drawing) continue;
        drawing.setParent(slide);
        // Keep cards behind their labels/images and preserve unrelated native objects.
        const nextIndex = next.elements.indexOf(element);
        const following = next.elements.slice(nextIndex + 1).map(item => byName.get(item.id)).find(shape => slide.cSld.spTree.includes(shape));
        slide.addToSpTreeToPos(following ? slide.cSld.spTree.indexOf(following) : slide.cSld.spTree.length, drawing);
      }
      logic.Recalculate({ Drawings: { All: true, Map: {} } });
      if (!owns() || [...created].some(([name, drawing]) => !slide.cSld.spTree.includes(drawing) || drawing.getObjectName() !== name) ||
          next.elements.some(element => element.type === 'native_text' && created.has(element.id) &&
            readSlideShapeText(created.get(element.id))?.trimEnd() !== element.content.trimEnd()))
        throw new Error('Native Quiz update readback mismatch');
      history.endGroupPoints(); redo.discard();
      logic.Document_UpdateInterfaceState();
      logic.DrawingDocument.UpdateThumbnailsAttack();
      return { ...binding, page, editGeneration, applied: true };
    } catch (error) {
      marker ??= history.Points[beforeIndex + 1];
      if (owns() && beforePoints.slice(0, beforeIndex + 1).every((point, index) => history.Points[index] === point)) {
        history.cancelGroupPoints(); logic.Recalculate({ Drawings: { All: true, Map: {} } });
      }
      redo.restore(); logic.Document_UpdateInterfaceState(); throw error;
    }
  });
}
