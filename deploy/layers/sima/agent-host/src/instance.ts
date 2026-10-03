import { DurableObject } from "cloudflare:workers";
import { SESSION_NAME, imageKey } from "../shared/naming.js";
import { modelEnvironment, systemPrompt } from "./boot-env.ts";
import type { Env, InstanceConfig } from "./env.ts";
import { putStream } from "./r2.ts";
import { openCredentials } from "./secrets.ts";
import { audit, setInstanceStatus, type TaskRow } from "./store.ts";

const ALARM_MS = 60_000;
const SNAPSHOT_EVERY_MS = 5 * 60_000;
const START_TIMEOUT_MS = 120_000;
const INACTIVITY_MS = 5 * 60 * 60_000;
const RECORDING_LIMIT = 20 * 1024 * 1024;
const MAX_SESSIONS = 8;
const QUEUED_EXPIRY_MS = 60 * 60_000;
const RUNNING_EXPIRY_MS = 90 * 60_000;
const STORAGE_DELETE_BATCH = 128;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decoder = new TextDecoder();

type ContainerSize = "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";

export interface QueuedTask {
  id: string;
  session: string;
  caller: string;
  via: string;
  message: string;
}

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const streamOf = (text: string) => new Response(text).body!;
const clamp = (value: string | null | number, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export class Instance extends DurableObject<Env> {
  private booting: Promise<void> | undefined;

  private get container(): Container {
    const container = this.ctx.container;
    if (!container) throw new Error("this Durable Object has no container");
    return container;
  }

  private async run(cmd: string[], stdin?: string | ReadableStream) {
    const proc = await this.container.exec(
      cmd,
      stdin === undefined ? {} : { stdin: typeof stdin === "string" ? streamOf(stdin) : stdin },
    );
    const out = await proc.output();
    return { code: out.exitCode, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) };
  }

  private async must(cmd: string[], stdin?: string | ReadableStream): Promise<string> {
    const res = await this.run(cmd, stdin);
    if (res.code !== 0) throw new Error(`${cmd[0]} exited ${res.code}: ${(res.stderr || res.stdout).slice(-500)}`);
    return res.stdout;
  }

  private async config(): Promise<InstanceConfig> {
    const config = await this.ctx.storage.get<InstanceConfig>("config");
    if (!config) throw new Error("instance is not configured");
    return config;
  }

  async configure(config: InstanceConfig): Promise<void> {
    await this.ctx.storage.put("config", config);
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  async sessions(): Promise<string[]> {
    return (await this.config()).sessions;
  }

  async status() {
    return {
      running: this.ctx.container?.running ?? false,
      healthy: await this.healthy().catch(() => false),
      bootId: (await this.ctx.storage.get<string>("bootId")) ?? null,
      lastSnapshotAt: (await this.ctx.storage.get<number>("lastSnapshotAt")) ?? null,
      sessions: (await this.config()).sessions,
    };
  }

  async ensureRunning(): Promise<void> {
    if (this.booting) return this.booting;
    if (await this.healthy()) return;
    this.booting ??= this.boot().finally(() => {
      this.booting = undefined;
    });
    return this.booting;
  }

  private async probe(): Promise<{ boot: string; ready: boolean } | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.run(["agent-health", "--repair"]).catch(() => null);
      if (res?.code === 0) {
        const fields = new Map(
          res.stdout
            .trim()
            .split(/\s+/)
            .map((kv) => kv.split("=") as [string, string]),
        );
        if (fields.get("agentd") === "restarted") console.warn("agentd was not running and has been restarted");
        return { boot: fields.get("boot") ?? "", ready: fields.get("tmux") === "up" };
      }
      if (!res || res.code === 127) {
        const legacy = await this.run(["cat", "/run/agent/boot-id"]).catch(() => null);
        if (legacy?.code === 0) return { boot: legacy.stdout.trim(), ready: true };
      }
      await sleep(1_000);
    }
    return null;
  }

  private async healthy(): Promise<boolean> {
    if (!this.container.running) return false;
    const bootId = await this.ctx.storage.get<string>("bootId");
    if (!bootId) return false;
    const bootVersion = await this.ctx.storage.get<string>("bootVersion");
    if (bootVersion && bootVersion !== (await this.config()).version) return false;
    const health = await this.probe();
    return health !== null && health.ready && health.boot === bootId;
  }

  async deployed(agent: string, version: string): Promise<boolean> {
    return Boolean(this.container.images[imageKey(agent, version)]);
  }

  private async startContainer(image: string, size: string): Promise<void> {
    const container = this.container;
    if (container.running) {
      await container.destroy().catch(() => undefined);
      for (let i = 0; i < 60 && container.running; i++) await new Promise((r) => setTimeout(r, 500));
    }
    container.start({ image, instance: size as ContainerSize, enableInternet: true });
    let exited: string | null = null;
    container.monitor().then(
      () => (exited ??= "container exited"),
      (error) => (exited ??= errText(error)),
    );
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited) throw new Error(`container failed to start: ${exited}`);
      const ok = await this.run(["true"]).then(
        (r) => r.code === 0,
        () => false,
      );
      if (ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("container did not start in time");
  }

  private async boot(): Promise<void> {
    const config = await this.config();
    await setInstanceStatus(this.env, config.id, "starting");
    try {
      const image = this.container.images[imageKey(config.agent, config.version)];
      if (!image) throw new Error(`version ${config.version} of ${config.agent} is not deployed on this host`);
      if (this.container.running && (await this.ctx.storage.get("bootId")))
        await this.snapshot(config.id, true).catch((e) =>
          console.error(`pre-reboot save of ${config.id} failed: ${errText(e)}`),
        );
      await this.ctx.storage.delete("bootId");
      await this.startContainer(image, config.size);
      const exports = (this.ctx as unknown as { exports: Record<string, (o: { props: unknown }) => Fetcher> }).exports;
      await this.container.interceptOutboundHttp(
        "host.internal",
        exports.HostCallback({ props: { instance: config.id } }),
      );
      await this.container.setInactivityTimeout(INACTIVITY_MS);
      await this.restoreState(config.id);
      const credentials = await openCredentials(this.env.CREDENTIALS_KEY, config.credentials, config.id);
      const bootId = crypto.randomUUID();
      const out = await this.must(
        ["agent-boot"],
        JSON.stringify({
          instance: config.id,
          bootId,
          harness: config.harness,
          sessions: config.sessions,
          appendSystemPrompt: systemPrompt(config),
          env: { ...modelEnvironment(this.env, credentials), ...credentials },
        }),
      );
      if (out.trim().split("\n").at(-1) !== "ok") throw new Error(`agent-boot did not finish: ${out.slice(-300)}`);
      await this.ctx.storage.put({ bootId, bootVersion: config.version });
      const delivered = [...(await this.ctx.storage.list({ prefix: "q:" })).keys()];
      for (let i = 0; i < delivered.length; i += STORAGE_DELETE_BATCH)
        await this.ctx.storage.delete(delivered.slice(i, i + STORAGE_DELETE_BATCH));
      await setInstanceStatus(this.env, config.id, "running");
      await audit(this.env, {
        actor: `instance:${config.id}`,
        via: "agent",
        action: "instance.boot",
        instance: config.id,
        detail: { version: config.version, bootId },
      });
    } catch (error) {
      await setInstanceStatus(this.env, config.id, "error", errText(error));
      throw error;
    }
    const bootId = (await this.ctx.storage.get<string>("bootId"))!;
    await this.requeue(config.id, bootId);
  }

  private async restoreState(id: string): Promise<void> {
    const pointer = await this.env.STATE.get(`state/${id}/current`);
    if (!pointer) return;
    const object = await this.env.STATE.get(await pointer.text());
    if (!object) throw new Error("the saved state pointer names a missing object");
    await this.must(["agent-state", "restore"], object.body);
  }

  private async requeue(id: string, bootId: string): Promise<void> {
    const now = Date.now();
    await this.env.DB.prepare(
      "UPDATE tasks SET status = 'failed', error = 'interrupted by an instance restart', finished_at = ? WHERE instance = ? AND status = 'running'",
    )
      .bind(now, id)
      .run();
    const { results } = await this.env.DB.prepare(
      "SELECT id, session, caller, via, message FROM tasks WHERE instance = ? AND status = 'queued' ORDER BY created_at",
    )
      .bind(id)
      .all<QueuedTask>();
    for (const task of results)
      await this.deliver(task, bootId).catch((e) => console.error(`requeue ${task.id}: ${errText(e)}`));
  }

  private readonly inflight = new Set<string>();

  private async deliver(task: QueuedTask, bootId: string): Promise<void> {
    const key = `q:${bootId}:${task.id}`;
    if (this.inflight.has(key) || (await this.ctx.storage.get(key))) return;
    this.inflight.add(key);
    try {
      await this.must(["agent-enqueue"], JSON.stringify(task));
      await this.ctx.storage.put(key, 1);
    } finally {
      this.inflight.delete(key);
    }
  }

  async enqueue(task: QueuedTask): Promise<void> {
    await this.ensureRunning();
    const bootId = await this.ctx.storage.get<string>("bootId");
    if (!bootId) throw new Error("instance has no active boot");
    const row = await this.env.DB.prepare("SELECT status FROM tasks WHERE id = ?")
      .bind(task.id)
      .first<Pick<TaskRow, "status">>();
    if (row?.status !== "queued") return;
    await this.deliver(task, bootId);
  }

  async addSession(name: string): Promise<string[]> {
    if (!SESSION_NAME.test(name))
      throw new Error("session names start with a letter and use lowercase letters, digits and dashes");
    const config = await this.config();
    if (!config.sessions.includes(name) && config.sessions.length >= MAX_SESSIONS)
      throw new Error(`an instance can have at most ${MAX_SESSIONS} sessions`);
    await this.ensureRunning();
    await this.must(["agent-session", name]);
    if (!config.sessions.includes(name)) {
      config.sessions.push(name);
      await this.ctx.storage.put("config", config);
    }
    return config.sessions;
  }

  async prepareRestart(version?: string): Promise<void> {
    if (this.booting) throw new Error("the instance is already starting");
    const config = await this.config();
    const target = version ?? config.version;
    if (!(await this.deployed(config.agent, target)))
      throw new Error(`version ${target} of ${config.agent} is not deployed on this host`);
    if (await this.healthy()) await this.snapshot(config.id, true);
    if (this.booting) throw new Error("the instance started booting; try again");
    config.version = target;
    await this.ctx.storage.put("config", config);
    await this.ctx.storage.delete("bootId");
  }

  private async snapshot(id: string, force = false): Promise<boolean> {
    const changed = await this.must(["agent-state", "changed"]);
    if (!force && changed.trim() !== "yes") return false;
    const key = `state/${id}/home-${Date.now()}.tar.gz`;
    const proc = await this.container.exec(["agent-state", "save"], { stderr: "ignore" });
    const bytes = await putStream(this.env.STATE, key, proc.stdout!);
    const code = await proc.exitCode;
    if (code !== 0) {
      await this.env.STATE.delete(key);
      throw new Error(`state save exited ${code}`);
    }
    const previous = await this.env.STATE.get(`state/${id}/current`).then((o) => o?.text());
    await this.env.STATE.put(`state/${id}/current`, key);
    if (previous && previous !== key) await this.env.STATE.delete(previous);
    await this.ctx.storage.put("lastSnapshotAt", Date.now());
    console.log(`saved state for ${id}: ${bytes} bytes`);
    return true;
  }

  async alarm(): Promise<void> {
    const config = await this.ctx.storage.get<InstanceConfig>("config");
    if (!config) return;
    try {
      await this.expireStaleTasks(config.id);
      await this.ensureRunning();
      await this.container.setInactivityTimeout(INACTIVITY_MS);
      const last = (await this.ctx.storage.get<number>("lastSnapshotAt")) ?? 0;
      if (Date.now() - last >= SNAPSHOT_EVERY_MS) await this.snapshot(config.id);
    } catch (error) {
      console.error(`instance ${config.id}: ${errText(error)}`);
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_MS);
    }
  }

  private async expireStaleTasks(id: string): Promise<void> {
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE tasks SET status = 'failed', error = 'not started within an hour', finished_at = ? WHERE instance = ? AND status = 'queued' AND created_at < ?",
      ).bind(now, id, now - QUEUED_EXPIRY_MS),
      this.env.DB.prepare(
        "UPDATE tasks SET status = 'failed', error = 'no result within 90 minutes', finished_at = ? WHERE instance = ? AND status = 'running' AND started_at < ?",
      ).bind(now, id, now - RUNNING_EXPIRY_MS),
    ]);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response("expected websocket", { status: 426 });
    const url = new URL(req.url);
    const session = url.searchParams.get("session") ?? "main";
    const caller = req.headers.get("x-agent-host-caller") ?? "unknown";
    const via = (req.headers.get("x-agent-host-via") ?? "access") as "access" | "api_key" | "admin_token";
    const config = await this.config();
    if (!config.sessions.includes(session)) return new Response("no such session", { status: 404 });
    await this.ensureRunning();
    const cols = clamp(url.searchParams.get("cols"), 20, 400, 120);
    const rows = clamp(url.searchParams.get("rows"), 5, 200, 40);
    const view = `view-${crypto.randomUUID().slice(0, 8)}`;
    const proc = await this.container.exec(
      [
        "runuser",
        "-u",
        "agent",
        "--",
        "env",
        "HOME=/home/agent",
        "TERM=xterm-256color",
        "XDG_RUNTIME_DIR=/run/agent/xdg",
        "tmux",
        "new-session",
        "-t",
        "agent",
        "-s",
        view,
        ";",
        "set-option",
        "-t",
        view,
        "destroy-unattached",
        "on",
        ";",
        "select-window",
        "-t",
        `${view}:=${session}`,
      ],
      { pty: { cols, rows }, stdin: "pipe" },
    );
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const startedAt = Date.now();
    const recording = [
      JSON.stringify({ version: 2, width: cols, height: rows, timestamp: Math.floor(startedAt / 1000) }),
    ];
    let recorded = 0;
    let truncated = false;
    const outputDecoder = new TextDecoder();
    const writer = proc.stdin!.getWriter();
    server.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data) as { type?: string; cols?: number; rows?: number };
          if (msg.type === "resize")
            proc.resize(clamp(msg.cols ?? 0, 20, 400, cols), clamp(msg.rows ?? 0, 5, 200, rows));
        } catch {
          return;
        }
        return;
      }
      writer.write(new Uint8Array(event.data as ArrayBuffer)).catch(() => undefined);
    });
    let finished: Promise<void> | undefined;
    const finish = () =>
      (finished ??= (async () => {
        try {
          proc.kill();
        } catch {
          void 0;
        }
        const key = `recordings/${config.id}/${new Date(startedAt).toISOString()}-${caller.replace(/[^a-z0-9@._-]/gi, "_")}.cast`;
        await this.env.STATE.put(key, `${recording.join("\n")}\n`, {
          httpMetadata: { contentType: "application/x-asciicast" },
        });
        await audit(this.env, {
          actor: caller,
          via,
          action: "attach.end",
          instance: config.id,
          session,
          detail: { recording: key, seconds: Math.round((Date.now() - startedAt) / 1000), truncated },
        });
      })());
    server.addEventListener("close", () => this.ctx.waitUntil(finish()));
    server.addEventListener("error", () => this.ctx.waitUntil(finish()));
    this.ctx.waitUntil(
      (async () => {
        const reader = proc.stdout!.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            server.send(value);
            if (recorded < RECORDING_LIMIT) {
              recorded += value.length;
              recording.push(
                JSON.stringify([(Date.now() - startedAt) / 1000, "o", outputDecoder.decode(value, { stream: true })]),
              );
            } else truncated = true;
          }
        } finally {
          try {
            server.close(1000, "session detached");
          } catch {
            void 0;
          }
          await finish();
        }
      })(),
    );
    await audit(this.env, { actor: caller, via, action: "attach.start", instance: config.id, session });
    return new Response(null, { status: 101, webSocket: client });
  }
}
