import { Container, type OutboundHandler } from "@cloudflare/containers";

export { ContainerProxy } from "@cloudflare/containers";

const MEILI_HOST = "meili.internal";
const RAG_HOST = "rag.internal";
const EMBEDDINGS_HOST = "embeddings.internal";
const EMBEDDINGS_MODEL = "@cf/baai/bge-m3";
const EMBEDDINGS_BATCH = 50;
const RAG_ONLY_PREFIX = "RAGSVC_";
const BINDINGS = new Set(["LIBRECHAT", "MEILI", "RAG", "AI"]);

export interface Env {
  LIBRECHAT: DurableObjectNamespace<LibreChat>;
  MEILI: DurableObjectNamespace<Meili>;
  RAG: DurableObjectNamespace<RagApi>;
  AI: Ai;
  MEILI_MASTER_KEY: string;
  JWT_SECRET: string;
  RAGSVC_DB_HOST: string;
  RAGSVC_DB_NAME: string;
  RAGSVC_DB_USER: string;
  RAGSVC_DB_PASSWORD: string;
  [name: string]: unknown;
}

function stringVars(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!BINDINGS.has(name) && typeof value === "string") out[name] = value;
  }
  return out;
}

function libreChatEnv(env: Env): Record<string, string> {
  const vars = Object.entries(stringVars(env)).filter(([name]) => !name.startsWith(RAG_ONLY_PREFIX));
  return {
    ...Object.fromEntries(vars),
    HOST: "0.0.0.0",
    PORT: "3080",
    SEARCH: "true",
    MEILI_HOST: `http://${MEILI_HOST}`,
    RAG_API_URL: `http://${RAG_HOST}`,
  };
}

function meiliEnv(env: Env): Record<string, string> {
  return { MEILI_MASTER_KEY: env.MEILI_MASTER_KEY, MEILI_NO_ANALYTICS: "true", MEILI_ENV: "production" };
}

function ragEnv(env: Env): Record<string, string> {
  return {
    RAG_HOST: "0.0.0.0",
    RAG_PORT: "8000",
    JWT_SECRET: env.JWT_SECRET,
    DB_HOST: env.RAGSVC_DB_HOST,
    DB_PORT: "5432",
    POSTGRES_DB: env.RAGSVC_DB_NAME,
    POSTGRES_USER: env.RAGSVC_DB_USER,
    POSTGRES_PASSWORD: env.RAGSVC_DB_PASSWORD,
    POSTGRES_SCHEMA: "librechat_rag",
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: "/etc/ssl/certs/ca-certificates.crt",
    COLLECTION_NAME: "librechat",
    EMBEDDINGS_PROVIDER: "openai",
    EMBEDDINGS_MODEL,
    EMBEDDINGS_CHUNK_SIZE: String(EMBEDDINGS_BATCH),
    RAG_OPENAI_API_KEY: "workers-ai-via-worker",
    RAG_OPENAI_BASEURL: `http://${EMBEDDINGS_HOST}/v1`,
    RAG_CHECK_EMBEDDING_CTX_LENGTH: "false",
  };
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

function float32Base64(values: number[]): string {
  const bytes = new Uint8Array(new Float32Array(values).buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const embeddings: OutboundHandler<Env> = async (request, env) => {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/v1/embeddings") return new Response("not found", { status: 404 });
  const body = (await request.json().catch(() => null)) as { input?: unknown; encoding_format?: string } | null;
  const inputs = typeof body?.input === "string" ? [body.input] : body?.input;
  if (!Array.isArray(inputs) || !inputs.every((t) => typeof t === "string"))
    return Response.json({ error: { message: "input must be a string or an array of strings" } }, { status: 400 });
  const vectors: number[][] = [];
  for (let i = 0; i < inputs.length; i += EMBEDDINGS_BATCH) {
    const out = (await env.AI.run(EMBEDDINGS_MODEL, { text: inputs.slice(i, i + EMBEDDINGS_BATCH) })) as {
      data: number[][];
    };
    vectors.push(...out.data);
  }
  const base64 = body?.encoding_format === "base64";
  return Response.json({
    object: "list",
    model: EMBEDDINGS_MODEL,
    data: vectors.map((embedding, index) => ({
      object: "embedding",
      index,
      embedding: base64 ? float32Base64(embedding) : embedding,
    })),
    usage: { prompt_tokens: 0, total_tokens: 0 },
  });
};

abstract class ConfiguredContainer extends Container<Env> {
  enableInternet = true;
  private refreshing: Promise<void> | undefined;

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env, vars: Record<string, string>) {
    super(ctx, env);
    this.envVars = vars;
  }

  override onStop(params: { exitCode?: number; reason?: string }): void {
    console.log(`${this.constructor.name} stopped (exit=${params.exitCode}, reason=${params.reason})`);
  }

  override onError(error: unknown): void {
    console.error(`${this.constructor.name} error`, error);
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

export class LibreChat extends ConfiguredContainer {
  static {
    this.outboundByHost = {
      [MEILI_HOST]: (request: Request, env: Env) => env.MEILI.getByName("main").fetch(request),
      [RAG_HOST]: (request: Request, env: Env) => env.RAG.getByName("main").fetch(request),
    };
  }
  defaultPort = 3080;
  requiredPorts = [3080];
  sleepAfter = "2h";

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env, libreChatEnv(env));
  }
}

export class Meili extends ConfiguredContainer {
  defaultPort = 7700;
  requiredPorts = [7700];
  sleepAfter = "3h";

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env, meiliEnv(env));
  }
}

export class RagApi extends ConfiguredContainer {
  static {
    this.outboundByHost = { [EMBEDDINGS_HOST]: embeddings };
  }
  defaultPort = 8000;
  requiredPorts = [8000];
  sleepAfter = "3h";

  constructor(ctx: DurableObjectState<Record<string, never>>, env: Env) {
    super(ctx, env, ragEnv(env));
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
