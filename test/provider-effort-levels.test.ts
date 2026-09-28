import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { parseRuntimeChoice, resolveModel, storedEffort, thinkingLevelsForHarness } from "../src/model/pi-models.ts";
import { codexReasoningEffort } from "../src/harness/codex-harness.ts";
import { resolveRuntimeChoice } from "../src/harness/harness-router.ts";
import { createRuntimeService } from "../src/harness/runtime-control.ts";
import { recoveredRuntime } from "../src/harness/runtime-recovery.ts";
import type { SessionEntry } from "../src/types.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { buildApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import { runtimeChoice } from "./support/runtime-choice.ts";

const tiers = (harnessId: "pi" | "claude" | "codex", modelId: string) =>
  thinkingLevelsForHarness(harnessId, modelId).filter((level) => !["auto", "default", "adaptive"].includes(level));
const valid = (harnessId: "pi" | "claude" | "codex", modelId: string) =>
  thinkingLevelsForHarness(harnessId, modelId).join(", ");
const ORG = "org:default-org";
const SCOPE = "personal:alice";

test("each model offers only the effort levels its provider documents", () => {
  assert.deepEqual(tiers("pi", "claude-opus-5-5"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(tiers("pi", "claude-opus-4-6"), ["low", "medium", "high", "max"]);
  assert.deepEqual(tiers("pi", "claude-haiku-4-5"), []);
  assert.deepEqual(tiers("pi", "gpt-6-astra"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(tiers("claude", "claude-opus-5-5"), ["low", "medium", "high", "xhigh", "max", "ultracode"]);
  assert.deepEqual(tiers("claude", "claude-opus-4-6"), ["low", "medium", "high", "max"]);
  assert.deepEqual(tiers("codex", "gpt-6-astra"), ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.deepEqual(tiers("codex", "gpt-6-luna"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(tiers("codex", "claude-opus-5-5"), []);
  assert.deepEqual(tiers("claude", "gpt-6-astra"), []);
});

test("pi sends OpenAI max as max instead of clamping it to xhigh", () => {
  for (const modelId of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
    assert.equal(clampThinkingLevel(resolveModel(modelId)!, "max"), "max");
  assert.equal(codexReasoningEffort("ultra"), "ultra");
  assert.equal(codexReasoningEffort("ultracode"), undefined);
});

test("the runtime parser rejects any effort the harness and model do not offer, naming the valid levels", () => {
  for (const [harnessId, modelId, effortLevel] of [
    ["codex", "gpt-6-astra", "ultracode"],
    ["codex", "gpt-6-luna", "ultra"],
    ["claude", "claude-opus-4-6", "xhigh"],
    ["claude", "claude-opus-5-5", "ultra"],
    ["pi", "claude-opus-5-5", "ultracode"],
    ["pi", "gpt-6-astra", "ultra"],
    ["pi", "claude-haiku-4-5", "low"],
    ["claude", "claude-haiku-4-5", "high"],
  ] as const)
    assert.deepEqual(parseRuntimeChoice({ harnessId, modelId, effortLevel }), {
      ok: false,
      error: "effort_not_supported",
      message: `effort ${effortLevel} isn't available on ${harnessId}/${modelId} (valid: ${valid(harnessId, modelId)})`,
    });
  assert.equal(parseRuntimeChoice({ harnessId: "claude", modelId: "claude-haiku-4-5", effortLevel: "auto" }).ok, true);
});

test("the runtime tool rejects invalid efforts, including one carried over to a new model", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "claude", "codex"]);
  const service = createRuntimeService({ config, harnessId: "pi" }, { authorizesCapabilityScope: async () => true });
  const claims = { actorId: "alice", scopeId: SCOPE, liveActor: true, exp: Date.now() + 60_000 } as const;
  const onClaude = runtimeChoice({ harnessId: "claude", modelId: "claude-opus-5-5", effortLevel: "ultracode" });
  assert.deepEqual(
    await service(claims, onClaude, { action: "set", harness: "codex", model: "gpt-6-astra", lifetime: "scope" }),
    {
      ok: false,
      error: "effort_not_supported",
      message: `effort ultracode isn't available on codex/gpt-6-astra; pass an effort (valid: ${valid("codex", "gpt-6-astra")})`,
    },
  );
  assert.deepEqual(
    await service(claims, onClaude, { action: "set", harness: "codex", model: "gpt-6-astra", effort: "ultracode" }),
    {
      ok: false,
      error: "effort_not_supported",
      message: `effort ultracode isn't available on codex/gpt-6-astra (valid: ${valid("codex", "gpt-6-astra")})`,
    },
  );
  assert.equal(config.getRuntimeSelection(SCOPE), null);
  const moved = await service(claims, onClaude, {
    action: "set",
    harness: "codex",
    model: "gpt-6-astra",
    effort: "ultra",
    lifetime: "scope",
  });
  assert.equal(moved.ok, true);
  assert.equal(config.getRuntimeSelection(SCOPE)?.effortLevel, "ultra");
});

test("explicit turn and sessions-open efforts are rejected; a carried one that does not fit runs unset", (t) => {
  t.mock.method(console, "warn", () => {});
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "claude", "codex"]);
  config.setRuntimeSelection(
    SCOPE,
    runtimeChoice({ harnessId: "claude", modelId: "claude-opus-5-5", effortLevel: "ultracode" }),
  );
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-5-5" };
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, SCOPE, fallback, { effortLevel: "ultra" }),
    /effort ultra isn't available on claude\/claude-opus-5-5 \(valid: /,
  );
  assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback, { harnessId: "codex", modelId: "gpt-6-astra" }), {
    harnessId: "codex",
    modelId: "gpt-6-astra",
  });
  assert.deepEqual(
    resolveRuntimeChoice(config, ORG, SCOPE, fallback, {
      harnessId: "codex",
      modelId: "gpt-6-astra",
      effortLevel: "max",
    }),
    { harnessId: "codex", modelId: "gpt-6-astra", effortLevel: "max" },
  );
});

