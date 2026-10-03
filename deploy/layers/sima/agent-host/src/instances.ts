import { INSTANCE_ID, INSTANCE_TYPES, SESSION_NAME } from "../shared/naming.js";
import { requireUse } from "./access.ts";
import { allowedNames, missingRequired, parseChange, personalCredentials } from "./credentials.ts";
import type { Caller, Env, InstanceConfig, InstanceRow } from "./env.ts";
import { HttpError, asHttp, hex } from "./http.ts";
import { can, parseSharing, type Permission } from "./policy.ts";
import { sealCredentials } from "./secrets.ts";
import { audit, auditBy, getInstance, getVersion, instanceIdTaken } from "./store.ts";

export const MAX_OWNED_INSTANCES = 3;
export const MAX_RUNNING_ONE_OFFS = 2;

export function stub(env: Env, id: string) {
  return env.INSTANCE.getByName(id);
}

export async function instanceFor(env: Env, caller: Caller, id: string, permission: Permission): Promise<InstanceRow> {
  const row = INSTANCE_ID.test(id) ? await getInstance(env, id) : null;
  if (!row || !can(caller, row, "view")) throw new HttpError(404, "no such instance");
  if (!can(caller, row, permission)) throw new HttpError(403, `you do not have ${permission} access to ${id}`);
  return row;
}

export function publicInstance(row: InstanceRow, caller: Caller) {
  return {
    id: row.id,
    agent: row.agent,
    version: row.version,
    owner: row.owner,
    size: row.size,
    status: row.status,
    lastError: row.last_error,
    oneOff: Boolean(row.ephemeral),
    sharing: can(caller, row, "admin") ? row.sharing : undefined,
    access: {
      message: can(caller, row, "message"),
      attach: can(caller, row, "attach"),
      admin: can(caller, row, "admin"),
    },
  };
}

async function countOwned(env: Env, owner: string, ephemeral: boolean): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM instances WHERE owner = ? AND ephemeral = ? AND status != 'deleted'",
  )
    .bind(owner, ephemeral ? 1 : 0)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export interface NewInstance {
  id: string;
  agent: string;
  version?: unknown;
  size?: unknown;
  sessions?: unknown;
  credentials?: unknown;
  sharing?: unknown;
  owner?: unknown;
  ephemeral: boolean;
}

