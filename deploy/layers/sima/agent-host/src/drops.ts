import { sha256Hex } from "./auth.ts";
import { MAX_CREDENTIAL } from "./credentials.ts";
import type { Env } from "./env.ts";
import { HttpError, hex } from "./http.ts";
import { callAllowed } from "./policy.ts";
import { openCredentials, sealCredentials } from "./secrets.ts";
import { INACTIVE, audit, getInstance, getTask, type TaskRow } from "./store.ts";
import { TASK_ID } from "./tasks.ts";

const DROP_TTL_MS = 10 * 60_000;
const MAX_DROPS_PER_TASK = 5;
const HANDLE = /^sh_[0-9a-f]{32}$/;

export function recipientOf(task: Pick<TaskRow, "via" | "status">): string | null {
  if (task.status !== "running" && task.status !== "queued") return null;
  return task.via.startsWith("agent:") ? task.via.slice("agent:".length) : null;
}

const actor = (instance: string) => ({ actor: `instance:${instance}`, via: "agent" as const });

export async function putSecret(env: Env, instance: string, body: Record<string, unknown>) {
  const value = body.value;
  if (typeof value !== "string" || !value || value.length > MAX_CREDENTIAL)
    throw new HttpError(400, `value must be 1–${MAX_CREDENTIAL} characters`);
  const task = typeof body.task === "string" && TASK_ID.test(body.task) ? await getTask(env, body.task) : null;
  if (!task || task.instance !== instance)
    throw new HttpError(403, "a secret can only be handed over while handling the task that asked for it");
  const recipient = recipientOf(task);
  if (!recipient) throw new HttpError(403, "only another agent's open call can receive a secret handle");
  const target = await getInstance(env, recipient);
  if (!target || INACTIVE.includes(target.status)) throw new HttpError(404, `${recipient} is not active`);
  const giver = await getInstance(env, instance);
  if (!giver || !callAllowed(task.caller, target, giver))
    throw new HttpError(
      403,
      `${recipient} can no longer be handed secrets from here: its sharing changed since the call`,
    );
  const handle = `sh_${hex(16)}`;
  const id = await sha256Hex(handle);
  const now = Date.now();
  const inserted = await env.DB.prepare(
    "INSERT INTO secret_drops (id, sealed, from_instance, to_instance, task, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM secret_drops WHERE task = ?) < ?",
  )
    .bind(
      id,
      await sealCredentials(env.CREDENTIALS_KEY, { value }, `drop:${id}`),
      instance,
      recipient,
      task.id,
      now,
      now + DROP_TTL_MS,
      task.id,
      MAX_DROPS_PER_TASK,
    )
    .run();
  if (!inserted.meta?.changes)
    throw new HttpError(429, `at most ${MAX_DROPS_PER_TASK} secrets can be waiting for one call`);
  await audit(env, {
    ...actor(instance),
    action: "secret.put",
    instance,
    detail: { to: recipient, task: task.id, caller: task.caller },
  });
  return { handle, for: recipient, expiresAt: now + DROP_TTL_MS };
}

export async function redeemSecret(env: Env, instance: string, body: Record<string, unknown>) {
  const handle = typeof body.handle === "string" ? body.handle : "";
  if (!HANDLE.test(handle)) throw new HttpError(400, "that is not a secret handle");
  const id = await sha256Hex(handle);
  const row = await env.DB.prepare(
    "DELETE FROM secret_drops WHERE id = ? AND to_instance = ? AND expires_at > ? RETURNING sealed, from_instance, task",
  )
    .bind(id, instance, Date.now())
    .first<{ sealed: string; from_instance: string; task: string }>();
  if (!row) throw new HttpError(404, "no such handle for this instance (wrong recipient, already used, or expired)");
  const { value } = await openCredentials(env.CREDENTIALS_KEY, row.sealed, `drop:${id}`);
  await audit(env, {
    ...actor(instance),
    action: "secret.redeem",
    instance,
    detail: { from: row.from_instance, task: row.task },
  });
  return { value };
}

export async function sweepDrops(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM secret_drops WHERE expires_at <= ?").bind(Date.now()).run();
}
