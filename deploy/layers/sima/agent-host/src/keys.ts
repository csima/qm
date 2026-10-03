import { newApiKey, sha256Hex } from "./auth.ts";
import type { Caller, Env } from "./env.ts";
import { HttpError, hex, json } from "./http.ts";
import { audit, auditBy } from "./store.ts";

export async function mintKey(env: Env, caller: Caller, input: Record<string, unknown>) {
  const owner = caller.admin && typeof input.owner === "string" ? input.owner.toLowerCase() : caller.email;
  if (caller.via === "admin_token" && typeof input.owner !== "string") throw new HttpError(400, "owner is required");
  const label = typeof input.label === "string" ? input.label.slice(0, 100) : "api key";
  const key = newApiKey();
  const id = `k_${hex(8)}`;
  await env.DB.prepare("INSERT INTO api_keys (id, hash, owner, label, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, await sha256Hex(key), owner, label, Date.now())
    .run();
  await audit(env, auditBy(caller, "key.create", { detail: { id, owner, label } }));
  return json({ id, owner, label, key }, 201);
}

export async function listKeys(env: Env, caller: Caller) {
  const { results } = await env.DB.prepare(
    "SELECT id, owner, label, created_at, revoked_at FROM api_keys WHERE owner = ? ORDER BY created_at DESC",
  )
    .bind(caller.email)
    .all();
  return json({ keys: results });
}

export async function revokeKey(env: Env, caller: Caller, id: string) {
  const row = await env.DB.prepare("SELECT owner, revoked_at FROM api_keys WHERE id = ?")
    .bind(id)
    .first<{ owner: string; revoked_at: number | null }>();
  if (!row || (row.owner !== caller.email && !caller.admin)) throw new HttpError(404, "no such key");
  if (!row.revoked_at)
    await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ?").bind(Date.now(), id).run();
  await audit(env, auditBy(caller, "key.revoke", { detail: { id, owner: row.owner } }));
  return json({ revoked: id });
}
