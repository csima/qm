import { MODEL_CREDENTIALS } from "../shared/naming.js";
import type { Caller, Env } from "./env.ts";
import { HttpError } from "./http.ts";
import { parseEmailList } from "./policy.ts";
import { audit, auditBy, listVersions, type VersionRow } from "./store.ts";

export async function useList(env: Env, agent: string): Promise<string[]> {
  const row = await env.DB.prepare("SELECT use_list FROM agent_access WHERE agent = ?")
    .bind(agent)
    .first<{ use_list: string }>();
  return row ? (JSON.parse(row.use_list) as string[]) : [];
}

export function canUse(caller: Caller, list: string[]): boolean {
  return caller.admin || list.includes("*") || list.includes(caller.email);
}

export async function requireUse(env: Env, caller: Caller, agent: string): Promise<void> {
  if (!canUse(caller, await useList(env, agent))) throw new HttpError(404, `no agent named ${agent} that you can use`);
}

export async function setUseList(env: Env, caller: Caller, agent: string, input: unknown): Promise<string[]> {
  if (!caller.admin) throw new HttpError(403, "only admins can change who may use an agent");
  if (!(await listVersions(env)).some((v) => v.agent === agent)) throw new HttpError(404, `no agent named ${agent}`);
  let list: string[];
  try {
    list = parseEmailList(input, "use");
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  await env.DB.prepare(
    "INSERT INTO agent_access (agent, use_list, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent) DO UPDATE SET use_list = excluded.use_list, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
  )
    .bind(agent, JSON.stringify(list), caller.email, Date.now())
    .run();
  await audit(env, auditBy(caller, "agent.access", { detail: { agent, use: list } }));
  return list;
}

export interface AgentSummary {
  agent: string;
  description: string;
  latest: string;
  credentials: VersionRow["manifest"]["credentials"];
  modelCredentials: string[];
  use?: string[];
  versions: { version: string; commit: string | null; createdAt: number; harness: string }[];
}

export async function usableAgents(env: Env, caller: Caller): Promise<AgentSummary[]> {
  const { results } = await env.DB.prepare("SELECT agent, use_list FROM agent_access").all<{
    agent: string;
    use_list: string;
  }>();
  const lists = new Map(results.map((r) => [r.agent, JSON.parse(r.use_list) as string[]]));
  const agents = new Map<string, AgentSummary>();
  for (const v of await listVersions(env)) {
    const list = lists.get(v.agent) ?? [];
    if (!canUse(caller, list)) continue;
    const entry = agents.get(v.agent) ?? {
      agent: v.agent,
      description: v.manifest.description,
      latest: v.version,
      credentials: v.manifest.credentials,
      modelCredentials: MODEL_CREDENTIALS,
      use: caller.admin ? list : undefined,
      versions: [],
    };
    entry.versions.push({
      version: v.version,
      commit: v.commit_sha,
      createdAt: v.created_at,
      harness: v.manifest.harness,
    });
    agents.set(v.agent, entry);
  }
  return [...agents.values()];
}
