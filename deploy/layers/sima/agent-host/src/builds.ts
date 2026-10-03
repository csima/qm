import type { Caller, Env } from "./env.ts";
import { HttpError, hex } from "./http.ts";
import { audit, auditBy } from "./store.ts";

const REPO = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;
const SOURCE_ID = /^s_[0-9a-f]{8}$/;

export interface SourceRow {
  id: string;
  repo: string;
  ref: string;
  subdir: string;
  auto: number;
  last_sha: string | null;
  last_build_at: number | null;
  last_error: string | null;
  created_by: string;
  created_at: number;
}

export interface SourceInput {
  repo: string;
  ref: string;
  subdir: string;
  auto: boolean;
}

export function parseSource(input: Record<string, unknown>): SourceInput {
  const repo =
    typeof input.repo === "string"
      ? input.repo
          .trim()
          .replace(/\/$/, "")
          .replace(/\.git$/, "")
      : "";
  if (!REPO.test(repo)) throw new HttpError(400, "repo must be https://github.com/<owner>/<repo>");
  const text = (value: unknown, label: string) => {
    if (value === undefined || value === null || value === "") return "";
    if (typeof value !== "string" || !REF.test(value) || value.split("/").some((p) => !p || p === "." || p === ".."))
      throw new HttpError(400, `${label} must be a plain branch, tag or path`);
    return value;
  };
  if (input.auto !== undefined && typeof input.auto !== "boolean")
    throw new HttpError(400, "auto must be true or false");
  return { repo, ref: text(input.ref, "ref"), subdir: text(input.subdir, "subdir"), auto: input.auto !== false };
}

function requireAdmin(caller: Caller): void {
  if (!caller.admin) throw new HttpError(403, "only admins can manage agent builds");
}

function buildConfig(env: Env) {
  const token = env.GITHUB_BUILD_TOKEN;
  if (!token) throw new HttpError(503, "GITHUB_BUILD_TOKEN is not set on the host");
  return { token, repo: env.BUILD_REPO, workflow: env.BUILD_WORKFLOW, ref: env.BUILD_WORKFLOW_REF };
}

async function github(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const { token } = buildConfig(env);
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "agent-host",
      "x-github-api-version": "2022-11-28",
      accept: "application/vnd.github+json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export async function headSha(env: Env, source: Pick<SourceRow, "repo" | "ref">): Promise<string> {
  const [, owner, name] = REPO.exec(source.repo)!;
  const res = await github(env, `/repos/${owner}/${name}/commits/${encodeURIComponent(source.ref || "HEAD")}`, {
    headers: { accept: "application/vnd.github.sha" },
  });
  if (!res.ok) throw new Error(`GitHub could not resolve ${source.repo}@${source.ref || "HEAD"}: ${res.status}`);
  return (await res.text()).trim();
}

async function dispatch(env: Env, source: Pick<SourceRow, "repo" | "ref" | "subdir">): Promise<void> {
  const { repo, workflow, ref } = buildConfig(env);
  const res = await github(env, `/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref, inputs: { source: source.repo, ref: source.ref, subdir: source.subdir } }),
  });
  if (!res.ok) throw new Error(`GitHub refused the build: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function getSource(env: Env, id: string): Promise<SourceRow> {
  const row = SOURCE_ID.test(id)
    ? await env.DB.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first<SourceRow>()
    : null;
  if (!row) throw new HttpError(404, "no such source");
  return row;
}

async function startBuild(env: Env, row: SourceRow, sha: string | null): Promise<string | null> {
  const error = await dispatch(env, row).then(
    () => null,
    (e: Error) => e.message,
  );
  await env.DB.prepare(
    "UPDATE sources SET last_sha = COALESCE(?, last_sha), last_build_at = ?, last_error = ? WHERE id = ?",
  )
    .bind(error ? null : sha, Date.now(), error, row.id)
    .run();
  return error;
}

export function runsUrl(env: Env): string {
  return `https://github.com/${env.BUILD_REPO}/actions/workflows/${env.BUILD_WORKFLOW}`;
}

export async function listSources(env: Env, caller: Caller) {
  requireAdmin(caller);
  const { results } = await env.DB.prepare("SELECT * FROM sources ORDER BY repo, subdir, ref").all<SourceRow>();
  return { sources: results, runs: runsUrl(env) };
}

export async function addSource(env: Env, caller: Caller, input: Record<string, unknown>) {
  requireAdmin(caller);
  const source = parseSource(input);
  const sha = await headSha(env, source).catch((e: Error) => {
    throw new HttpError(400, e.message);
  });
  const id = `s_${hex(4)}`;
  await env.DB.prepare(
    "INSERT INTO sources (id, repo, ref, subdir, auto, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, source.repo, source.ref, source.subdir, source.auto ? 1 : 0, caller.email, Date.now())
    .run()
    .catch((error: Error) => {
      if (/UNIQUE/i.test(error.message)) throw new HttpError(409, "that source is already registered");
      throw error;
    });
  const row = await getSource(env, id);
  const error = await startBuild(env, row, sha);
  await audit(env, auditBy(caller, "build.source", { detail: { id, ...source, sha, error } }));
  if (error) throw new HttpError(502, error);
  return { source: await getSource(env, id), runs: runsUrl(env) };
}

export async function removeSource(env: Env, caller: Caller, id: string) {
  requireAdmin(caller);
  const row = await getSource(env, id);
  await env.DB.prepare("DELETE FROM sources WHERE id = ?").bind(id).run();
  await audit(env, auditBy(caller, "build.source.remove", { detail: { id, repo: row.repo } }));
  return { removed: id };
}

export async function buildNow(env: Env, caller: Caller, id: string) {
  requireAdmin(caller);
  const row = await getSource(env, id);
  const sha = await headSha(env, row).catch(() => null);
  const error = await startBuild(env, row, sha);
  await audit(env, auditBy(caller, "build.dispatch", { detail: { id, repo: row.repo, sha, error } }));
  if (error) throw new HttpError(502, error);
  return { building: true, sha, runs: runsUrl(env) };
}

export async function pollSources(env: Env): Promise<void> {
  if (!env.GITHUB_BUILD_TOKEN) return;
  const { results } = await env.DB.prepare("SELECT * FROM sources WHERE auto = 1").all<SourceRow>();
  for (const row of results) {
    try {
      const sha = await headSha(env, row);
      if (sha === row.last_sha) continue;
      const error = await startBuild(env, row, sha);
      await audit(env, {
        actor: "host",
        via: "agent",
        action: "build.dispatch",
        detail: { id: row.id, repo: row.repo, ref: row.ref, sha, error, trigger: "new commit" },
      });
    } catch (error) {
      console.error(`poll ${row.repo}: ${(error as Error).message}`);
    }
  }
}
