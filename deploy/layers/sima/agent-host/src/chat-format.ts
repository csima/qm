import type { Caller, InstanceRow } from "./env.ts";
import { can } from "./policy.ts";
import type { TaskRow } from "./store.ts";

export const PRIVATE_SUFFIX = "+private";

interface ChatMessage {
  role?: string;
  content?: unknown;
}

export function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const last = [...(messages as ChatMessage[])].reverse().find((m) => m?.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content))
    return last.content
      .map((part) =>
        part && typeof part === "object" && (part as { type?: string }).type === "text"
          ? String((part as { text?: unknown }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  return "";
}

export function modelsFor(caller: Caller | null, rows: InstanceRow[]): string[] {
  if (!caller) return [];
  return rows
    .filter((r) => !r.ephemeral && can(caller, r, "message"))
    .flatMap((r) => (can(caller, r, "admin") ? [r.id, `${r.id}${PRIVATE_SUFFIX}`] : [r.id]));
}

export function replyText(task: TaskRow, row: InstanceRow, publicUrl: string): string {
  if (task.status === "done") return task.result ?? "";
  if (task.status === "failed") return `The agent could not finish this: ${task.error ?? "unknown error"}`;
  return `Still working on it (task ${task.id}). Follow it at ${publicUrl}/i/${row.id} and ask again for the result later.`;
}
