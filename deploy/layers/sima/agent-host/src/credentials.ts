import { MODEL_CREDENTIALS } from "../shared/naming.js";
import type { Caller, Env, Manifest } from "./env.ts";
import { HttpError } from "./http.ts";
import { openCredentials, sealCredentials } from "./secrets.ts";
import { audit, auditBy } from "./store.ts";

export const MAX_CREDENTIAL = 16_384;

export interface CredentialChange {
  set: Record<string, string>;
  clear: string[];
}

export function allowedNames(manifest: Manifest): Set<string> {
  return new Set([...manifest.credentials.map((c) => c.name), ...MODEL_CREDENTIALS]);
}

export function parseChange(input: Record<string, unknown>, manifest: Manifest): CredentialChange {
  const allowed = allowedNames(manifest);
  const rawSet = input.set ?? {};
  const rawClear = input.clear ?? [];
  if (typeof rawSet !== "object" || rawSet === null || Array.isArray(rawSet))
    throw new HttpError(400, "set must be an object of NAME: value");
  if (!Array.isArray(rawClear)) throw new HttpError(400, "clear must be a list of names");
  const set: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawSet)) {
    if (!allowed.has(name)) throw new HttpError(400, `${name} is not a credential this agent declares`);
    if (typeof value !== "string" || !value || value.length > MAX_CREDENTIAL)
      throw new HttpError(400, `${name} must be a non-empty string of at most ${MAX_CREDENTIAL} characters`);
    set[name] = value;
  }
  const clear = rawClear.map(String);
  for (const name of clear)
    if (!allowed.has(name)) throw new HttpError(400, `${name} is not a credential this agent declares`);
  return { set, clear };
}

export function applyChange(current: Record<string, string>, change: CredentialChange): Record<string, string> {
  const next = { ...current, ...change.set };
  for (const name of change.clear) if (!(name in change.set)) delete next[name];
  return next;
}

export function missingRequired(manifest: Manifest, values: Record<string, string>): string[] {
  return manifest.credentials.filter((c) => c.required && !values[c.name]).map((c) => c.name);
}

const personalAad = (owner: string, agent: string) => `user:${owner}:${agent}`;

export async function personalCredentials(env: Env, owner: string, agent: string): Promise<Record<string, string>> {
  const row = await env.DB.prepare("SELECT sealed FROM user_credentials WHERE owner = ? AND agent = ?")
    .bind(owner, agent)
    .first<{ sealed: string }>();
  return row ? openCredentials(env.CREDENTIALS_KEY, row.sealed, personalAad(owner, agent)) : {};
}

export async function personalNames(env: Env, owner: string): Promise<Map<string, string[]>> {
  const { results } = await env.DB.prepare("SELECT agent, names FROM user_credentials WHERE owner = ?")
    .bind(owner)
    .all<{ agent: string; names: string }>();
  return new Map(results.map((r) => [r.agent, JSON.parse(r.names) as string[]]));
}

export async function updatePersonal(
  env: Env,
  caller: Caller,
  agent: string,
  manifest: Manifest,
  change: CredentialChange,
): Promise<string[]> {
  const next = applyChange(await personalCredentials(env, caller.email, agent), change);
  const names = Object.keys(next).sort();
  if (names.length) {
    await env.DB.prepare(
      "INSERT INTO user_credentials (owner, agent, sealed, names, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner, agent) DO UPDATE SET sealed = excluded.sealed, names = excluded.names, updated_at = excluded.updated_at",
    )
      .bind(
        caller.email,
        agent,
        await sealCredentials(env.CREDENTIALS_KEY, next, personalAad(caller.email, agent)),
        JSON.stringify(names),
        Date.now(),
      )
      .run();
  } else {
    await env.DB.prepare("DELETE FROM user_credentials WHERE owner = ? AND agent = ?").bind(caller.email, agent).run();
  }
  await audit(
    env,
    auditBy(caller, "credentials.personal", {
      detail: { agent, set: Object.keys(change.set), cleared: change.clear, declared: manifest.credentials.length },
    }),
  );
  return names;
}
