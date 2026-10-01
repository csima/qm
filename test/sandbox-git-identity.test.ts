import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { nonInteractiveShellPrefix } from "../src/sandbox/sandbox-env.ts";

const configured = {
  FLY_RESIDENT_ENV_GIT_AUTHOR_NAME: "O'Brien $(echo unsafe)",
  FLY_RESIDENT_ENV_GIT_AUTHOR_EMAIL: "123+account@users.noreply.github.com",
};
const inspect = (env: NodeJS.ProcessEnv, command = "") =>
  execFileSync(
    "sh",
    [
      "-c",
      nonInteractiveShellPrefix(env) +
        command +
        'printf "%s|%s|%s|%s" "$GIT_AUTHOR_NAME" "$GIT_AUTHOR_EMAIL" "$GIT_COMMITTER_NAME" "$GIT_COMMITTER_EMAIL"',
    ],
    { env: {} },
  ).toString();

test("configured author also supplies committer without shell interpolation", () => {
  assert.equal(
    inspect(configured),
    `${configured.FLY_RESIDENT_ENV_GIT_AUTHOR_NAME}|${configured.FLY_RESIDENT_ENV_GIT_AUTHOR_EMAIL}|${configured.FLY_RESIDENT_ENV_GIT_AUTHOR_NAME}|${configured.FLY_RESIDENT_ENV_GIT_AUTHOR_EMAIL}`,
  );
});
test("explicit committer and per-command account overrides win", () => {
  assert.match(
    inspect({
      ...configured,
      FLY_RESIDENT_ENV_GIT_COMMITTER_NAME: "Bot",
      FLY_RESIDENT_ENV_GIT_COMMITTER_EMAIL: "bot@example.invalid",
    }),
    /\|Bot\|bot@example.invalid$/,
  );
  assert.equal(
    inspect(
      configured,
      "export GIT_AUTHOR_NAME=Bob GIT_AUTHOR_EMAIL=bob@example.invalid GIT_COMMITTER_NAME=Bob GIT_COMMITTER_EMAIL=bob@example.invalid; ",
    ),
    "Bob|bob@example.invalid|Bob|bob@example.invalid",
  );
});
test("missing configuration does not infer identity or forward credentials", () => {
  assert.equal(inspect({ GIT_AUTHOR_NAME: "Host operator", FLY_RESIDENT_ENV_GITHUB_TOKEN: "never-forward" }), "|||");
  assert.doesNotMatch(nonInteractiveShellPrefix({ FLY_RESIDENT_ENV_GITHUB_TOKEN: "never-forward" }), /never-forward/);
  assert.equal(inspect({}), "|||");
});
test("partial and blank identities fail closed", () => {
  for (const role of ["AUTHOR", "COMMITTER"]) {
    assert.throws(
      () => nonInteractiveShellPrefix({ [`FLY_RESIDENT_ENV_GIT_${role}_NAME`]: "Alice" }),
      /both NAME and EMAIL/,
    );
    assert.throws(
      () => nonInteractiveShellPrefix({ [`FLY_RESIDENT_ENV_GIT_${role}_EMAIL`]: "alice@example.invalid" }),
      /both NAME and EMAIL/,
    );
    assert.throws(
      () =>
        nonInteractiveShellPrefix({
          [`FLY_RESIDENT_ENV_GIT_${role}_NAME`]: " ",
          [`FLY_RESIDENT_ENV_GIT_${role}_EMAIL`]: "alice@example.invalid",
        }),
      /both NAME and EMAIL/,
    );
  }
});
