import { Container, type OutboundHandler } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import {
  authorizedSandboxCaller,
  routeSandboxRequest,
  sandboxIdleMs,
  sandboxInstance,
  SANDBOX_API_HOST,
} from "./sandbox-api";

export { ContainerProxy } from "@cloudflare/containers";

const WORKER_ONLY = new Set(["QM", "QM_SANDBOX"]);

export interface Env {
  QM: DurableObjectNamespace<QmContainer>;
  QM_SANDBOX: DurableObjectNamespace<QmSandbox>;
  QM_SANDBOX_API_TOKEN?: string;
  QM_SANDBOX_INSTANCE?: string;
  QM_SANDBOX_IDLE_MINUTES?: string;
  [name: string]: unknown;
}

function containerEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!WORKER_ONLY.has(name) && typeof value === "string") out[name] = value;
  }
  return out;
}

async function fingerprint(vars: Record<string, string>): Promise<string> {
  const canonical = JSON.stringify(
    Object.keys(vars)
      .sort()
      .map((k) => [k, vars[k]]),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sandboxApi: OutboundHandler<Env> = (request, env) => {
  if (!authorizedSandboxCaller(request, env.QM_SANDBOX_API_TOKEN)) return new Response("unauthorized", { status: 401 });
  return routeSandboxRequest(request, (name) => env.QM_SANDBOX.getByName(name));
};

export class QmContainer extends Container<Env> {
  static {
    this.outboundByHost = { [SANDBOX_API_HOST]: sandboxApi };
  }
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = "1h";
  enableInternet = true;
  private refreshing: Promise<void> | undefined;

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env);
    this.envVars = containerEnv(env);
  }

  override async onActivityExpired(): Promise<void> {
    this.renewActivityTimeout();
  }

  override onStart(): void {
    console.log("qm container started");
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    console.log(`qm container stopped (exit=${params.exitCode}, reason=${params.reason})`);
  }

  override onError(error: unknown): void {
    console.error("qm container error", error);
  }

  async ensureCurrent(): Promise<void> {
    this.refreshing ??= (async () => {
      const want = await fingerprint(this.envVars ?? {});
      const have = await this.ctx.storage.get<string>("env-fingerprint");
      if (have === want) return;
      const state = await this.getState();
      if (have !== undefined && (state.status === "running" || state.status === "healthy")) {
        console.log("configuration changed; restarting qm container");
        await this.stop("SIGTERM");
        for (let i = 0; i < 300; i++) {
          const s = await this.getState();
          if (s.status !== "running" && s.status !== "healthy" && s.status !== "stopping") break;
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      await this.ctx.storage.put("env-fingerprint", want);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureCurrent();
    return super.fetch(request);
  }

  async heartbeat(): Promise<string> {
    await this.ensureCurrent();
    await this.startAndWaitForPorts();
    const res = await this.containerFetch("http://container/healthz", { method: "GET" }, 8080);
    return `${res.status}`;
  }
}

const textDecoder = new TextDecoder();

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type SandboxReply<T> = { ok: T } | { lost: true };

export class QmSandbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(sandboxIdleMs(env)));
  }

  private get container(): NonNullable<DurableObjectState["container"]> {
    const container = this.ctx.container;
    if (!container) throw new Error("QmSandbox has no container binding");
    return container;
  }

  private async currentBoot(): Promise<string | undefined> {
    return this.container.running ? this.ctx.storage.get<string>("boot") : undefined;
  }

  async status(): Promise<{ running: boolean; bootId?: string }> {
    const bootId = await this.currentBoot();
    return { running: this.container.running, ...(bootId ? { bootId } : {}) };
  }

  async start(): Promise<{ bootId: string }> {
    const container = this.container;
    const known = await this.currentBoot();
    if (known) {
      await container.setInactivityTimeout(sandboxIdleMs(this.env));
      return { bootId: known };
    }
    if (!container.running) {
      container.start({
        image: container.images.sandbox!,
        instance: sandboxInstance(this.env),
        enableInternet: true,
      });
    }
    const bootId = crypto.randomUUID();
    try {
      await container.setInactivityTimeout(sandboxIdleMs(this.env));
      const probe = await (await container.exec(["true"])).output();
      if (probe.exitCode !== 0) throw new Error(`sandbox did not come up (exit ${probe.exitCode})`);
      await this.ctx.storage.put("boot", bootId);
    } catch (error) {
      await container.destroy().catch(() => undefined);
      throw error;
    }
    return { bootId };
  }

  async exec(bootId: string, script: string, timeoutSec: number): Promise<SandboxReply<SandboxExecResult>> {
    if ((await this.currentBoot()) !== bootId) return { lost: true };
    const seconds = Math.max(1, Math.ceil(timeoutSec));
    const proc = await this.container.exec(["timeout", "--kill-after=5", String(seconds), "sh", "-c", script], {
      cwd: "/root",
      env: { HOME: "/root" },
    });
    const out = await proc.output();
    return {
      ok: { stdout: textDecoder.decode(out.stdout), stderr: textDecoder.decode(out.stderr), code: out.exitCode },
    };
  }

  async writeFile(bootId: string, path: string, data: Uint8Array): Promise<SandboxReply<true>> {
    if ((await this.currentBoot()) !== bootId) return { lost: true };
    const proc = await this.container.exec(["sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], {
      stdin: new Response(data).body!,
    });
    const out = await proc.output();
    if (out.exitCode !== 0) throw new Error(`write ${path}: ${textDecoder.decode(out.stderr).slice(0, 200)}`);
    return { ok: true };
  }

  async readFile(bootId: string, path: string): Promise<SandboxReply<ReadableStream<Uint8Array> | null>> {
    if ((await this.currentBoot()) !== bootId) return { lost: true };
    const found = await (await this.container.exec(["test", "-f", path])).output();
    if (found.exitCode !== 0) return { ok: null };
    const proc = await this.container.exec(["cat", path], { stderr: "ignore" });
    if (!proc.stdout) throw new Error(`read ${path}: no stdout`);
    return { ok: proc.stdout };
  }

  async remove(): Promise<void> {
    if (this.container.running) await this.container.destroy();
    await this.ctx.storage.delete("boot");
  }
}

const instance = (env: Env) => env.QM.getByName("main");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") ?? "unknown");
    headers.set("x-forwarded-proto", url.protocol.slice(0, -1));
    headers.set("x-forwarded-host", url.host);
    headers.delete("forwarded");
    return instance(env).fetch(new Request(request, { headers }));
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      instance(env)
        .heartbeat()
        .then((status) => console.log(`heartbeat: portal /healthz ${status}`))
        .catch((error: unknown) => console.error("heartbeat failed", error)),
    );
  },
} satisfies ExportedHandler<Env>;
