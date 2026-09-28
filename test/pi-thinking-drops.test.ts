import assert from "node:assert/strict";
import { test } from "node:test";
import { createPiHarness, droppedThinkingNotice } from "../src/harness/pi-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";

function anthropicStream(inputTransformations?: unknown[]): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-fable-5-1",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
        ...(inputTransformations ? { input_transformations: inputTransformations } : {}),
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

test("a turn whose earlier thinking the API dropped records a visible system entry", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const responses = [
    [
      { type: "thinking_dropped", path: "messages.1.content.0", reason: "organization_binding_mismatch" },
      { type: "thinking_dropped", path: "messages.3.content.0", reason: "organization_binding_mismatch" },
    ],
    undefined,
  ];
  globalThis.fetch = (async () => anthropicStream(responses.shift())) as typeof fetch;
  const harness = createPiHarness({ defaultModelId: "claude-fable-5-1", apiKey: "sk-offline-test-key" });
  t.after(() => harness.turns.close?.());
  const runTurn = async () => {
    const entries: Array<{ type: string; payload: unknown }> = [];
    let seq = 0;
    const result = await harness.turns.runTurn({
      session: { id: "thinking-drops" } as HarnessTurnInput["session"],
      input: "hello",
      systemPrompt: "Reply ok.",
      history: [],
      tools: {} as HarnessTurnInput["tools"],
      scopeLabel: "personal:test",
      orgScopeId: "org:test",
      emit: async (entry) => {
        entries.push(entry);
        return { ...entry, seq: seq++, createdAt: Date.now() } as never;
      },
      recordModelCall: () => {},
      cancel: AbortSignal.timeout(10_000),
    });
    assert.equal(result.reply, "ok");
    return entries.filter((entry) => entry.type === "system");
  };
  assert.deepEqual(await runTurn(), [
    {
      type: "system",
      payload: { kind: "thinking_dropped", count: 2, reasons: ["organization_binding_mismatch"] },
      scopeLabel: "personal:test",
    },
  ]);
  assert.deepEqual(await runTurn(), []);
});

test("only thinking_dropped transformations count as dropped reasoning", () => {
  const diagnostic = (transformations: unknown[]) => ({
    diagnostics: [
      { type: "provider_retry", timestamp: 1 },
      { type: "anthropic_input_transformations", timestamp: 2, details: { transformations } },
    ],
  });
  assert.equal(droppedThinkingNotice({ content: [] }), undefined);
  assert.equal(droppedThinkingNotice(diagnostic([{ type: "image_resized", reason: "size" }])), undefined);
  assert.deepEqual(
    droppedThinkingNotice(
      diagnostic([
        { type: "thinking_dropped", reason: "model_binding_mismatch" },
        { type: "image_resized", reason: "size" },
        { type: "thinking_dropped" },
      ]),
    ),
    { kind: "thinking_dropped", count: 2, reasons: ["model_binding_mismatch", "unknown"] },
  );
});
