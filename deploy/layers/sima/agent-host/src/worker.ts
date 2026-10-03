import { HttpError, api, attachRequest, instanceFor, json } from "./api.ts";
import { callerFromAccess, callerFromBearer } from "./auth.ts";
import type { Env } from "./env.ts";
import { listInstances } from "./store.ts";
import { usableAgents } from "./access.ts";
import { personalNames } from "./credentials.ts";
import { credentialsPage, homePage, instancePage, keysPage, newInstancePage, unauthorizedPage } from "./ui.ts";

export { HostCallback } from "./callback.ts";
export { EgressProxy } from "./egress.ts";
export { Instance } from "./instance.ts";
export { LibreChatGateway } from "./librechat.ts";

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  if (url.protocol === "http:") {
    url.protocol = "https:";
    return Response.redirect(url.toString(), 301);
  }
  const path = url.pathname;
  if (path === "/healthz") return new Response("ok");
  if (path.startsWith("/api/v1/")) {
    const caller = await callerFromBearer(req, env);
    if (!caller) throw new HttpError(401, "a valid API key is required");
    return api(req, env, ctx, caller, path.slice("/api/v1".length));
  }
  const origin = req.headers.get("origin");
  const sameOrigin = origin === new URL(env.PUBLIC_URL).origin;
  const isSocket = /^\/i\/[^/]+\/ws$/.test(path);
  if ((path.startsWith("/ui/v1/") || isSocket) && origin !== null && !sameOrigin)
    throw new HttpError(403, "cross-site requests are not allowed");
  if (((path.startsWith("/ui/v1/") && req.method !== "GET") || isSocket) && !sameOrigin)
    throw new HttpError(403, "this request must come from the agent host page");
  const caller = await callerFromAccess(req, env);
  if (path.startsWith("/ui/v1/")) {
    if (!caller) throw new HttpError(401, "sign in through Cloudflare Access");
    return api(req, env, ctx, caller, path.slice("/ui/v1".length));
  }
  if (!caller) return unauthorizedPage();
  if (req.method !== "GET") throw new HttpError(405, "method not allowed");
  if (path === "/") return homePage(caller, await listInstances(env), await usableAgents(env, caller));
  if (path === "/keys") return keysPage(caller);
  if (path === "/credentials") {
    const saved = await personalNames(env, caller.email);
    const agents = await usableAgents(env, caller);
    return credentialsPage(
      caller,
      agents.map((a) => ({
        agent: a.agent,
        declared: a.credentials,
        model: a.modelCredentials,
        saved: saved.get(a.agent) ?? [],
      })),
    );
  }
  if (path === "/new") {
    const name = url.searchParams.get("agent") ?? "";
    const agent = (await usableAgents(env, caller)).find((a) => a.agent === name);
    if (!agent) throw new HttpError(404, "no such agent that you can use");
    return newInstancePage(caller, agent, (await personalNames(env, caller.email)).get(name) ?? []);
  }
  const match = /^\/i\/([a-z][a-z0-9-]{1,40})(\/ws)?$/.exec(path);
  if (match) {
    const [, id, ws] = match;
    if (ws) {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "expected a websocket");
      const row = await instanceFor(env, caller, id, "attach");
      return env.INSTANCE.getByName(id).fetch(attachRequest(req, row, caller));
    }
    const row = await instanceFor(env, caller, id, "view");
    const sessions = await env.INSTANCE.getByName(id)
      .sessions()
      .catch(() => ["main"]);
    return instancePage(caller, row, sessions);
  }
  throw new HttpError(404, "not found");
}

export default {
  async fetch(req, env, ctx) {
    try {
      return await route(req, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "internal error" }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    for (const row of (await listInstances(env)).filter((r) => r.status !== "paused")) {
      ctx.waitUntil(
        env.INSTANCE.getByName(row.id)
          .ensureRunning()
          .catch((e) => console.error(`keepalive ${row.id}: ${(e as Error).message}`)),
      );
    }
  },
} satisfies ExportedHandler<Env>;
