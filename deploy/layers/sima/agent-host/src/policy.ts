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

export function parseSharing(input: unknown): Sharing {
  const value = (input ?? {}) as Record<string, unknown>;
  const list = (key: keyof Sharing): string[] => {
    const raw = value[key] ?? [];
    if (!Array.isArray(raw)) throw new Error(`sharing.${key} must be a list of emails`);
    return [
      ...new Set(
        raw.map((e) => {
          if (typeof e !== "string" || !(e === "*" || EMAIL.test(e)))
            throw new Error(`sharing.${key} has an invalid entry`);
          return e.toLowerCase();
        }),
      ),
    ];
  };
  return { message: list("message"), attach: list("attach"), admin: list("admin") };
}
