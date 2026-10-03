import assert from "node:assert/strict";
import { test } from "node:test";
import { BASELINE, blockedReason, compile } from "../runtime/guard.mjs";
import { guardConfig, parseManifest } from "../scripts/lib.mjs";
import { systemPrompt } from "../src/boot-env.ts";
import { parseSource } from "../src/builds.ts";
import { MAX_DEPTH, nextChain } from "../src/delegation.ts";
import { MODEL_HOSTS, hostAllowed, modelKey } from "../src/policy.ts";

const BASE = `mirror.gcr.io/library/debian@sha256:${"a".repeat(64)}`;
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

test("the egress allowlist matches exact hosts, subdomain wildcards and the model API", () => {
  const allow = ["api.1password.com", "*.cloudflare.com"];
  assert.equal(hostAllowed("api.1password.com", allow), true);
  assert.equal(hostAllowed("API.1password.com.", allow), true);
  assert.equal(hostAllowed("evil-api.1password.com", allow), false);
  assert.equal(hostAllowed("api.cloudflare.com", allow), true);
  assert.equal(hostAllowed("cloudflare.com", allow), false);
  assert.equal(hostAllowed("notcloudflare.com", allow), false);
  assert.equal(hostAllowed("api.anthropic.com", []), false);
  assert.equal(hostAllowed("api.anthropic.com", MODEL_HOSTS), true);
  assert.equal(hostAllowed("example.com", []), false);
});

test("agent calls refuse loops and chains deeper than the limit", () => {
  assert.deepEqual(nextChain([], "a", "b"), ["a"]);
  assert.deepEqual(nextChain(["a"], "b", "c"), ["a", "b"]);
  assert.throws(() => nextChain(["a"], "b", "a"), /loop/);
  assert.throws(() => nextChain([], "a", "a"), /loop/);
  const deep = Array.from({ length: MAX_DEPTH }, (_, i) => `x${i}`);
  assert.throws(() => nextChain(deep, "y", "z"), /at most 4 deep/);
  assert.deepEqual(nextChain(deep.slice(1), "y", "z").length, MAX_DEPTH);
});

test("the command guard blocks baseline and agent rules for Bash only", () => {
  const rules = compile([
    ...BASELINE,
    { pattern: "op\\s+vault\\s+delete", reason: "deletes a vault" },
    { pattern: "wrangler delete" },
  ]);
  for (const command of [
    "rm -rf /",
    "rm -rf ~",
    "sudo rm -fr /*",
    "rm -r -f $HOME",
    "mkfs.ext4 /dev/sda",
    "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:",
  ])
    assert.ok(blockedReason(bash(command), rules), command);
  for (const command of [
    "rm -rf /tmp/x",
    "rm -rf ./build",
    "ls /",
    "echo dd",
    "op item get x",
    "dd if=a of=/dev/null",
    "echo mkfs-check",
    "docker run --rm -w / alpine ls",
    "docker run --rm -it --workdir / img sh",
    "which mkfs",
    "man mkfs",
  ])
    assert.equal(blockedReason(bash(command), rules), null, command);
  assert.equal(blockedReason(bash("OP   vault\n delete Shared"), rules), "this command deletes a vault");
  assert.match(blockedReason(bash("npx wrangler delete my-worker"), rules)!, /deny rule wrangler delete/);
  assert.equal(blockedReason({ tool_name: "Write", tool_input: { command: "rm -rf /" } }, rules), null);
});

test("agent.yaml egress and deny are validated and reach the guard config", () => {
  const m = parseManifest(
    `name: ops\ndescription: d\nbase: ${BASE}\negress: [API.example.com, "*.example.org"]\ndeny:\n  - "op vault delete"\n  - {pattern: "x+", reason: why}\n`,
  );
  assert.deepEqual(m.egress, ["api.example.com", "*.example.org"]);
  assert.deepEqual(JSON.parse(guardConfig(m)), {
    deny: [{ pattern: "op vault delete" }, { pattern: "x+", reason: "why" }],
  });
  assert.equal(parseManifest(`name: ops\ndescription: d\nbase: ${BASE}\n`).egress, null);
  assert.throws(
    () => parseManifest(`name: ops\ndescription: d\nbase: ${BASE}\negress: ["*", "https://x.io"]\ndeny: ["("]\n`),
    (e: Error) =>
      /egress\[0\]/.test(e.message) && /egress\[1\]/.test(e.message) && /deny\[0\] is not a valid/.test(e.message),
  );
});

test("the system prompt explains agent calls and any egress limit", () => {
  const open = systemPrompt({ id: "ops-main", agent: "ops" });
  assert.match(open, /agent-call <instance>/);
  assert.doesNotMatch(open, /Network access is limited/);
  assert.match(
    systemPrompt({ id: "ops-main", agent: "ops" }, ["api.example.com"]),
    /limited to these hosts: api\.example\.com/,
  );
});

test("build sources accept GitHub repos with plain refs and directories", () => {
  assert.deepEqual(parseSource({ repo: "https://github.com/csima/agent-x.git/" }), {
    repo: "https://github.com/csima/agent-x",
    ref: "",
    subdir: "",
    auto: true,
  });
  assert.deepEqual(
    parseSource({ repo: "https://github.com/a/b", ref: "release/v1", subdir: "agents/x", auto: false }),
    {
      repo: "https://github.com/a/b",
      ref: "release/v1",
      subdir: "agents/x",
      auto: false,
    },
  );
  for (const bad of [
    { repo: "https://gitlab.com/a/b" },
    { repo: "https://github.com/a/b/c" },
    { repo: "https://github.com/a/b", ref: "x y" },
    { repo: "https://github.com/a/b", subdir: "../up" },
    { repo: "https://github.com/a/b", ref: "--upload-pack=x" },
    { repo: "https://github.com/a/b", auto: "yes" },
  ])
    assert.throws(() => parseSource(bad), JSON.stringify(bad));
});

test("model API keys are read from either header", () => {
  assert.equal(modelKey(new Headers({ "x-api-key": "k1" })), "k1");
  assert.equal(modelKey(new Headers({ authorization: "Bearer t1" })), "t1");
  assert.equal(modelKey(new Headers({ authorization: "Basic x" })), null);
  assert.equal(modelKey(new Headers()), null);
});

test("egress wildcards on shared hosting suffixes are refused", () => {
  assert.throws(
    () => parseManifest(`name: ops\ndescription: d\nbase: ${BASE}\negress: ["*.workers.dev", "*.co.uk"]\n`),
    (e: Error) => /egress\[0\] \*\.workers\.dev would allow/.test(e.message) && /egress\[1\]/.test(e.message),
  );
  assert.deepEqual(
    parseManifest(`name: ops\ndescription: d\nbase: ${BASE}\negress: [a.workers.dev, A.workers.dev]\n`).egress,
    ["a.workers.dev"],
  );
});
