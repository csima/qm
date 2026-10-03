import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { sha256Hex } from "./auth.ts";
import { MODEL_HOSTS, hostAllowed, modelKey } from "./policy.ts";
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

  private async permitted(req: Request, host: string): Promise<boolean> {
    const { allow, modelKeys } = this.props;
    if (hostAllowed(host, allow)) return true;
    if (!hostAllowed(host, MODEL_HOSTS)) return false;
    const key = modelKey(req.headers);
    return key !== null && modelKeys.includes(await sha256Hex(key));
  }

  async fetch(req: Request): Promise<Response> {
    const { instance } = this.props;
    const host = new URL(req.url).hostname;
    if (host === HOST_INTERNAL) {
      const exports = (this.ctx as unknown as { exports: Record<string, (o: { props: unknown }) => Fetcher> }).exports;
      return exports.HostCallback({ props: { instance } }).fetch(req);
    }
    if (await this.permitted(req, host)) return fetch(new Request(req, { redirect: "manual" }));
    if (shouldAudit(instance, host, Date.now()))
      this.ctx.waitUntil(
        audit(this.env, {
          actor: `instance:${instance}`,
          via: "agent",
          action: "egress.blocked",
          instance,
          detail: { host, method: req.method },
        }).catch(() => undefined),
      );
    return new Response(`agent-host: ${host} is not on this agent's egress allowlist\n`, {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }
}
