import type { Caller, Env, InstanceRow } from "./env.ts";
import { HttpError } from "./http.ts";
import { instanceFor } from "./instances.ts";
import { callAllowed } from "./policy.ts";
import { INACTIVE, getInstance, getTask, listInstances, listVersions, type TaskRow } from "./store.ts";
import { TASK_ID, pollTask, submitTask } from "./tasks.ts";

export const MAX_DEPTH = 4;
export const MAX_OPEN_CALLS = 8;
const MAX_WAIT_S = 50;

export interface Principal {
  source: InstanceRow;
  person: string;
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
  const row = await getInstance(env, instance);
  if (!row || INACTIVE.includes(row.status)) throw new HttpError(404, "this instance is not active");
  if (parent === undefined || parent === null || parent === "") {
    const busy = await env.DB.prepare(
      "SELECT 1 FROM tasks WHERE instance = ? AND status IN ('queued', 'running') LIMIT 1",
    )
      .bind(instance)
      .first();
    if (busy)
      throw new HttpError(409, "a task is in progress on this instance; make the call from the session handling it");
    return { source: row, person: row.owner, parent: null, chain: [] };
  }
  const task = typeof parent === "string" && TASK_ID.test(parent) ? await getTask(env, parent) : null;
  if (!task || task.instance !== instance || (task.status !== "running" && task.status !== "queued"))
    throw new HttpError(403, "the task you are working on is not active on this instance");
  return {
    source: row,
    person: task.caller,
    parent: task.id,
    chain: task.chain ? (JSON.parse(task.chain) as string[]) : [],
  };
}

const NOT_CALLABLE =
  "everyone who can message, attach to or administer this instance must be allowed to message the target, because any of them can steer this agent";

export async function registry(env: Env, instance: string, parent: unknown) {
  const who = await principal(env, instance, parent);
  const descriptions = new Map(
    (await listVersions(env)).map((v) => [`${v.agent} ${v.version}`, v.manifest.description]),
  );
  return {
    actingFor: who.person,
    agents: (await listInstances(env))
      .filter((r) => r.id !== instance && !r.ephemeral && callAllowed(who.person, who.source, r))
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
  const caller: Caller = { email: who.person, via: "agent", admin: false };
  const target = typeof body.target === "string" ? body.target : "";
  const row = await instanceFor(env, caller, target, "message");
  if (row.ephemeral) throw new HttpError(404, "one-off runs cannot be called");
  if (typeof body.session === "string" && body.session.startsWith("p-"))
    throw new HttpError(403, "agents cannot message private sessions");
  if (!callAllowed(who.person, who.source, row)) throw new HttpError(403, `cannot call ${target}: ${NOT_CALLABLE}`);
  const chain = nextChain(who.chain, instance, target);
  const task = await submitTask(
    env,
    ctx,
    caller,
    row,
    { message: body.message, session: body.session },
    { parent: who.parent, chain, maxOpen: MAX_OPEN_CALLS },
  );
  return { call: callView(task), actingFor: who.person };
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
