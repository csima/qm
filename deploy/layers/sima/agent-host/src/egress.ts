import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { sha256Hex } from "./auth.ts";
import { MODEL_HOSTS, hostAllowed, modelKey, modelRequestBody } from "./policy.ts";
import { audit } from "./store.ts";

const HOST_INTERNAL = "host.internal";
const BLOCK_AUDIT_EVERY_MS = 60_000;

interface EgressProps {
  instance: string;
  allow: string[];
  modelKeys: string[];
}

const BLOCK_AUDITS_PER_INSTANCE = 30;
const lastAudited = new Map<string, number>();
const auditWindows = new Map<string, { start: number; count: number }>();

function shouldAudit(instance: string, host: string, now: number): boolean {
  const key = `${instance} ${host}`;
  if (now - (lastAudited.get(key) ?? 0) <= BLOCK_AUDIT_EVERY_MS) return false;
  const window = auditWindows.get(instance);
  if (window && now - window.start <= BLOCK_AUDIT_EVERY_MS && window.count >= BLOCK_AUDITS_PER_INSTANCE) return false;
  if (lastAudited.size > 1_000) lastAudited.clear();
  if (auditWindows.size > 1_000) auditWindows.clear();
  lastAudited.set(key, now);
  if (!window || now - window.start > BLOCK_AUDIT_EVERY_MS) auditWindows.set(instance, { start: now, count: 1 });
  else window.count += 1;
  return true;
}

export class EgressProxy extends WorkerEntrypoint<Env> {
  private get props(): EgressProps {
    return (this.ctx as unknown as { props: EgressProps }).props;
  }

  private async modelRequest(req: Request): Promise<Request | null> {
    const key = modelKey(req.headers);
    if (key === null || !this.props.modelKeys.includes(await sha256Hex(key))) return null;
    const text = req.method === "GET" || req.method === "HEAD" ? null : await req.text();
    const checked = modelRequestBody(req.method, new URL(req.url).pathname, req.headers, text);
    if (!checked) return null;
    const headers = new Headers(req.headers);
    headers.delete("content-length");
    return new Request(req.url, { method: req.method, headers, body: checked.body, redirect: "manual" });
  }

  async fetch(req: Request): Promise<Response> {
    const { instance, allow } = this.props;
    const host = new URL(req.url).hostname;
    if (host === HOST_INTERNAL) {
      const exports = (this.ctx as unknown as { exports: Record<string, (o: { props: unknown }) => Fetcher> }).exports;
      return exports.HostCallback({ props: { instance } }).fetch(req);
    }
    if (hostAllowed(host, allow)) return fetch(new Request(req, { redirect: "manual" }));
    const forward = hostAllowed(host, MODEL_HOSTS) ? await this.modelRequest(req) : null;
    if (forward) return fetch(forward);
    if (shouldAudit(instance, host, Date.now()))
      this.ctx.waitUntil(
        audit(this.env, {
          actor: `instance:${instance}`,
          via: "agent",
          action: "egress.blocked",
          instance,
          detail: { host, method: req.method, path: new URL(req.url).pathname.slice(0, 200) },
        }).catch(() => undefined),
      );
    return new Response(`agent-host: this request to ${host} is not allowed by this agent's egress rules\n`, {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }
}
