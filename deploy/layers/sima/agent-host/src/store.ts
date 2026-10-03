import type { Caller, Env, InstanceRow, Manifest, Sharing, Via } from "./env.ts";

export interface AuditEntry {
  actor: string;
  via: Via;
  action: string;
  instance?: string | null;
  session?: string | null;
  detail?: unknown;
}

export interface TaskRow {
  id: string;
  instance: string;
  session: string;
  caller: string;
  via: string;
  message: string;
  status: "queued" | "running" | "done" | "failed";
  result: string | null;
  error: string | null;
  callback_url: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface VersionRow {
  agent: string;
  version: string;
  image: string;
  commit_sha: string | null;
  source: string | null;
  manifest: Manifest;
  created_at: number;
}

const MAX_DETAIL = 8_000;

function auditStatement(env: Pick<Env, "DB">, entry: AuditEntry): D1PreparedStatement {
  const detail = entry.detail === undefined ? null : JSON.stringify(entry.detail).slice(0, MAX_DETAIL);
  return env.DB.prepare(
    "INSERT INTO audit (at, actor, via, action, instance, session, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(Date.now(), entry.actor, entry.via, entry.action, entry.instance ?? null, entry.session ?? null, detail);
}

export async function audit(env: Pick<Env, "DB">, ...entries: AuditEntry[]): Promise<void> {
  if (entries.length) await env.DB.batch(entries.map((e) => auditStatement(env, e)));
}

export function auditBy(
  caller: Caller,
  action: string,
  rest: Omit<AuditEntry, "actor" | "via" | "action"> = {},
): AuditEntry {
  return { actor: caller.email, via: caller.via, action, ...rest };
}

function parseInstance(row: Record<string, unknown> | null): InstanceRow | null {
  if (!row) return null;
  return { ...(row as unknown as InstanceRow), sharing: JSON.parse(row.sharing as string) as Sharing };
}

export async function getInstance(env: Pick<Env, "DB">, id: string): Promise<InstanceRow | null> {
  return parseInstance(
    await env.DB.prepare("SELECT * FROM instances WHERE id = ? AND status != 'deleted'").bind(id).first(),
  );
}

export async function instanceIdTaken(env: Pick<Env, "DB">, id: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM instances WHERE id = ?").bind(id).first()) !== null;
}

export async function listInstances(env: Pick<Env, "DB">): Promise<InstanceRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM instances WHERE status != 'deleted' ORDER BY id").all();
  return results.map((r) => parseInstance(r)!);
}

export async function setInstanceStatus(env: Pick<Env, "DB">, id: string, status: string, error: string | null = null) {
  await env.DB.prepare(
    "UPDATE instances SET status = ?, last_error = ?, updated_at = ? WHERE id = ? AND status != 'deleted'",
  )
    .bind(status, error, Date.now(), id)
    .run();
}

function parseVersion(row: Record<string, unknown> | null): VersionRow | null {
  if (!row) return null;
  return { ...(row as unknown as VersionRow), manifest: JSON.parse(row.manifest as string) as Manifest };
}

export async function getVersion(env: Pick<Env, "DB">, agent: string, version?: string): Promise<VersionRow | null> {
  const row = version
    ? await env.DB.prepare("SELECT * FROM versions WHERE agent = ? AND version = ?").bind(agent, version).first()
    : await env.DB.prepare("SELECT * FROM versions WHERE agent = ? ORDER BY created_at DESC LIMIT 1")
        .bind(agent)
        .first();
  return parseVersion(row);
}

export async function listVersions(env: Pick<Env, "DB">): Promise<VersionRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM versions ORDER BY agent, created_at DESC").all();
  return results.map((r) => parseVersion(r)!);
}

export async function getTask(env: Pick<Env, "DB">, id: string): Promise<TaskRow | null> {
  return env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
}

export async function recentTasks(env: Pick<Env, "DB">, instance: string, limit = 20): Promise<TaskRow[]> {
  const { results } = await env.DB.prepare("SELECT * FROM tasks WHERE instance = ? ORDER BY created_at DESC LIMIT ?")
    .bind(instance, limit)
    .all<TaskRow>();
  return results;
}

export function isTerminal(status: string): boolean {
  return status === "done" || status === "failed";
}
