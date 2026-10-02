import { Container, type OutboundHandler } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import {
  MAX_TRANSFER_BYTES,
  authorizedSandboxCaller,
  routeSandboxRequest,
  sandboxIdleMs,
  sandboxInstance,
  SANDBOX_API_HOST,
} from "./sandbox-api";

export { ContainerProxy } from "@cloudflare/containers";

const WORKER_ONLY = new Set(["QM", "QM_SANDBOX", "QM_SANDBOX_INSTANCE", "QM_SANDBOX_IDLE_MINUTES"]);

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
const OUTPUT_CAP_BYTES = 4 * 1024 * 1024;
const OUTPUT_DEADLINE_GRACE_MS = 15_000;
const DETACHED_OUTPUT_GRACE_MS = 2_000;
const TIMEOUT_EXIT_CODES = new Set([124, 137]);
const TRUNCATED_NOTICE = "[cloudflare sandbox: output truncated at 4 MiB; redirect large output to a file]";
const DEADLINE_NOTICE = "[cloudflare sandbox: the command outlived its timeout with its output still open; killed]";
const DETACHED_NOTICE =
  "[cloudflare sandbox: the command exited but background processes still hold its output; redirect their output to a file]";
const MISSING_FILE_EXIT = 44;
const RUN_WITH_IMAGE_ENV =
  'while IFS= read -r -d "" kv; do export "$kv"; done </proc/1/environ; export HOME="${HOME:-/root}"; cd "$HOME"; exec timeout --kill-after=5 "$1" sh -c "$2"';

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export type SandboxReply<T> = { ok: T } | { lost: true };

interface Capture {
  done: Promise<void>;
  cancel(): void;
  bytes(): Uint8Array;
  truncated(): boolean;
}

function capture(stream: ReadableStream<Uint8Array> | null, cap: number): Capture {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let truncated = false;
  const reader = stream?.getReader();
  const done = (async () => {
    if (!reader) return;
    for (;;) {
      const { done: ended, value } = await reader.read();
      if (ended) return;
      const room = cap - kept;
      if (value.length > room) truncated = true;
      if (room > 0) {
        const take = value.subarray(0, room);
        chunks.push(take);
        kept += take.length;
      }
    }
  })().catch(() => undefined);
  return {
    done,
    cancel: () => void reader?.cancel().catch(() => undefined),
    bytes: () => {
      const bytes = new Uint8Array(kept);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    },
    truncated: () => truncated,
  };
}

function after<T>(ms: number, value: T, timers: Array<ReturnType<typeof setTimeout>>): Promise<T> {
  return new Promise((resolve) => timers.push(setTimeout(() => resolve(value), ms)));
}

export class QmSandbox extends DurableObject<Env> {
  private starting: Promise<{ bootId: string }> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running)
      void ctx.blockConcurrencyWhile(async () => {
        try {
          await container.setInactivityTimeout(sandboxIdleMs(env));
        } catch (error) {
          console.error("sandbox inactivity timeout not restored", error);
        }
      });
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

  start(): Promise<{ bootId: string }> {
    this.starting ??= this.boot().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async boot(): Promise<{ bootId: string }> {
    const container = this.container;
    const idleMs = sandboxIdleMs(this.env);
    const known = await this.currentBoot();
    if (known) {
      await container.setInactivityTimeout(idleMs);
      return { bootId: known };
    }
    await this.ctx.storage.delete("boot");
    if (!container.running) {
      container.start({ image: container.images.sandbox!, instance: sandboxInstance(this.env), enableInternet: true });
    }
    const bootId = crypto.randomUUID();
    try {
      await container.setInactivityTimeout(idleMs);
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
    const started = Date.now();
    const proc = await this.container.exec(["bash", "-c", RUN_WITH_IMAGE_ENV, "bash", String(seconds), script]);
    const stdout = capture(proc.stdout, OUTPUT_CAP_BYTES);
    const stderr = capture(proc.stderr, OUTPUT_CAP_BYTES);
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let exitCode: number | undefined;
    const exited = proc.exitCode.then((code) => {
      exitCode = code;
    });
    const drained = Promise.all([stdout.done, stderr.done, exited]).then(() => "drained" as const);
    const detached = exited.then(() => after(DETACHED_OUTPUT_GRACE_MS, "detached" as const, timers));
    const deadline = after(seconds * 1000 + OUTPUT_DEADLINE_GRACE_MS, "deadline" as const, timers);
    const outcome = await Promise.race([drained, detached, deadline]).finally(() => {
      for (const timer of timers) clearTimeout(timer);
    });
    if (outcome !== "drained") {
      if (outcome === "deadline") proc.kill(9);
      stdout.cancel();
      stderr.cancel();
    }
    const notices = [
      ...(stdout.truncated() || stderr.truncated() ? [TRUNCATED_NOTICE] : []),
      ...(outcome === "detached" ? [DETACHED_NOTICE] : []),
      ...(outcome === "deadline" ? [DEADLINE_NOTICE] : []),
    ];
    const errText = [textDecoder.decode(stderr.bytes()), ...notices].filter(Boolean).join("\n");
    const code = exitCode ?? 137;
    return {
      ok: {
        stdout: textDecoder.decode(stdout.bytes()),
        stderr: errText,
        code,
        timedOut: outcome === "deadline" || (TIMEOUT_EXIT_CODES.has(code) && Date.now() - started >= seconds * 1000),
      },
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

  async readFile(bootId: string, path: string): Promise<SandboxReply<Uint8Array | null>> {
    if ((await this.currentBoot()) !== bootId) return { lost: true };
    const proc = await this.container.exec([
      "sh",
      "-c",
      `[ -f "$1" ] || exit ${MISSING_FILE_EXIT}; cat "$1"`,
      "sh",
      path,
    ]);
    const stdout = capture(proc.stdout, MAX_TRANSFER_BYTES);
    const stderr = capture(proc.stderr, 4096);
    const [code] = await Promise.all([proc.exitCode, stdout.done, stderr.done]);
    if (code === MISSING_FILE_EXIT) return { ok: null };
    if (code !== 0) throw new Error(`read ${path}: ${textDecoder.decode(stderr.bytes()).slice(0, 200)}`);
    if (stdout.truncated()) throw new Error(`read ${path}: larger than ${MAX_TRANSFER_BYTES} bytes`);
    return { ok: stdout.bytes() };
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
