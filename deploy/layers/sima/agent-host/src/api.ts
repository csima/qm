import { requireUse, setUseList, usableAgents } from "./access.ts";
import { parseChange, personalNames, updatePersonal } from "./credentials.ts";
import type { Caller, Env } from "./env.ts";
import { HttpError, json, readBody } from "./http.ts";
import {
  attachRequest,
  boot,
  createInstance,
  instanceCredentials,
  instanceFor,
  oneOffId,
  prepareRestart,
  publicInstance,
  setSharing,
  stub,
  updateInstanceCredentials,
} from "./instances.ts";
import { listKeys, mintKey, revokeKey } from "./keys.ts";
import { can } from "./policy.ts";
import { audit, auditBy, getTask, getVersion, listInstances, recentTasks } from "./store.ts";
import { TASK_ID, pollTask, submitTask, validateTask } from "./tasks.ts";

export { HttpError, json } from "./http.ts";
export { attachRequest, instanceFor } from "./instances.ts";

const MAX_WAIT_S = 55;

async function waitForTask(env: Env, caller: Caller, id: string, waitSeconds: number) {
  const task = TASK_ID.test(id) ? await getTask(env, id) : null;
  if (!task) throw new HttpError(404, "no such task");
  if (task.caller !== caller.email) await instanceFor(env, caller, task.instance, "admin");
  const deadline = Date.now() + Math.min(MAX_WAIT_S, Math.max(0, waitSeconds || 0)) * 1000;
  return json({ task: await pollTask(env, id, deadline) });
}

async function agentsRoute(req: Request, env: Env, ctx: ExecutionContext, caller: Caller, name?: string, sub?: string) {
  if (!name && req.method === "GET") return json({ agents: await usableAgents(env, caller) });
  if (name && sub === "access" && req.method === "PUT")
    return json({ agent: name, use: await setUseList(env, caller, name, (await readBody(req)).use) });
  if (name && sub === "run" && req.method === "POST") {
    const input = await readBody(req);
    const valid = validateTask({ message: input.message, callbackUrl: input.callback_url });
    const row = await createInstance(env, ctx, caller, {
      id: oneOffId(name),
      agent: name,
      version: input.version,
      credentials: input.credentials,
      ephemeral: true,
    });
    const task = await submitTask(env, ctx, caller, row, {
      message: valid.message,
      callbackUrl: valid.callbackUrl ?? undefined,
    }).catch((error) => {
      ctx.waitUntil(
        stub(env, row.id)
          .teardown("the one-off task could not be submitted")
          .catch(() => undefined),
      );
      throw error;
    });
    return json({ instance: publicInstance(row, caller), task }, 202);
  }
  throw new HttpError(404, "not found");
}

async function credentialsRoute(req: Request, env: Env, caller: Caller, agent?: string) {
  if (!agent && req.method === "GET") {
    const saved = await personalNames(env, caller.email);
    const agents = await usableAgents(env, caller);
    return json({
      credentials: agents.map((a) => ({
        agent: a.agent,
        declared: a.credentials,
        model: a.modelCredentials,
        saved: saved.get(a.agent) ?? [],
      })),
    });
  }
  if (agent && req.method === "PUT") {
    await requireUse(env, caller, agent);
    const version = await getVersion(env, agent);
    if (!version) throw new HttpError(404, `no agent named ${agent}`);
    const change = parseChange(await readBody(req), version.manifest);
    return json({ agent, saved: await updatePersonal(env, caller, agent, version.manifest, change) });
  }
  throw new HttpError(404, "not found");
}

