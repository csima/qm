import type { Caller, Env, InstanceRow } from "./env.ts";
import { HttpError, hex } from "./http.ts";
import { sha256Hex } from "./auth.ts";
import { INACTIVE, audit, auditBy, getInstance, getTask, isTerminal, type TaskRow } from "./store.ts";

const MAX_MESSAGE = 100_000;
export const TASK_ID = /^t_[0-9a-f]{20}$/;

export interface TaskInput {
  message: unknown;
  session?: unknown;
  callbackUrl?: unknown;
}

export interface Delegation {
  parent: string | null;
  chain: string[];
  maxOpen: number;
}

export async function privateSession(email: string): Promise<string> {
  return `p-${(await sha256Hex(email)).slice(0, 12)}`;
}

export interface ValidTask {
  message: string;
  session: string;
  callbackUrl: string | null;
}

export function validateTask(input: TaskInput): ValidTask {
  const message = input.message;
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE)
    throw new HttpError(400, `message must be 1–${MAX_MESSAGE} characters`);
  const session = input.session ?? "main";
  if (typeof session !== "string") throw new HttpError(400, "session must be a name");
  const callbackUrl = input.callbackUrl;
  if (callbackUrl !== undefined && (typeof callbackUrl !== "string" || !/^https:\/\/[^\s]+$/.test(callbackUrl)))
    throw new HttpError(400, "callback_url must be an https URL");
  return { message, session, callbackUrl: (callbackUrl as string | undefined) ?? null };
}

export async function submitTask(
  env: Env,
  ctx: ExecutionContext,
  caller: Caller,
  row: InstanceRow,
  input: TaskInput,
  delegation?: Delegation,
): Promise<TaskRow> {
  const { message, session, callbackUrl } = validateTask(input);
  const stub = env.INSTANCE.getByName(row.id);
  if (!(await stub.sessions()).includes(session)) throw new HttpError(404, `no session named ${session}`);
  if (
    session.startsWith("p-") &&
    session !== (await privateSession(caller.email)) &&
    !caller.admin &&
    caller.email !== row.owner
  )
    throw new HttpError(403, `${session} is someone else's private session`);
  const id = `t_${hex(10)}`;
  const via = delegation ? `agent:${delegation.chain.at(-1)}` : caller.via;
  const inserted = await env.DB.prepare(
    `INSERT INTO tasks (id, instance, session, caller, via, message, status, callback_url, created_at, parent, chain)
     SELECT ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM instances WHERE id = ? AND status NOT IN ('paused', 'deleting', 'deleted'))
       AND (SELECT COUNT(*) FROM tasks WHERE via = ? AND status IN ('queued', 'running')) < ?`,
  )
    .bind(
      id,
      row.id,
      session,
      caller.email,
      via,
      message,
      callbackUrl,
      Date.now(),
      delegation?.parent ?? null,
      delegation ? JSON.stringify(delegation.chain) : null,
      row.id,
      via,
      delegation?.maxOpen ?? Number.MAX_SAFE_INTEGER,
    )
    .run();
  if (!inserted.meta?.changes) {
    const current = await getInstance(env, row.id);
    if (!current || INACTIVE.includes(current.status))
      throw new HttpError(409, `${row.id} is ${current?.status ?? "deleted"} and not taking messages`);
    throw new HttpError(429, `${via} already has ${delegation?.maxOpen} calls to other agents in progress`);
  }
  await audit(
    env,
    auditBy(caller, "task.create", {
      instance: row.id,
      session,
      detail: { task: id, ...(delegation ? { parent: delegation.parent, chain: delegation.chain } : {}) },
    }),
  );
  ctx.waitUntil(
    stub
      .enqueue({ id, session, caller: caller.email, via, message })
      .catch((e) => console.error(`enqueue ${id}: ${(e as Error).message}`)),
  );
  return (await getTask(env, id))!;
}

export async function pollTask(env: Env, id: string, deadline: number, onTick?: () => void): Promise<TaskRow> {
  let task = (await getTask(env, id))!;
  while (!isTerminal(task.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    onTick?.();
    task = (await getTask(env, id))!;
  }
  return task;
}
