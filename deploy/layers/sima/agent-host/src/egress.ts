import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.ts";
import { hostAllowed } from "./policy.ts";
import { audit } from "./store.ts";

const HOST_INTERNAL = "host.internal";
const BLOCK_AUDIT_EVERY_MS = 60_000;

interface EgressProps {
  instance: string;
  allow: string[];
}

const lastAudited = new Map<string, number>();

export class EgressProxy extends WorkerEntrypoint<Env> {
  private get props(): EgressProps {
    return (this.ctx as unknown as { props: EgressProps }).props;
  }

  async fetch(req: Request): Promise<Response> {
    const { instance, allow } = this.props;
    const host = new URL(req.url).hostname;
    if (host === HOST_INTERNAL) {
      const exports = (this.ctx as unknown as { exports: Record<string, (o: { props: unknown }) => Fetcher> }).exports;
      return exports.HostCallback({ props: { instance } }).fetch(req);
    }
    if (hostAllowed(host, allow)) return fetch(new Request(req, { redirect: "manual" }));
    const key = `${instance} ${host}`;
    const now = Date.now();
    if (now - (lastAudited.get(key) ?? 0) > BLOCK_AUDIT_EVERY_MS) {
      if (lastAudited.size > 1_000) lastAudited.clear();
      lastAudited.set(key, now);
      this.ctx.waitUntil(
        audit(this.env, {
          actor: `instance:${instance}`,
          via: "agent",
          action: "egress.blocked",
          instance,
          detail: { host, method: req.method },
        }).catch(() => undefined),
      );
    }
    return new Response(`agent-host: ${host} is not on this agent's egress allowlist\n`, {
      status: 403,
      headers: { "content-type": "text/plain" },
    });
  }
}
