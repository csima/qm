import assert from "node:assert/strict";
import { test } from "node:test";
import { canUse } from "../src/access.ts";
import { PRIVATE_SUFFIX, lastUserText, modelsFor, replyText } from "../src/chat-format.ts";
import { applyChange, missingRequired, parseChange } from "../src/credentials.ts";
import type { InstanceRow, Manifest } from "../src/env.ts";
import { parseEmailList } from "../src/policy.ts";
import type { TaskRow } from "../src/store.ts";

const manifest: Manifest = {
  name: "notes",
  description: "d",
  base: "b",
  setup: null,
  harness: "claude",
  instance: "standard-1",
  credentials: [
    { name: "NOTES_TOKEN", description: "t", required: true },
    { name: "EXTRA", description: "e", required: false },
  ],
};

const who = (email: string, admin = false) => ({ email, via: "access" as const, admin });

test("credential changes accept declared and model names only, and validate values", () => {
  assert.deepEqual(parseChange({ set: { NOTES_TOKEN: "a", ANTHROPIC_API_KEY: "k" }, clear: ["EXTRA"] }, manifest), {
    set: { NOTES_TOKEN: "a", ANTHROPIC_API_KEY: "k" },
    clear: ["EXTRA"],
  });
  assert.throws(() => parseChange({ set: { PATH: "/x" } }, manifest), /not a credential/);
  assert.throws(() => parseChange({ clear: ["HOME"] }, manifest), /not a credential/);
  assert.throws(() => parseChange({ set: { NOTES_TOKEN: "" } }, manifest), /non-empty/);
  assert.throws(() => parseChange({ set: { NOTES_TOKEN: "x".repeat(20_000) } }, manifest), /at most/);
  assert.throws(() => parseChange({ set: [] }, manifest), /object/);
});

test("applying a change sets, clears, and lets a set win over a clear of the same name", () => {
  const current = { NOTES_TOKEN: "old", EXTRA: "e" };
  assert.deepEqual(applyChange(current, { set: { NOTES_TOKEN: "new" }, clear: ["EXTRA"] }), { NOTES_TOKEN: "new" });
  assert.deepEqual(applyChange(current, { set: { EXTRA: "x" }, clear: ["EXTRA"] }), { NOTES_TOKEN: "old", EXTRA: "x" });
  assert.deepEqual(current, { NOTES_TOKEN: "old", EXTRA: "e" });
  assert.deepEqual(missingRequired(manifest, { EXTRA: "x" }), ["NOTES_TOKEN"]);
  assert.deepEqual(missingRequired(manifest, { NOTES_TOKEN: "x" }), []);
});

test("agent use lists: admins always, otherwise listed emails or everyone", () => {
  assert.equal(canUse(who("a@b.io", true), []), true);
  assert.equal(canUse(who("a@b.io"), []), false);
  assert.equal(canUse(who("a@b.io"), ["a@b.io"]), true);
  assert.equal(canUse(who("a@b.io"), ["*"]), true);
  assert.deepEqual(parseEmailList([" A@B.io ", "a@b.io", "*"], "use"), ["a@b.io", "*"]);
  assert.throws(() => parseEmailList(["nope"], "use"), /invalid entry/);
});

const row = (id: string, over: Partial<InstanceRow> = {}): InstanceRow => ({
  id,
  agent: "notes",
  version: "v",
  owner: "o@x.io",
  sharing: { message: [], attach: [], admin: [] },
  size: "standard-1",
  status: "running",
  last_error: null,
  ephemeral: 0,
  created_at: 0,
  updated_at: 0,
  ...over,
});

test("LibreChat models: instances you can message, private variants only where you administer, never one-off runs", () => {
  const rows = [
    row("mine"),
    row("shared", { owner: "z@x.io", sharing: { message: ["m@x.io"], attach: [], admin: [] } }),
    row("run-notes-1", { ephemeral: 1 }),
  ];
  assert.deepEqual(modelsFor(who("o@x.io"), rows), ["mine", `mine${PRIVATE_SUFFIX}`]);
  assert.deepEqual(modelsFor(who("m@x.io"), rows), ["shared"]);
  assert.deepEqual(modelsFor(null, rows), []);
});

test("the last user message is used, whether text or content parts", () => {
  assert.equal(
    lastUserText([
      { role: "user", content: "first" },
      { role: "assistant", content: "x" },
      { role: "user", content: "second" },
    ]),
    "second",
  );
  assert.equal(
    lastUserText([
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "image_url", image_url: {} },
          { type: "text", text: "b" },
        ],
      },
    ]),
    "a\nb",
  );
  assert.equal(lastUserText([{ role: "system", content: "s" }]), "");
  assert.equal(lastUserText("nope"), "");
});

test("replies cover done, failed and still-running tasks", () => {
  const base = { id: "t_1", status: "done", result: "ok", error: null } as unknown as TaskRow;
  assert.equal(replyText(base, row("mine"), "https://h"), "ok");
  assert.match(
    replyText({ ...base, status: "failed", error: "boom" }, row("mine"), "https://h"),
    /could not finish this: boom/,
  );
  assert.match(replyText({ ...base, status: "running" }, row("mine"), "https://h"), /https:\/\/h\/i\/mine/);
});

test("non-admins can only share with people on the agent's use list", async () => {
  const { outsideUseList } = await import("../src/instances.ts");
  const sharing = { message: ["a@x.io", "*"], attach: ["b@x.io"], admin: [] };
  assert.deepEqual(outsideUseList(sharing, ["a@x.io", "b@x.io"]), ["*"]);
  assert.deepEqual(outsideUseList(sharing, ["*"]), []);
  assert.deepEqual(outsideUseList({ message: ["c@x.io"], attach: [], admin: ["c@x.io"] }, ["a@x.io"]), ["c@x.io"]);
});

test("task input is validated before anything is created", async () => {
  const { validateTask } = await import("../src/tasks.ts");
  assert.deepEqual(validateTask({ message: "hi" }), { message: "hi", session: "main", callbackUrl: null });
  assert.throws(() => validateTask({ message: "  " }), /message must be/);
  assert.throws(() => validateTask({ message: "hi", callbackUrl: "http://x" }), /https/);
  assert.throws(() => validateTask({ message: "hi", session: 3 }), /session/);
});
