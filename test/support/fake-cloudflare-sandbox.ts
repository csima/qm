import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const FAKE_CLOUDFLARE_SANDBOX_URL = "http://sandbox.qm.internal";
export const FAKE_CLOUDFLARE_SANDBOX_TOKEN = "sandbox-token";

interface FakeBox {
  bootId?: string;
  home: string;
}

export interface CloudflareCall {
  method: string;
  path: string;
  boot?: string;
}

export interface FakeCloudflareSandbox {
  fetchImpl: typeof fetch;
  calls: CloudflareCall[];
  names(): string[];
  running(name: string): boolean;
  bootOf(name: string): string | undefined;
  homeDir(name: string): string;
  stop(name: string): void;
  restart(name: string): void;
  failStarts(on: boolean): void;
  cleanup(): void;
}

export function installFakeCloudflareSandbox(): FakeCloudflareSandbox {
  const root = mkdtempSync(join(tmpdir(), "fake-cf-sandbox-"));
  const boxes = new Map<string, FakeBox>();
  const calls: CloudflareCall[] = [];
  let startsFail = false;

  const box = (name: string): FakeBox => {
    let b = boxes.get(name);
    if (!b) {
      b = { home: join(root, name) };
      boxes.set(name, b);
    }
    return b;
  };

  const wipe = (b: FakeBox): void => {
    rmSync(b.home, { recursive: true, force: true });
    delete b.bootId;
  };

  const boot = (b: FakeBox): string => {
    wipe(b);
    mkdirSync(join(b.home, "tmp"), { recursive: true });
    b.bootId = randomUUID();
    return b.bootId;
  };

  const hostPath = (b: FakeBox, abs: string): string =>
    abs.startsWith("/tmp/") ? join(b.home, "tmp", abs.slice(5)) : abs.replace(/^\/root/, b.home);

  const remap = (b: FakeBox, script: string): string => {
    const homeRe = b.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const remapPath = new RegExp(`${homeRe}/tmp/|${homeRe}(?![A-Za-z0-9._-])|/tmp/`, "g");
    return (
      `export HOME=${JSON.stringify(b.home)}; ` +
      script.replace(/\/root/g, b.home).replace(remapPath, (m) => (m.startsWith(b.home) ? m : `${b.home}/tmp/`))
    );
  };

  const bodyBytes = async (init: RequestInit | undefined): Promise<Buffer> =>
    init?.body ? Buffer.from(await new Response(init.body).arrayBuffer()) : Buffer.alloc(0);

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const bootHeader = headers.get("x-qm-boot") ?? undefined;
    calls.push({ method, path: url.pathname, ...(bootHeader ? { boot: bootHeader } : {}) });
    if (headers.get("authorization") !== `Bearer ${FAKE_CLOUDFLARE_SANDBOX_TOKEN}`)
      return new Response("unauthorized", { status: 401 });
    const m = /^\/v1\/sandboxes\/([a-z0-9][a-z0-9-]*)(?:\/(start|exec|files))?$/.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const name = m[1]!;
    const op = m[2];
    if (!op && method === "GET") {
      const b = boxes.get(name);
      return Response.json(b?.bootId ? { running: true, bootId: b.bootId } : { running: false });
    }
    if (!op && method === "DELETE") {
      const b = boxes.get(name);
      if (b) wipe(b);
      boxes.delete(name);
      return new Response(null, { status: 204 });
    }
    if (op === "start" && method === "POST") {
      if (startsFail) return new Response("no capacity", { status: 500 });
      const b = box(name);
      return Response.json({ bootId: b.bootId ?? boot(b) });
    }
    const b = boxes.get(name);
    if (!b?.bootId || b.bootId !== bootHeader) return Response.json({ error: "boot_lost" }, { status: 409 });
    if (op === "exec" && method === "POST") {
      const { script } = JSON.parse((await bodyBytes(init)).toString("utf8")) as { script: string };
      const r = spawnSync("sh", ["-c", remap(b, script)], {
        encoding: "buffer",
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, COPYFILE_DISABLE: "1" },
      });
      return Response.json({
        stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
        stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
        code: r.status ?? (r.signal ? 137 : -1),
        timedOut: r.status === 124,
      });
    }
    if (op === "files") {
      const abs = url.searchParams.get("path") ?? "";
      const target = hostPath(b, abs);
      if (method === "PUT") {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, await bodyBytes(init));
        return new Response(null, { status: 204 });
      }
      if (method === "GET") {
        if (!existsSync(target) || !statSync(target).isFile()) return new Response("not found", { status: 404 });
        return new Response(new Uint8Array(readFileSync(target)));
      }
    }
    return new Response("method not allowed", { status: 405 });
  };

  return {
    fetchImpl,
    calls,
    names: () => [...boxes.keys()],
    running: (name) => !!boxes.get(name)?.bootId,
    bootOf: (name) => boxes.get(name)?.bootId,
    homeDir: (name) => box(name).home,
    stop: (name) => {
      const b = boxes.get(name);
      if (b) wipe(b);
    },
    restart: (name) => {
      const b = boxes.get(name);
      if (b) boot(b);
    },
    failStarts: (on) => {
      startsFail = on;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
