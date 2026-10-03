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