test("a stored effort from before this check runs unset, warns once, and is replaced on the next save", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => warnings.push(message));
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex"]);
  const legacy = { harnessId: "codex" as const, modelId: "gpt-5.6-luna", effortLevel: "ultra" };
  config.setRuntimeSelection(SCOPE, legacy as ReturnType<typeof runtimeChoice>);
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-5-5" };
  for (let i = 0; i < 3; i++)
    assert.deepEqual(resolveRuntimeChoice(config, ORG, SCOPE, fallback), {
      harnessId: "codex",
      modelId: "gpt-5.6-luna",
    });
  assert.equal(storedEffort("codex", "gpt-5.6-luna", "ultra"), undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /stored effort ultra isn't available on codex\/gpt-5.6-luna/);
  const service = createRuntimeService({ config, harnessId: "pi" }, { authorizesCapabilityScope: async () => true });
  const claims = { actorId: "alice", scopeId: SCOPE, liveActor: true, exp: Date.now() + 60_000 } as const;
  const active = resolveRuntimeChoice(config, ORG, SCOPE, fallback);
  assert.equal((await service(claims, active, { action: "set", fastMode: false, lifetime: "scope" })).ok, true);
  assert.equal(config.getRuntimeSelection(SCOPE)?.effortLevel, "auto");
});

test("the web picker, admin settings and cron writers reject an effort the model does not offer", async () => {
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi", "claude", "codex"]);
  await built.config.flushScope(ORG);
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    harnessId: "pi",
    providerKeys: { anthropic: true, openai: true, openrouter: false },
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const put = await fetch(`${base}/v1/runtime-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: "U1",
        scopeId: "personal:U1",
        harnessId: "codex",
        modelId: "gpt-6-astra",
        effortLevel: "ultracode",
      }),
    });
    assert.equal(put.status, 400);
    assert.deepEqual(await put.json(), {
      error: "effort_not_supported",
      message: `effort ultracode isn't available on codex/gpt-6-astra (valid: ${valid("codex", "gpt-6-astra")})`,
    });
    assert.equal(await built.config.getRuntimeSelectionDurable("personal:U1"), null);
    await assert.rejects(
      built.app.createCron({
        ownerScopeId: "personal:U1",
        owner: "U1",
        createdBy: "U1",
        schedule: { everyMs: 60_000 },
        action: "ping",
        runtime: { harnessId: "pi", modelId: "claude-haiku-4-5", effortLevel: "high" },
      }),
      { message: `effort high isn't available on pi/claude-haiku-4-5 (valid: ${valid("pi", "claude-haiku-4-5")})` },
    );
    assert.deepEqual(await built.app.listCrons(), []);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a recovered legacy handoff keeps its harness and model and drops only the effort", (t) => {
  t.mock.method(console, "warn", () => {});
  const entry = {
    type: "tool_result",
    payload: {
      tool: "runtime",
      runId: "run",
      actorId: "alice",
      runtimeHandoff: { choice: { harnessId: "codex", modelId: "gpt-6-luna", effortLevel: "ultra", fastMode: false } },
    },
  } as unknown as SessionEntry;
  assert.deepEqual(recoveredRuntime([entry], "run", "alice"), {
    harnessId: "codex",
    modelId: "gpt-6-luna",
    fastMode: false,
  });
});
