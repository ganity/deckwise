import { requireEditorContext, getEditorContext } from '@/lib/agent-plugin/editor-bridge';
import { withBlockingEditorAction } from '@/lib/agent-plugin/editor-action';
import { preserveNativeRedo } from '@/lib/agent-plugin/native-redo';
import { prepareQuizProjection } from '@/lib/agent-plugin/slide-quiz-projection';

/** Legacy classroom edits share the same native projection as carrier-owned Quiz edits. */
export async function applyQuizPage(payload, bridge) {
  const { binding, editGeneration, page } = payload, context = bridge.getContext(binding);
  if (context.readOnly || context.page !== page || context.editGeneration !== editGeneration) throw new Error('Quiz target changed; refresh before saving');
  const { api, AscCommon: common, Asc } = requireEditorContext(), logic = api.WordControl.m_oLogicDocument, history = common.History;
  return withBlockingEditorAction(api, { BlockInteraction: Asc.c_oAscAsyncActionType.BlockInteraction, ApplyChanges: Asc.c_oAscAsyncAction.ApplyChanges }, async () => {
    const change = await prepareQuizProjection(payload);
    if (bridge.getContext(binding).editGeneration !== editGeneration) throw new Error('Quiz page changed during image preparation');
    const beforeIndex = history.Index, beforePoints = [...history.Points], same = () => getEditorContext()?.api === api;
    const redo = preserveNativeRedo(history, same); let marker;
    const owns = () => same() && history.Index === beforeIndex + 1 && history.Points[beforeIndex + 1] === marker && history._getLongPointIndex() === beforeIndex + 1;
    try {
      history.startGroupPoints(); marker = history.Points[beforeIndex + 1];
      if (!marker || !owns()) throw new Error('Quiz history is unavailable');
      change.apply();
      if (!owns()) throw new Error('Quiz history changed');
      history.endGroupPoints(); redo.discard();
      return { ...binding, page, editGeneration, applied: true };
    } catch (error) {
      if (owns() && beforePoints.slice(0, beforeIndex + 1).every((point, index) => history.Points[index] === point)) history.cancelGroupPoints();
      redo.restore(); logic.Recalculate({ Drawings: { All: true, Map: {} } }); throw error;
    }
  });
}
