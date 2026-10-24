import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { Check } from "typebox/value";

type Host = { call<T>(method: string, params: unknown): Promise<T> };
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._-]+$" });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const shortText = () => Type.Optional(Type.String({ maxLength: 500 }));
const education = Type.Object({ schoolStage: shortText(), grade: shortText(), subject: shortText(),
  customSubjectName: shortText(), textbookVersion: shortText(), chapter: shortText(), lessonType: shortText(),
  fullEnglishTeaching: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
const definitions = [
  { name: "courseware_workflow_get", label: "Read courseware workflow", parameters: Type.Object({}, { additionalProperties: false }),
    description: "Read this Chat's saved task, teaching settings, current scene plan, approval, image models, jobs and exact missing assets. Read before continuing. Unapproved plans require human review in the main Chat. Never claim an operation completed from prose." },
  { name: "courseware_requirements_update", label: "Save courseware requirements", parameters: Type.Object({
    expectedEducationContext: education, educationContext: education,
  }, { additionalProperties: false }),
    description: "Save confirmed audience/grade/subject/language answers for this task before plan approval or source attachment. Read the saved educationContext first (use {} if absent), preserve fields not requested to change, and pass the complete replacement. Cannot change task type. Refuses stale answers, approved plans or attached PPTX; these require an explicit later revision workflow." },
  { name: "courseware_scene_image_prepare", label: "Prepare courseware image", parameters: Type.Object({
    planSha256: hash, pageId: Type.String({ pattern: "^scene-[0-9]{3}$" }), model: id,
    target: Type.Union([Type.Object({ kind: Type.Union([Type.Literal("visualMaster"), Type.Literal("cleanPlate")]) }, { additionalProperties: false }),
      Type.Object({ kind: Type.Literal("layer"), name: Type.String({ minLength: 1, maxLength: 80 }) }, { additionalProperties: false })]),
    instructions: Type.Optional(Type.String({ maxLength: 1200 })), referenceIntentId: Type.Optional(id),
  }, { additionalProperties: false }),
    description: "Prepare one missing scene image for the latest approved plan. Use a model advertised by courseware_workflow_get. Read existing jobs first and do not duplicate prepared/submitted requests. Background and foreground layers need a selected visualMaster reference and a reference-capable model. This saves a request only; no paid submission. The main Chat displays a real quotation and human confirmation." },
  { name: "courseware_scene_image_refresh", label: "Refresh courseware image", parameters: Type.Object({ intentId: id }, { additionalProperties: false }),
    description: "Query an existing image task without submitting or retrying it. Archive verified ready/settled image bytes for human preview/selection in Chat. Unknown submission outcomes remain status-only. Do not poll indefinitely or claim selection before the user selects it." },
  { name: "courseware_scene_compile", label: "Build editable courseware", parameters: Type.Object({ planSha256: hash }, { additionalProperties: false }),
    description: "Compile the approved scene plan and human-selected assets into editable PPTX and page narration. Read workflow readiness first; report missing assets rather than inventing them. Does not generate or charge for images, approve a plan, select assets, publish, or overwrite Office edits. Never retry an uncertain compilation automatically." },
];

export function createCoursewareWorkflowTools(host: Host, sessionId: string, getTurnId: () => string | undefined): AgentTool[] {
  return definitions.map(definition => ({ ...definition, executionMode: "sequential",
    async execute(toolCallId, input, signal) {
      if (!Check(definition.parameters, input)) throw new Error("Invalid courseware workflow input");
      const turnId = getTurnId();
      if (!turnId) throw new Error("Courseware tools require an active Chat turn");
      signal?.throwIfAborted();
      const abort = () => { void host.call("tools.abort", { sessionId, toolCallId }).catch(() => undefined); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await host.call<{ ok: boolean; content: unknown; errorCode?: string }>("tools.execute", {
          sessionId, turnId, toolCallId, toolName: definition.name, mode: "agent", args: structuredClone(input),
          ...(definition.name === "courseware_scene_compile" ? { timeoutMs: 16 * 60_000 } : {}),
        });
        signal?.throwIfAborted();
        if (getTurnId() !== turnId) throw new Error("Courseware Chat turn changed; read saved workflow before continuing");
        if (!result || result.ok !== true) throw new Error(`${result?.errorCode ?? "COURSEWARE_WORKFLOW_FAILED"}: ${JSON.stringify(result?.content)}`);
        return { content: [{ type: "text", text: JSON.stringify(result.content) }], details: result.content };
      } finally { signal?.removeEventListener("abort", abort); }
    },
  }));
}
