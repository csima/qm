import type { Caller, InstanceRow, Sharing } from "./env.ts";

export type Permission = "view" | "message" | "attach" | "admin";

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

export function can(caller: Caller, row: Pick<InstanceRow, "owner" | "sharing">, permission: Permission): boolean {
  if (caller.admin || caller.email === row.owner) return true;
  const { message, attach, admin } = row.sharing;
  const has = (list: string[]) => list.includes(caller.email) || list.includes("*");
  if (has(admin)) return true;
  if (permission === "message") return has(message);
  if (permission === "attach") return has(attach);
  if (permission === "view") return has(message) || has(attach);
  return false;
}

export function influencers(row: Pick<InstanceRow, "owner" | "sharing">): string[] {
  const { message, attach, admin } = row.sharing;
  return [...new Set([row.owner, ...message, ...attach, ...admin])];
}

export function callAllowed(
  person: string,
  source: Pick<InstanceRow, "owner" | "sharing">,
  target: Pick<InstanceRow, "owner" | "sharing">,
): boolean {
  const asPerson = (email: string): Caller => ({ email, via: "agent", admin: false });
  return (
    [person, ...influencers(source)].every((email) => can(asPerson(email), target, "message")) &&
    influencers(target).every((email) => can(asPerson(email), source, "message"))
  );
}

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

export function parseEmailList(raw: unknown, label: string): string[] {
  const list = raw ?? [];
  if (!Array.isArray(list)) throw new Error(`${label} must be a list of emails`);
  return [
    ...new Set(
      list.map((e) => {
        const value = typeof e === "string" ? e.trim().toLowerCase() : "";
        if (!(value === "*" || EMAIL.test(value))) throw new Error(`${label} has an invalid entry`);
        return value;
      }),
    ),
  ];
}

export function parseSharing(input: unknown): Sharing {
  const value = (input ?? {}) as Record<string, unknown>;
  return {
    message: parseEmailList(value.message, "sharing.message"),
    attach: parseEmailList(value.attach, "sharing.attach"),
    admin: parseEmailList(value.admin, "sharing.admin"),
  };
}

export const MODEL_HOSTS = ["api.anthropic.com"];

export function hostAllowed(host: string, allow: string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allow.some((pattern) => (pattern.startsWith("*.") ? name.endsWith(pattern.slice(1)) : name === pattern));
}

export function modelKey(headers: Headers): string | null {
  return headers.get("x-api-key") ?? /^Bearer (\S+)$/i.exec(headers.get("authorization") ?? "")?.[1] ?? null;
}

const MODEL_POST_PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);

function fetchesElsewhere(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((v) => fetchesElsewhere(v, depth + 1));
  if (!value || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  if ("mcp_servers" in node) return true;
  if (typeof node.type === "string" && /^web_fetch/.test(node.type)) return true;
  const source = node.source as { type?: unknown } | undefined;
  if (source && typeof source === "object" && source.type === "url") return true;
  return Object.entries(node).some(
    ([key, v]) => key !== "input" && key !== "input_schema" && fetchesElsewhere(v, depth + 1),
  );
}

export function modelRequestBody(
  method: string,
  path: string,
  headers: Headers,
  body: string | null,
): { body: string | null } | null {
  const encoding = headers.get("content-encoding");
  if (encoding && encoding !== "identity") return null;
  if (method === "GET" || method === "HEAD") return { body: null };
  if (method !== "POST" || !MODEL_POST_PATHS.has(path) || body === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || fetchesElsewhere(parsed)) return null;
  return { body: JSON.stringify(parsed) };
}
