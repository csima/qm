import { adminEmails } from "./auth.ts";
import type { Caller, Env } from "./env.ts";
import { HttpError } from "./http.ts";
import { instanceFor } from "./instances.ts";
import { can } from "./policy.ts";
import { getInstance, getTask, listInstances, listVersions, type TaskRow } from "./store.ts";
import { TASK_ID, pollTask, submitTask } from "./tasks.ts";

export const MAX_DEPTH = 4;
export const MAX_OPEN_CALLS = 8;
const MAX_WAIT_S = 50;

export interface Principal {
  caller: Caller;
  parent: string | null;
  chain: string[];
}

export function nextChain(chain: string[], self: string, target: string): string[] {
  const next = [...chain, self];
  if (next.includes(target)) throw new HttpError(409, `calling ${target} would loop: ${[...next, target].join(" → ")}`);
  if (next.length > MAX_DEPTH)
    throw new HttpError(400, `agent calls can be at most ${MAX_DEPTH} deep: ${[...next, target].join(" → ")}`);
  return next;
}

export const callVia = (instance: string) => `agent:${instance}`;

export async function principal(env: Env, instance: string, parent: unknown): Promise<Principal> {
  const person = (email: string): Caller => ({ email, via: "agent", admin: adminEmails(env).has(email) });
  if (parent !== undefined && parent !== null && parent !== "") {
    const task = typeof parent === "string" && TASK_ID.test(parent) ? await getTask(env, parent) : null;
    if (!task || task.instance !== instance || (task.status !== "running" && task.status !== "queued"))
      throw new HttpError(403, "the task you are working on is not active on this instance");
    return {
      caller: person(task.caller),
      parent: task.id,
      chain: task.chain ? (JSON.parse(task.chain) as string[]) : [],
    };
  }
  const row = await getInstance(env, instance);
  if (!row) throw new HttpError(404, "this instance no longer exists");
  return { caller: person(row.owner), parent: null, chain: [] };
}

export async function registry(env: Env, instance: string, parent: unknown) {
  const who = await principal(env, instance, parent);
  const descriptions = new Map(
    (await listVersions(env)).map((v) => [`${v.agent} ${v.version}`, v.manifest.description]),
  );
  return {
    actingFor: who.caller.email,
    agents: (await listInstances(env))
      .filter((r) => r.id !== instance && !r.ephemeral && can(who.caller, r, "message"))
      .map((r) => ({
        instance: r.id,
        agent: r.agent,
        description: descriptions.get(`${r.agent} ${r.version}`) ?? "",
        status: r.status,
      })),
  };
}

export async function placeCall(env: Env, ctx: ExecutionContext, instance: string, body: Record<string, unknown>) {
  const who = await principal(env, instance, body.parent);
  const target = typeof body.target === "string" ? body.target : "";
  const row = await instanceFor(env, who.caller, target, "message");
  if (row.ephemeral) throw new HttpError(404, "one-off runs cannot be called");
  const chain = nextChain(who.chain, instance, target);
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE via = ? AND status IN ('queued', 'running')")
    .bind(callVia(instance))
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_CALLS)
    throw new HttpError(429, `this instance already has ${MAX_OPEN_CALLS} calls to other agents in progress`);
  const task = await submitTask(
    env,
    ctx,
    who.caller,
    row,
    { message: body.message, session: body.session },
    { parent: who.parent, chain },
  );
  return { call: callView(task), actingFor: who.caller.email };
}

export function callView(task: TaskRow) {
  return {
    id: task.id,
    instance: task.instance,
    status: task.status,
    result: task.result,
    error: task.error,
  };
}

export async function waitForCall(env: Env, instance: string, id: string, waitSeconds: number) {
  const task = TASK_ID.test(id) ? await getTask(env, id) : null;
  if (!task || task.via !== callVia(instance)) throw new HttpError(404, "no such call from this instance");
  const deadline = Date.now() + Math.min(MAX_WAIT_S, Math.max(0, waitSeconds || 0)) * 1000;
  return { call: callView(await pollTask(env, id, deadline)) };
}
