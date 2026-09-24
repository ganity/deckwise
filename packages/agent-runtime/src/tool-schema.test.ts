import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { withExplicitRequired } from "./tool-schema.js";

const tool = (parameters: unknown) => ({
  name: "Read",
  description: "Read",
  parameters,
}) as AgentTool;

describe("provider-facing tool schemas", () => {
  it("adds an empty required list to all-optional object parameters", () => {
    const input = tool(Type.Object({ path: Type.Optional(Type.String()) }));
    expect(input.parameters).not.toHaveProperty("required");
    expect(withExplicitRequired(input).parameters).toHaveProperty("required", []);
  });

  it("preserves required parameters and non-object schemas", () => {
    const required = tool(Type.Object({ path: Type.String() }));
    const union = tool({ anyOf: [{ type: "object" }] });
    expect(withExplicitRequired(required)).toBe(required);
    expect(withExplicitRequired(union)).toBe(union);
  });
});