async function instancesRoute(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  caller: Caller,
  id?: string,
  sub?: string,
) {
  const method = req.method;
  if (!id && method === "GET")
    return json({
      instances: (await listInstances(env)).filter((r) => can(caller, r, "view")).map((r) => publicInstance(r, caller)),
    });
  if (!id && method === "POST") {
    const input = await readBody(req);
    const row = await createInstance(env, ctx, caller, {
      id: String(input.id ?? ""),
      agent: String(input.agent ?? ""),
      version: input.version,
      size: input.size,
      sessions: input.sessions,
      credentials: input.credentials,
      sharing: input.sharing,
      owner: input.owner,
      ephemeral: false,
    });
    return json({ instance: publicInstance(row, caller) }, 201);
  }
  if (!id) throw new HttpError(404, "not found");
  if (!sub && method === "GET") {
    const row = await instanceFor(env, caller, id, "view");
    return json({
      instance: publicInstance(row, caller),
      runtime: await stub(env, id)
        .status()
        .catch((e) => ({ error: (e as Error).message })),
      tasks: (await recentTasks(env, id)).filter((t) => t.caller === caller.email || can(caller, row, "admin")),
    });
  }
  if (sub === "tasks" && method === "POST") {
    const row = await instanceFor(env, caller, id, "message");
    const input = await readBody(req);
    const task = await submitTask(env, ctx, caller, row, {
      message: input.message,
      session: input.session,
      callbackUrl: input.callback_url,
    });
    return json({ task }, 202);
  }
  if (sub === "sessions" && method === "POST") {
    await instanceFor(env, caller, id, "admin");
    const name = String((await readBody(req)).name ?? "");
    const sessions = await stub(env, id)
      .addSession(name)
      .catch((e) => {
        throw new HttpError(400, (e as Error).message);
      });
    await audit(env, auditBy(caller, "session.create", { instance: id, session: name }));
    return json({ sessions }, 201);
  }
  if (sub === "sharing" && method === "PUT") {
    const row = await instanceFor(env, caller, id, "admin");
    return json({ sharing: await setSharing(env, caller, row, await readBody(req)) });
  }
  if (sub === "credentials" && method === "GET")
    return json(await instanceCredentials(env, await instanceFor(env, caller, id, "admin")));
  if (sub === "credentials" && method === "PUT") {
    const row = await instanceFor(env, caller, id, "admin");
    return json(await updateInstanceCredentials(env, caller, row, await readBody(req)));
  }
  if (sub === "restart" && method === "POST") {
    await instanceFor(env, caller, id, "admin");
    await prepareRestart(env, id);
    await audit(env, auditBy(caller, "instance.restart", { instance: id }));
    ctx.waitUntil(boot(env, id));
    return json({ restarting: true }, 202);
  }
  if (sub === "upgrade" && method === "POST") {
    const row = await instanceFor(env, caller, id, "admin");
    const input = await readBody(req);
    const target = await getVersion(env, row.agent, typeof input.version === "string" ? input.version : undefined);
    if (!target) throw new HttpError(404, "no such version");
    if (target.manifest.harness !== (await getVersion(env, row.agent, row.version))?.manifest.harness)
      throw new HttpError(400, "upgrades cannot change the harness");
    await prepareRestart(env, id, target.version);
    await env.DB.prepare("UPDATE instances SET version = ?, updated_at = ? WHERE id = ?")
      .bind(target.version, Date.now(), id)
      .run();
    await audit(
      env,
      auditBy(caller, "instance.upgrade", { instance: id, detail: { from: row.version, to: target.version } }),
    );
    ctx.waitUntil(boot(env, id));
    return json({ upgrading: true, from: row.version, to: target.version }, 202);
  }
  if (sub === "attach" && method === "GET") {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "expected a websocket");
    const row = await instanceFor(env, caller, id, "attach");
    return stub(env, id).fetch(attachRequest(req, row, caller));
  }
  if (sub === "audit" && method === "GET") {
    await instanceFor(env, caller, id, "admin");
    const limit = Math.min(500, Math.max(1, Number(new URL(req.url).searchParams.get("limit") ?? 100) || 100));
    const { results } = await env.DB.prepare("SELECT * FROM audit WHERE instance = ? ORDER BY id DESC LIMIT ?")
      .bind(id, limit)
      .all();
    return json({ audit: results });
  }
  throw new HttpError(404, "not found");
}

export async function api(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  caller: Caller,
  path: string,
): Promise<Response> {
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 3) throw new HttpError(404, "not found");
  const [resource, id, sub] = parts;
  switch (resource) {
    case "agents":
      return agentsRoute(req, env, ctx, caller, id, sub);
    case "credentials":
      if (sub) break;
      return credentialsRoute(req, env, caller, id);
    case "instances":
      return instancesRoute(req, env, ctx, caller, id, sub);
    case "tasks":
      if (id && !sub && req.method === "GET")
        return waitForTask(env, caller, id, Number(new URL(req.url).searchParams.get("wait") ?? 0));
      break;
    case "keys":
      if (!id && req.method === "POST") return mintKey(env, caller, await readBody(req));
      if (!id && req.method === "GET") return listKeys(env, caller);
      if (id && !sub && req.method === "DELETE") return revokeKey(env, caller, id);
      break;
  }
  throw new HttpError(404, "not found");
}
