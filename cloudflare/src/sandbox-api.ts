export const SANDBOX_API_HOST = "sandbox.qm.internal";

const INSTANCE_TYPES = ["lite", "standard-1", "standard-2", "standard-3", "standard-4"] as const;
type InstanceType = (typeof INSTANCE_TYPES)[number];
const DEFAULT_INSTANCE: InstanceType = "standard-3";
const DEFAULT_IDLE_MINUTES = 30;
const MAX_IDLE_MINUTES = 360;
const NAME = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const MAX_TRANSFER_BYTES = 24 * 1024 * 1024;

type Reply<T> = { ok: T } | { lost: true };

export interface SandboxStub {
  status(): Promise<{ running: boolean; bootId?: string }>;
  start(): Promise<{ bootId: string }>;
  exec(
    bootId: string,
    script: string,
    timeoutSec: number,
  ): Promise<Reply<{ stdout: string; stderr: string; code: number; timedOut: boolean }>>;
  writeFile(bootId: string, path: string, data: Uint8Array): Promise<Reply<true>>;
  readFile(bootId: string, path: string): Promise<Reply<Uint8Array | null>>;
  remove(): Promise<void>;
}

export function sandboxInstance(env: { QM_SANDBOX_INSTANCE?: string }): InstanceType {
  const wanted = env.QM_SANDBOX_INSTANCE?.trim();
  if (!wanted) return DEFAULT_INSTANCE;
  if ((INSTANCE_TYPES as readonly string[]).includes(wanted)) return wanted as InstanceType;
  throw new Error(`QM_SANDBOX_INSTANCE must be one of ${INSTANCE_TYPES.join(", ")}`);
}

export function sandboxIdleMs(env: { QM_SANDBOX_IDLE_MINUTES?: string }): number {
  const minutes = Number(env.QM_SANDBOX_IDLE_MINUTES?.trim() || DEFAULT_IDLE_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_IDLE_MINUTES)
    throw new Error(`QM_SANDBOX_IDLE_MINUTES must be a number of minutes between 1 and ${MAX_IDLE_MINUTES}`);
  return minutes * 60_000;
}

export function authorizedSandboxCaller(request: Request, token: string | undefined): boolean {
  const want = token?.trim();
  if (!want) return false;
  const got = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${want}`;
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const lost = (): Response => Response.json({ error: "boot_lost" }, { status: 409 });

function absolutePath(url: URL): string | null {
  const path = url.searchParams.get("path");
  return path && path.startsWith("/") && !path.split("/").includes("..") ? path : null;
}

export async function routeSandboxRequest(request: Request, stubFor: (name: string) => SandboxStub): Promise<Response> {
  const url = new URL(request.url);
  const match = /^\/v1\/sandboxes\/([^/]+)(?:\/(start|exec|files))?$/.exec(url.pathname);
  if (!match || !NAME.test(match[1]!)) return new Response("not found", { status: 404 });
  const sandbox = stubFor(match[1]!);
  const boot = request.headers.get("x-qm-boot") ?? "";
  const route = `${request.method} ${match[2] ?? ""}`;
  if (route === "GET ") return Response.json(await sandbox.status());
  if (route === "DELETE ") {
    await sandbox.remove();
    return new Response(null, { status: 204 });
  }
  if (route === "POST start") return Response.json(await sandbox.start());
  if (route === "POST exec") {
    const body = (await request.json().catch(() => ({}))) as { script?: unknown; timeoutSec?: unknown };
    if (typeof body.script !== "string" || typeof body.timeoutSec !== "number" || !(body.timeoutSec > 0))
      return new Response("need script and timeoutSec", { status: 400 });
    const reply = await sandbox.exec(boot, body.script, body.timeoutSec);
    return "lost" in reply ? lost() : Response.json(reply.ok);
  }
  if (match[2] === "files") {
    const path = absolutePath(url);
    if (!path) return new Response("need an absolute path without ..", { status: 400 });
    if (request.method === "PUT") {
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > MAX_TRANSFER_BYTES) return new Response("file too large", { status: 413 });
      const data = new Uint8Array(await request.arrayBuffer());
      if (data.length > MAX_TRANSFER_BYTES) return new Response("file too large", { status: 413 });
      const reply = await sandbox.writeFile(boot, path, data);
      return "lost" in reply ? lost() : new Response(null, { status: 204 });
    }
    if (request.method === "GET") {
      const reply = await sandbox.readFile(boot, path);
      if ("lost" in reply) return lost();
      return reply.ok ? new Response(reply.ok) : new Response("not found", { status: 404 });
    }
  }
  return new Response("method not allowed", { status: 405 });
}
