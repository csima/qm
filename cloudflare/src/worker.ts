import { Container } from "@cloudflare/containers";

// Bindings that are not passed through to the container.
const WORKER_ONLY = new Set(["QM"]);

export interface Env {
  QM: DurableObjectNamespace<QmContainer>;
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

/**
 * One always-on container running core, web-ui, and portal (see supervisor.mjs).
 * Core owns crons, background work, and Slack socket mode, so the container is
 * never put to sleep for inactivity. When the Worker's vars or secrets change,
 * the next request or cron tick restarts the container with the new values.
 */
export class QmContainer extends Container<Env> {
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
    // Stay up: renew instead of stopping.
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

  /** Restart the container if its configuration changed since it last started. */
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

  /** Cron keep-alive: start the container if it is down and report core's health. */
  async heartbeat(): Promise<string> {
    await this.ensureCurrent();
    await this.startAndWaitForPorts();
    const res = await this.containerFetch("http://container/healthz", { method: "GET" }, 8080);
    return `${res.status}`;
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
    // Portal trusts exactly one X-Forwarded-For hop (PORTAL_XFF_TRUSTED_HOPS=1):
    // replace whatever the client sent with the address Cloudflare saw.
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
