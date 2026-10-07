import type { Toolset } from "./config.ts";

export const TOOL_NAMES = ["current_time", "sleep", "random_numbers"] as const;
export type ToolName = typeof TOOL_NAMES[number];

const DEPLOYMENT_TOOLS: Record<Toolset, readonly ToolName[]> = {
  sleep: Object.freeze(["current_time", "sleep"]),
  random: Object.freeze(["random_numbers"]),
  tinytools: Object.freeze([...TOOL_NAMES]),
};

export class ToolSelectionError extends Error {}

export function deploymentTools(toolset: Toolset): readonly ToolName[] {
  return DEPLOYMENT_TOOLS[toolset];
}

// Normalize once into a bounded, immutable inventory. URL order and duplicates
// cannot change registration order or grow the per-isolate handler cache.
export function normalizeToolSelection(toolset: Toolset, requested: readonly string[]): readonly ToolName[] {
  const allowed = deploymentTools(toolset);
  if (requested.length === 0 || requested.some((name) => name.trim() === "")) {
    throw new ToolSelectionError("The tools parameter must select at least one tool and contain no empty names.");
  }
  const selected = new Set<ToolName>();
  for (const entry of requested) {
    const name = entry.trim();
    if (!TOOL_NAMES.includes(name as ToolName)) {
      throw new ToolSelectionError(`Unknown tool ${JSON.stringify(name)}. Allowed tools: ${allowed.join(", ")}.`);
    }
    if (!allowed.includes(name as ToolName)) {
      throw new ToolSelectionError(`Tool ${JSON.stringify(name)} is unavailable on this deployment. Allowed tools: ${allowed.join(", ")}.`);
    }
    selected.add(name as ToolName);
  }
  return Object.freeze(allowed.filter((name) => selected.has(name)));
}

export function selectTools(toolset: Toolset, params: URLSearchParams): readonly ToolName[] {
  const selections = params.getAll("tools");
  if (selections.length === 0) return deploymentTools(toolset);
  if (selections.length !== 1) {
    throw new ToolSelectionError("Provide the tools parameter only once, using comma-separated tool names.");
  }
  return normalizeToolSelection(toolset, selections[0]!.split(","));
}
