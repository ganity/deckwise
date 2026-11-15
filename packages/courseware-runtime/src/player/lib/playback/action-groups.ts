import type { Action } from "../types/action";
import { validatePptxTimeline } from "./pptx-timeline";

export interface ActionExecutionGroup {
  anchor: Action;
  actions: Action[];
}

function isMeantimeAnimation(action: Action) {
  return (
    action.type === "element_animation" && action.pptistTrigger === "meantime"
  );
}

export function buildActionExecutionGroups(
  actions: Action[],
): ActionExecutionGroup[] {
  const timeline = validatePptxTimeline(actions);
  const groups: ActionExecutionGroup[] = [];
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (timeline.status === "valid" && action.pptxTimeline) {
      const stepId = action.pptxTimeline.stepId;
      const grouped = [action];
      while (actions[index + 1]?.pptxTimeline?.stepId === stepId) {
        grouped.push(actions[++index]);
      }
      groups.push({ anchor: action, actions: grouped });
      continue;
    }
    const previousGroup = groups.at(-1);
    if (
      isMeantimeAnimation(action) &&
      previousGroup?.anchor.type === "element_animation"
    ) {
      previousGroup.actions.push(action);
      continue;
    }
    groups.push({ anchor: action, actions: [action] });
  }
  return groups;
}
