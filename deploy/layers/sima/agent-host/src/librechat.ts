import { WorkerEntrypoint } from "cloudflare:workers";
import { adminEmails, sha256Hex } from "./auth.ts";
import type { Caller, Env, InstanceRow } from "./env.ts";
import { HttpError } from "./http.ts";
import { instanceFor, stub } from "./instances.ts";
import { PRIVATE_SUFFIX, lastUserText, modelsFor, replyText } from "./chat-format.ts";
import { can, isEmail } from "./policy.ts";
import { listInstances } from "./store.ts";
import { pollTask, submitTask } from "./tasks.ts";

const WAIT_MS = 10 * 60_000;
const KEEPALIVE_MS = 15_000;
const encoder = new TextEncoder();

function completion(model: string, id: string, content: string) {
  return {
    id: `chatcmpl-${id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function chunk(model: string, id: string, delta: Record<string, string>, finish: string | null) {
  const body = {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  return encoder.encode(`data: ${JSON.stringify(body)}\n\n`);
}

const error = (status: number, message: string) =>
  Response.json({ error: { message, type: "agent_host_error" } }, { status });

export class LibreChatGateway extends WorkerEntrypoint<Env> {
  private caller(req: Request): Caller | null {
    const email = (req.headers.get("x-user-email") ?? "").trim().toLowerCase();
    if (!isEmail(email)) return null;
    return { email, via: "librechat", admin: adminEmails(this.env).has(email) };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const models = modelsFor(this.caller(req), await listInstances(this.env));
        return Response.json({
          object: "list",
          data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "agent-host" })),
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await this.chat(req);
      return error(404, "not found");
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message);
      console.error(e);
      return error(500, "internal error");
    }
  }

  private async session(caller: Caller, row: InstanceRow, isPrivate: boolean, conversation: string): Promise<string> {
    if (!isPrivate) return "main";
    if (!can(caller, row, "admin")) throw new HttpError(403, "private sessions need admin access to the instance");
    if (!/^[A-Za-z0-9-]{8,64}$/.test(conversation))
      throw new HttpError(400, "private sessions need a saved conversation; send a first message, then retry");
    const name = `c-${(await sha256Hex(conversation)).slice(0, 12)}`;
    await stub(this.env, row.id)
      .addSession(name)
      .catch((e) => {
        throw new HttpError(409, (e as Error).message);
      });
    return name;
  }

  private async chat(req: Request): Promise<Response> {
    const caller = this.caller(req);
    if (!caller) throw new HttpError(401, "LibreChat did not send the user's email");
    const body = (await req.json().catch(() => null)) as {
      model?: unknown;
      messages?: unknown;
      stream?: unknown;
    } | null;
    if (!body || typeof body.model !== "string") throw new HttpError(400, "model is required");
    const isPrivate = body.model.endsWith(PRIVATE_SUFFIX);
    const id = isPrivate ? body.model.slice(0, -PRIVATE_SUFFIX.length) : body.model;
    const row = await instanceFor(this.env, caller, id, "message");
    if (row.ephemeral) throw new HttpError(404, "one-off runs are not available as models");
    const message = lastUserText(body.messages);
    const session = await this.session(caller, row, isPrivate, req.headers.get("x-conversation-id") ?? "");
    const task = await submitTask(this.env, this.ctx, caller, row, { message, session });
    const model = body.model;
    if (body.stream !== true) {
      const done = await pollTask(this.env, task.id, Date.now() + WAIT_MS);
      return Response.json(completion(model, task.id, replyText(done, row, this.env.PUBLIC_URL)));
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const run = async () => {
      let lastPing = Date.now();
      await writer.write(chunk(model, task.id, { role: "assistant", content: "" }, null));
      const done = await pollTask(this.env, task.id, Date.now() + WAIT_MS, () => {
        if (Date.now() - lastPing < KEEPALIVE_MS) return;
        lastPing = Date.now();
        writer.write(encoder.encode(": working\n\n")).catch(() => undefined);
      });
      await writer.write(chunk(model, task.id, { content: replyText(done, row, this.env.PUBLIC_URL) }, null));
      await writer.write(chunk(model, task.id, {}, "stop"));
      await writer.write(encoder.encode("data: [DONE]\n\n"));
      await writer.close();
    };
    this.ctx.waitUntil(run().catch((e) => writer.abort(e).catch(() => undefined)));
    return new Response(readable, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }
}
