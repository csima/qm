import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { audit, getTask, isTerminal, type AuditEntry } from "./store.ts";

const MAX_RESULT = 200_000;
const MAX_TOOLS = 200;

interface TaskUpdate {
  status?: string;
  result?: unknown;
  error?: unknown;
}

interface ToolEvent {
  session?: unknown;
  sessionId?: unknown;
  tool?: unknown;
  input?: unknown;
}

const str = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : null);

async function notify(url: string, payload: unknown): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ok = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
  }
}

export class HostCallback extends WorkerEntrypoint<Env> {
  private get instance(): string {
    return (this.ctx as unknown as { props: { instance: string } }).props.instance;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("not found", { status: 404 });
    const url = new URL(req.url);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return new Response("bad request", { status: 400 });
    const task = /^\/v1\/tasks\/([a-z0-9_-]{1,64})$/.exec(url.pathname);
    if (task) return this.updateTask(task[1], body as TaskUpdate);
    if (url.pathname === "/v1/events") return this.events(body.tools);
    return new Response("not found", { status: 404 });
  }

  private async updateTask(id: string, update: TaskUpdate): Promise<Response> {
    const task = await getTask(this.env, id);
    if (!task || task.instance !== this.instance) return new Response("not found", { status: 404 });
    if (isTerminal(task.status)) return Response.json({ ignored: true });
    const now = Date.now();
    if (update.status === "running") {
      await this.env.DB.prepare(
        "UPDATE tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
      )
        .bind(now, id)
        .run();
      return Response.json({ ok: true });
    }
    if (update.status !== "done" && update.status !== "failed") return new Response("bad status", { status: 400 });
    const result = update.status === "done" ? (str(update.result, MAX_RESULT) ?? "") : null;
    const error = update.status === "failed" ? (str(update.error, 2_000) ?? "failed") : null;
    await this.env.DB.prepare(
      "UPDATE tasks SET status = ?, result = ?, error = ?, finished_at = ?, started_at = COALESCE(started_at, ?) WHERE id = ? AND status IN ('queued', 'running')",
    )
      .bind(update.status, result, error, now, now, id)
      .run();
    await audit(this.env, {
      actor: `instance:${this.instance}`,
      via: "agent",
      action: `task.${update.status}`,
      instance: this.instance,
      session: task.session,
      detail: { task: id, caller: task.caller, ...(error ? { error } : {}) },
    });
    if (task.callback_url) {
      const finished = await getTask(this.env, id);
      this.ctx.waitUntil(notify(task.callback_url, { task: finished }));
    }
    return Response.json({ ok: true });
  }

  private async events(tools: unknown): Promise<Response> {
    if (!Array.isArray(tools)) return new Response("bad request", { status: 400 });
    const entries: AuditEntry[] = (tools as ToolEvent[]).slice(0, MAX_TOOLS).map((t) => ({
      actor: `instance:${this.instance}`,
      via: "agent",
      action: "harness.tool",
      instance: this.instance,
      session: str(t.session, 32),
      detail: { tool: str(t.tool, 100), input: str(t.input, 2_000), harnessSession: str(t.sessionId, 64) },
    }));
    await audit(this.env, ...entries);
    return Response.json({ ok: true });
  }
}
