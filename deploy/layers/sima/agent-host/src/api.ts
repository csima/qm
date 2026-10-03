import { INSTANCE_ID, INSTANCE_TYPES, MODEL_CREDENTIALS, SESSION_NAME } from "../shared/naming.js";
import { newApiKey, sha256Hex } from "./auth.ts";
import type { Caller, Env, InstanceConfig, InstanceRow } from "./env.ts";
import { can, parseSharing, type Permission } from "./policy.ts";
import { sealCredentials } from "./secrets.ts";
import {
  audit,
  auditBy,
  getInstance,
  getTask,
  getVersion,
  isTerminal,
  listInstances,
  listVersions,
  recentTasks,
} from "./store.ts";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_MESSAGE = 100_000;
const MAX_CREDENTIAL = 16_384;
const MAX_WAIT_S = 55;

export const json = (body: unknown, status = 200) => Response.json(body, { status });

async function body(req: Request): Promise<Record<string, unknown>> {
  const parsed = (await req.json().catch(() => null)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HttpError(400, "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function instanceFor(env: Env, caller: Caller, id: string, permission: Permission): Promise<InstanceRow> {
  const row = INSTANCE_ID.test(id) ? await getInstance(env, id) : null;
  if (!row || !can(caller, row, "view")) throw new HttpError(404, "no such instance");
  if (!can(caller, row, permission)) throw new HttpError(403, `you do not have ${permission} access to ${id}`);
  return row;
}

function stub(env: Env, id: string) {
  return env.INSTANCE.getByName(id);
}

function publicInstance(row: InstanceRow, caller: Caller) {
  return {
    id: row.id,
    agent: row.agent,
    version: row.version,
    owner: row.owner,
    size: row.size,
    status: row.status,
    lastError: row.last_error,
    sharing: can(caller, row, "admin") ? row.sharing : undefined,
    access: {
      message: can(caller, row, "message"),
      attach: can(caller, row, "attach"),
      admin: can(caller, row, "admin"),
    },
  };
}

async function listAgents(env: Env) {
  const agents = new Map<string, { agent: string; description: string; latest: string; versions: unknown[] }>();
  for (const v of await listVersions(env)) {
    const entry = agents.get(v.agent) ?? {
      agent: v.agent,
      description: v.manifest.description,
      latest: v.version,
      versions: [],
    };
    entry.versions.push({
      version: v.version,
      commit: v.commit_sha,
      createdAt: v.created_at,
      harness: v.manifest.harness,
      credentials: v.manifest.credentials,
    });
    agents.set(v.agent, entry);
  }
  return [...agents.values()];
}

async function createInstance(env: Env, ctx: ExecutionContext, caller: Caller, input: Record<string, unknown>) {
  if (!caller.admin) throw new HttpError(403, "only admins can create instances in this version");
  const id = String(input.id ?? "");
  if (!INSTANCE_ID.test(id)) throw new HttpError(400, "id must match ^[a-z][a-z0-9-]{1,40}$");
  const agent = String(input.agent ?? "");
  const version = await getVersion(env, agent, typeof input.version === "string" ? input.version : undefined);
  if (!version) throw new HttpError(404, `no built version of agent ${agent || "(missing)"}`);
  const size = typeof input.size === "string" ? input.size : version.manifest.instance;
  if (!INSTANCE_TYPES.includes(size)) throw new HttpError(400, `size must be one of ${INSTANCE_TYPES.join(", ")}`);
  const sessions = Array.isArray(input.sessions) ? input.sessions.map(String) : ["main"];
  if (!sessions.length || sessions.some((s) => !SESSION_NAME.test(s)) || new Set(sessions).size !== sessions.length)
    throw new HttpError(400, "sessions must be unique lowercase names");
  const credentials = (input.credentials ?? {}) as Record<string, unknown>;
  if (typeof credentials !== "object" || Array.isArray(credentials))
    throw new HttpError(400, "credentials must be an object");
  const declared = new Set(version.manifest.credentials.map((c) => c.name));
  for (const [name, value] of Object.entries(credentials)) {
    if (!declared.has(name) && !MODEL_CREDENTIALS.includes(name))
      throw new HttpError(400, `${name} is not a credential this agent declares`);
    if (typeof value !== "string" || !value || value.length > MAX_CREDENTIAL)
      throw new HttpError(400, `${name} must be a non-empty string`);
  }
  for (const c of version.manifest.credentials)
    if (c.required && !credentials[c.name]) throw new HttpError(400, `${c.name} is required: ${c.description}`);
  let sharing;
  try {
    sharing = parseSharing(input.sharing);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  const owner = typeof input.owner === "string" ? input.owner.toLowerCase() : caller.email;
  if (caller.via === "admin_token" && typeof input.owner !== "string") throw new HttpError(400, "owner is required");
  if (await getInstance(env, id)) throw new HttpError(409, `instance ${id} already exists`);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO instances (id, agent, version, owner, sharing, size, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?)",
  )
    .bind(id, agent, version.version, owner, JSON.stringify(sharing), size, now, now)
    .run();
  const config: InstanceConfig = {
    id,
    agent,
    version: version.version,
    harness: version.manifest.harness,
    size,
    sessions,
    credentials: await sealCredentials(env.CREDENTIALS_KEY, credentials as Record<string, string>, id),
  };
  await stub(env, id).configure(config);
  ctx.waitUntil(
    stub(env, id)
      .ensureRunning()
      .catch((e) => console.error(`boot ${id}: ${(e as Error).message}`)),
  );
  await audit(
    env,
    auditBy(caller, "instance.create", {
      instance: id,
      detail: { agent, version: version.version, owner, sharing, credentials: Object.keys(credentials) },
    }),
  );
  return json({ instance: publicInstance((await getInstance(env, id))!, caller) }, 201);
}

async function createTask(
  env: Env,
  ctx: ExecutionContext,
  caller: Caller,
  row: InstanceRow,
  input: Record<string, unknown>,
) {
  const message = input.message;
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MESSAGE)
    throw new HttpError(400, `message must be 1–${MAX_MESSAGE} characters`);
  const session = typeof input.session === "string" ? input.session : "main";
  if (!(await stub(env, row.id).sessions()).includes(session)) throw new HttpError(404, `no session named ${session}`);
  const callbackUrl = input.callback_url;
  if (callbackUrl !== undefined && (typeof callbackUrl !== "string" || !/^https:\/\/[^\s]+$/.test(callbackUrl)))
    throw new HttpError(400, "callback_url must be an https URL");
  const id = `t_${hex(10)}`;
  await env.DB.prepare(
    "INSERT INTO tasks (id, instance, session, caller, via, message, status, callback_url, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)",
  )
    .bind(id, row.id, session, caller.email, caller.via, message, callbackUrl ?? null, Date.now())
    .run();
  await audit(env, auditBy(caller, "task.create", { instance: row.id, session, detail: { task: id } }));
  ctx.waitUntil(
    stub(env, row.id)
      .enqueue({ id, session, caller: caller.email, via: caller.via, message })
      .catch((e) => console.error(`enqueue ${id}: ${(e as Error).message}`)),
  );
  return json({ task: await getTask(env, id) }, 202);
}

async function waitForTask(env: Env, caller: Caller, id: string, waitSeconds: number) {
  let task = /^t_[0-9a-f]{20}$/.test(id) ? await getTask(env, id) : null;
  if (!task) throw new HttpError(404, "no such task");
  if (task.caller !== caller.email) await instanceFor(env, caller, task.instance, "admin");
  const deadline = Date.now() + Math.min(MAX_WAIT_S, Math.max(0, waitSeconds)) * 1000;
  while (!isTerminal(task!.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    task = await getTask(env, id);
  }
  return json({ task });
}

async function mintKey(env: Env, caller: Caller, input: Record<string, unknown>) {
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

export function attachRequest(req: Request, row: InstanceRow, caller: Caller): Request {
  const url = new URL(req.url);
  const target = new URL(`https://instance/attach`);
  for (const k of ["session", "cols", "rows"]) {
    const v = url.searchParams.get(k);
    if (v) target.searchParams.set(k, v);
  }
  return new Request(target, {
    headers: {
      upgrade: "websocket",
      "x-agent-host-caller": caller.email,
      "x-agent-host-via": caller.via,
      "x-agent-host-instance": row.id,
    },
  });
}

export async function api(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  caller: Caller,
  path: string,
): Promise<Response> {
  const parts = path.split("/").filter(Boolean);
  const method = req.method;
  const [resource, id, sub] = parts;
  if (parts.length > 3) throw new HttpError(404, "not found");
  if (resource === "agents" && !id && method === "GET") return json({ agents: await listAgents(env) });
  if (resource === "keys" && !id && method === "POST") return mintKey(env, caller, await body(req));
  if (resource === "tasks" && id && !sub && method === "GET")
    return waitForTask(env, caller, id, Number(new URL(req.url).searchParams.get("wait") ?? 0));
  if (resource === "instances") {
    if (!id && method === "GET")
      return json({
        instances: (await listInstances(env))
          .filter((r) => can(caller, r, "view"))
          .map((r) => publicInstance(r, caller)),
      });
    if (!id && method === "POST") return createInstance(env, ctx, caller, await body(req));
    if (id && !sub && method === "GET") {
      const row = await instanceFor(env, caller, id, "view");
      return json({
        instance: publicInstance(row, caller),
        runtime: await stub(env, id)
          .status()
          .catch((e) => ({ error: (e as Error).message })),
        tasks: (await recentTasks(env, id)).filter((t) => t.caller === caller.email || can(caller, row, "admin")),
      });
    }
    if (sub === "tasks" && method === "POST")
      return createTask(env, ctx, caller, await instanceFor(env, caller, id, "message"), await body(req));
    if (sub === "sessions" && method === "POST") {
      await instanceFor(env, caller, id, "message");
      const name = String((await body(req)).name ?? "");
      const sessions = await stub(env, id)
        .addSession(name)
        .catch((e) => {
          throw new HttpError(400, (e as Error).message);
        });
      await audit(env, auditBy(caller, "session.create", { instance: id, session: name }));
      return json({ sessions }, 201);
    }
    if (sub === "restart" && method === "POST") {
      await instanceFor(env, caller, id, "admin");
      await audit(env, auditBy(caller, "instance.restart", { instance: id }));
      ctx.waitUntil(
        stub(env, id)
          .restart()
          .catch((e) => console.error(`restart ${id}: ${(e as Error).message}`)),
      );
      return json({ restarting: true }, 202);
    }
    if (sub === "upgrade" && method === "POST") {
      const row = await instanceFor(env, caller, id, "admin");
      const input = await body(req);
      const target = await getVersion(env, row.agent, typeof input.version === "string" ? input.version : undefined);
      if (!target) throw new HttpError(404, "no such version");
      if (target.manifest.harness !== (await getVersion(env, row.agent, row.version))?.manifest.harness)
        throw new HttpError(400, "upgrades cannot change the harness");
      await env.DB.prepare("UPDATE instances SET version = ?, updated_at = ? WHERE id = ?")
        .bind(target.version, Date.now(), id)
        .run();
      await audit(
        env,
        auditBy(caller, "instance.upgrade", { instance: id, detail: { from: row.version, to: target.version } }),
      );
      ctx.waitUntil(
        stub(env, id)
          .restart(target.version)
          .catch((e) => console.error(`upgrade ${id}: ${(e as Error).message}`)),
      );
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
  }
  throw new HttpError(404, "not found");
}
