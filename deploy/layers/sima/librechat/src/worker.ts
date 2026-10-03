import { Container } from "@cloudflare/containers";

const WORKER_ONLY = new Set(["LIBRECHAT"]);
const PORT = 3080;

export interface Env {
  LIBRECHAT: DurableObjectNamespace<LibreChat>;
  [name: string]: unknown;
}

function containerEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = { HOST: "0.0.0.0", PORT: String(PORT) };
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

export class LibreChat extends Container<Env> {
  defaultPort = PORT;
  requiredPorts = [PORT];
  sleepAfter = "2h";
  enableInternet = true;
  private refreshing: Promise<void> | undefined;

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env);
    this.envVars = containerEnv(env);
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    console.log(`librechat stopped (exit=${params.exitCode}, reason=${params.reason})`);
  }

  override onError(error: unknown): void {
    console.error("librechat container error", error);
  }

  async ensureCurrent(): Promise<void> {
    this.refreshing ??= (async () => {
      const want = await fingerprint(this.envVars ?? {});
      const have = await this.ctx.storage.get<string>("env-fingerprint");
      if (have === want) return;
      const state = await this.getState();
      if (have !== undefined && (state.status === "running" || state.status === "healthy")) {
        await this.stop("SIGTERM");
        for (let i = 0; i < 120; i++) {
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
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.protocol === "http:") {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 301);
    }
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") ?? "unknown");
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-host", url.host);
    headers.delete("forwarded");
    return env.LIBRECHAT.getByName("main").fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