export async function createInstance(env: Env, ctx: ExecutionContext, caller: Caller, input: NewInstance) {
  const { id, agent, ephemeral } = input;
  if (!INSTANCE_ID.test(id)) throw new HttpError(400, "id must match ^[a-z][a-z0-9-]{1,40}$");
  await requireUse(env, caller, agent);
  const version = await getVersion(env, agent, typeof input.version === "string" ? input.version : undefined);
  if (!version) throw new HttpError(404, `no built version of agent ${agent || "(missing)"}`);
  const size = typeof input.size === "string" ? input.size : version.manifest.instance;
  if (!INSTANCE_TYPES.includes(size)) throw new HttpError(400, `size must be one of ${INSTANCE_TYPES.join(", ")}`);
  if (size !== version.manifest.instance && !caller.admin) throw new HttpError(403, "only admins can change the size");
  const sessions = Array.isArray(input.sessions) ? input.sessions.map(String) : ["main"];
  if (!sessions.length || sessions.some((s) => !SESSION_NAME.test(s)) || new Set(sessions).size !== sessions.length)
    throw new HttpError(400, "sessions must be unique names that start with a letter");
  const provided = parseChange({ set: input.credentials ?? {} }, version.manifest).set;
  let sharing;
  try {
    sharing = parseSharing(input.sharing);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  if (caller.via === "admin_token" && typeof input.owner !== "string") throw new HttpError(400, "owner is required");
  const owner = caller.admin && typeof input.owner === "string" ? input.owner.toLowerCase() : caller.email;
  const credentials =
    owner === caller.email ? { ...(await personalCredentials(env, owner, agent)), ...provided } : provided;
  const missing = missingRequired(version.manifest, credentials);
  if (missing.length)
    throw new HttpError(
      400,
      `missing credentials ${missing.join(", ")}: save them on your credentials page or pass them`,
    );
  if (!caller.admin) {
    const limit = ephemeral ? MAX_RUNNING_ONE_OFFS : MAX_OWNED_INSTANCES;
    if ((await countOwned(env, owner, ephemeral)) >= limit)
      throw new HttpError(429, `you already have ${limit} ${ephemeral ? "one-off runs in progress" : "instances"}`);
  }
  if (await instanceIdTaken(env, id)) throw new HttpError(409, `instance ${id} already exists or existed`);
  if (!(await stub(env, id).deployed(agent, version.version)))
    throw new HttpError(
      409,
      `version ${version.version} of ${agent} is not deployed on this host; rebuild or redeploy it`,
    );
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO instances (id, agent, version, owner, sharing, size, status, ephemeral, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'created', ?, ?, ?)",
  )
    .bind(id, agent, version.version, owner, JSON.stringify(sharing), size, ephemeral ? 1 : 0, now, now)
    .run();
  const config: InstanceConfig = {
    id,
    agent,
    version: version.version,
    harness: version.manifest.harness,
    size,
    sessions,
    credentials: await sealCredentials(env.CREDENTIALS_KEY, credentials, id),
    ephemeral,
    createdAt: now,
  };
  await stub(env, id).configure(config);
  if (!ephemeral) ctx.waitUntil(boot(env, id));
  await audit(
    env,
    auditBy(caller, ephemeral ? "instance.run-once" : "instance.create", {
      instance: id,
      detail: { agent, version: version.version, owner, sharing, credentials: Object.keys(credentials) },
    }),
  );
  return (await getInstance(env, id))!;
}

export function oneOffId(agent: string): string {
  return `run-${agent.slice(0, 24)}-${hex(4)}`;
}

export async function setSharing(env: Env, caller: Caller, row: InstanceRow, input: unknown) {
  let sharing;
  try {
    sharing = parseSharing(input);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  await env.DB.prepare("UPDATE instances SET sharing = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(sharing), Date.now(), row.id)
    .run();
  await audit(
    env,
    auditBy(caller, "instance.sharing", { instance: row.id, detail: { from: row.sharing, to: sharing } }),
  );
  return sharing;
}

export async function instanceCredentials(env: Env, row: InstanceRow) {
  const version = await getVersion(env, row.agent, row.version);
  if (!version) throw new HttpError(404, "this instance's version is no longer recorded");
  return {
    declared: version.manifest.credentials,
    allowed: [...allowedNames(version.manifest)],
    set: await stub(env, row.id).credentialNames(),
  };
}

export async function updateInstanceCredentials(
  env: Env,
  caller: Caller,
  row: InstanceRow,
  input: Record<string, unknown>,
) {
  const version = await getVersion(env, row.agent, row.version);
  if (!version) throw new HttpError(404, "this instance's version is no longer recorded");
  const change = parseChange(input, version.manifest);
  const required = version.manifest.credentials.filter((c) => c.required).map((c) => c.name);
  const names = await stub(env, row.id).updateCredentials(change, required).catch(asHttp(400));
  await audit(
    env,
    auditBy(caller, "credentials.instance", {
      instance: row.id,
      detail: { set: Object.keys(change.set), cleared: change.clear },
    }),
  );
  return { set: names, restartRequired: true };
}

export async function prepareRestart(env: Env, id: string, version?: string): Promise<void> {
  await stub(env, id).prepareRestart(version).catch(asHttp(409));
}

export function boot(env: Env, id: string): Promise<void> {
  return stub(env, id)
    .ensureRunning()
    .catch((e) => console.error(`boot ${id}: ${(e as Error).message}`));
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
