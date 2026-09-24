import type { AgentTool } from "@earendil-works/pi-agent-core";

export function withExplicitRequired(tool: AgentTool): AgentTool {
  const parameters = tool.parameters as { type?: unknown; required?: unknown };
  if (parameters.type !== "object" || parameters.required !== undefined) return tool;
  return {
    ...tool,
    parameters: Object.assign({}, tool.parameters, { required: [] }) as AgentTool["parameters"],
  };
}
