import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { sandboxGitIdentityEnv } from "../src/sandbox/sandbox-env.ts";
import { shq } from "../src/util/shell.ts";
const configured = {
  GIT_AUTHOR_NAME: "O'Brien $(echo unsafe)",
  GIT_AUTHOR_EMAIL: "123+account@users.noreply.github.com",
};

test("configured author defaults committer and remains literal in a shell", () => {
  const identity = sandboxGitIdentityEnv(configured);
  assert.equal(identity.GIT_COMMITTER_NAME, configured.GIT_AUTHOR_NAME);
  assert.equal(identity.GIT_COMMITTER_EMAIL, configured.GIT_AUTHOR_EMAIL);
  const exports = Object.entries(identity)
    .map(([key, value]) => `export ${key}=${shq(value)}; `)
    .join("");
  assert.equal(
    execFileSync("sh", ["-c", exports + 'printf "%s" "$GIT_AUTHOR_NAME"'], { env: {} }).toString(),
    configured.GIT_AUTHOR_NAME,
  );
});
test("scoped author replaces both fallback roles and explicit committer wins", () => {
  const scoped = { GIT_AUTHOR_NAME: "Bob", GIT_AUTHOR_EMAIL: "bob@example.invalid" };
  assert.deepEqual(
    sandboxGitIdentityEnv(
      { ...configured, GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: "operator@example.invalid" },
      scoped,
    ),
    { ...scoped, GIT_COMMITTER_NAME: "Bob", GIT_COMMITTER_EMAIL: "bob@example.invalid" },
  );
  assert.equal(
    sandboxGitIdentityEnv(configured, { GIT_COMMITTER_NAME: "Bot", GIT_COMMITTER_EMAIL: "bot@example.invalid" })
      .GIT_COMMITTER_NAME,
    "Bot",
  );
});
test("missing identity does not invent an account or forward credentials", () => {
  assert.deepEqual(sandboxGitIdentityEnv({ GITHUB_TOKEN: "never-forward" }), {});
  assert.deepEqual(sandboxGitIdentityEnv({}), {});
});
test("partial and blank operator or scoped identities fail closed", () => {
  for (const role of ["AUTHOR", "COMMITTER"]) {
    for (const pair of [
      { [`GIT_${role}_NAME`]: "Alice" },
      { [`GIT_${role}_EMAIL`]: "alice@example.invalid" },
      { [`GIT_${role}_NAME`]: " ", [`GIT_${role}_EMAIL`]: "alice@example.invalid" },
    ]) {
      assert.throws(() => sandboxGitIdentityEnv(pair), /both NAME and EMAIL/);
      assert.throws(() => sandboxGitIdentityEnv(configured, pair), /both NAME and EMAIL/);
    }
  }
});
