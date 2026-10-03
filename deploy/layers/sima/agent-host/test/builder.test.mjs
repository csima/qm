import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerfile, imagesToKeep, parseManifest, safeRelativePath, sqlString, versionId } from "../scripts/lib.mjs";

const BASE = `mirror.gcr.io/library/debian@sha256:${"a".repeat(64)}`;
const valid = `name: notes
description: Keeps notes
base: ${BASE}
setup: setup.sh
credentials:
  - name: NOTES_TOKEN
    description: token
`;

test("a valid manifest gets defaults for harness, instance and required", () => {
  const m = parseManifest(valid);
  assert.equal(m.harness, "claude");
  assert.equal(m.instance, "standard-1");
  assert.deepEqual(m.credentials, [{ name: "NOTES_TOKEN", description: "token", required: true }]);
});

test("manifest problems are all reported together", () => {
  const bad = `name: Bad Name
description: ""
base: debian:12
setup: ../escape.sh
harness: codex
instance: huge
extra: 1
credentials:
  - name: ANTHROPIC_API_KEY
    description: x
  - name: HOME
    description: x
  - name: OK
  - name: OK
    description: dup
`;
  let err;
  try {
    parseManifest(bad);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Error);
  for (const fragment of [
    "unknown field extra",
    "name must match",
    "description is required",
    "pinned by digest",
    "setup must be a relative path",
    "harness must be one of",
    "instance must be one of",
    "credentials[0].name",
    "credentials[1].name",
    "credentials[2].description",
    "credentials[3].name OK is duplicated",
  ])
    assert.match(err.message, new RegExp(fragment.replace(/[[\]().]/g, "\\$&")));
});

test("setup paths stay inside the repo and are shell-safe", () => {
  assert.equal(safeRelativePath("scripts/setup.sh"), true);
  for (const p of ["/abs", "a/../b", "./x", "a b", "x;rm", "it's", "", "a//b"])
    assert.equal(safeRelativePath(p), false, p);
});

test("the Dockerfile pins the base, runs setup with the build CA and pulls nothing from Docker Hub", () => {
  const text = dockerfile(parseManifest(valid), { version: "v1" });
  assert.match(text, new RegExp(`FROM ${BASE.replace(/[.]/g, "\\.")}`));
  assert.match(text, /cd \/agent && \.\/setup\.sh/);
  assert.match(text, /--mount=type=secret,id=buildca,required=false/);
  assert.doesNotMatch(text, /syntax=docker/);
  assert.match(text, /CMD \["\/usr\/local\/bin\/agent-idle"\]/);
});

test("versions encode time and commit, marking dirty trees", () => {
  const now = new Date("2026-10-03T15:26:40Z");
  assert.equal(versionId("4fb2dab6e3eb", now), "20261003t152640-4fb2dab6");
  assert.equal(versionId("4fb2dab6e3eb-dirty", now), "20261003t152640-4fb2dab6-dirty");
  assert.equal(versionId(null, now), "20261003t152640-local");
});

test("SQL strings escape quotes", () => {
  assert.equal(sqlString("it's"), "'it''s'");
  assert.equal(sqlString(null), "NULL");
});

test("deploy keeps the newest versions per agent plus any version an instance runs", () => {
  const versions = Array.from({ length: 7 }, (_, i) => ({
    agent: "notes",
    version: `v${i}`,
    image: `img${i}`,
    created_at: i,
  }));
  const images = imagesToKeep(versions, [{ agent: "notes", version: "v0" }], 3);
  assert.deepEqual(Object.keys(images).sort(), ["notes--v0", "notes--v4", "notes--v5", "notes--v6"]);
  assert.deepEqual(images["notes--v6"], { image: "img6" });
});
