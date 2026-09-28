import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const actor = { externalId: "U1" };
const threadRef = "web:U1:runtime";
function dm(text: string, runtime: Partial<TurnRequest> = {}): TurnRequest {
  return { surface: "web", actor, conversation: { kind: "dm", threadRef }, text, ...runtime };
}

async function sessionWithTurns(...turns: Array<Partial<TurnRequest>>) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-session-runtime-")) }));
  const sid = (await built.app.turn({ ...dm("hello"), surface: "test" })).sessionId!;
  for (const [i, runtime] of turns.entries())
    await built.runs.enqueue({ sessionId: threadRef, request: dm(`turn ${i}`, runtime) });
  return { ...built, sid };
}

test("a reopened session reports the whole runtime its latest turn was sent with", async () => {
  const { app, sid } = await sessionWithTurns(
    { harness: "pi", model: "claude-opus-5", thinkingLevel: "high" },
    { harness: "claude", model: "claude-fable-5", thinkingLevel: "low", fastMode: false },
  );
  const runtime = { harnessId: "claude", modelId: "claude-fable-5", effortLevel: "low", fastMode: false };
  assert.deepEqual((await app.getSessionForViewer(sid, "U1"))?.runtime, runtime);
  assert.deepEqual((await app.getSessionForViewer(sid, "U1", { tailTurns: 1 }))?.runtime, runtime);

  const fork = (await app.forkSession(sid, "U1"))!;
  assert.deepEqual(
    (await app.getSessionForViewer(fork.session.id, "U1"))?.runtime,
    runtime,
    "a fork that has not run yet keeps its source's runtime",
  );
});

test("private session messages do not change the runtime a reopened session shows", async () => {
  const { app, sid } = await sessionWithTurns(
    { harness: "pi", model: "claude-opus-5", thinkingLevel: "max" },
    { harness: "codex", model: "gpt-5.5", privateSessionMessage: true },
  );
  assert.deepEqual((await app.getSessionForViewer(sid, "U1"))?.runtime, {
    harnessId: "pi",
    modelId: "claude-opus-5",
    effortLevel: "max",
  });
});

test("a session whose turns never named a runtime reports none", async () => {
  const { app, sid } = await sessionWithTurns();
  assert.equal((await app.getSessionForViewer(sid, "U1"))?.runtime, undefined);
});
