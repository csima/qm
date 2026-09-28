import type { RuntimeChoice } from "./harness.ts";
import type { SessionEntry } from "../types.ts";
import { parseRuntimeChoice } from "../model/pi-models.ts";
import { isObj } from "../util/objects.ts";

export function recoveredRuntime(
  entries: readonly SessionEntry[],
  runId: string,
  actorId: string,
): RuntimeChoice | undefined {
  for (const entry of [...entries].reverse()) {
    const p = entry.payload;
    if (
      entry.type !== "tool_result" ||
      !isObj(p) ||
      p.tool !== "runtime" ||
      p.runId !== runId ||
      p.actorId !== actorId ||
      !isObj(p.runtimeHandoff)
    )
      continue;
    const choice = p.runtimeHandoff.choice;
    const parsed = isObj(choice) ? parseRuntimeChoice(choice) : undefined;
    if (parsed?.ok) return parsed.choice;
  }
  return undefined;
}
