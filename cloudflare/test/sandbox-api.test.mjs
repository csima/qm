import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_WRITE_BYTES,
  authorizedSandboxCaller,
  routeSandboxRequest,
  sandboxIdleMs,
  sandboxInstance,
} from "../src/sandbox-api.ts";

const BOOT = "boot-1";

function fakeStub() {
  const files = new Map();
  const calls = [];
  return {
    calls,
    stub: {
      status: async () => ({ running: true, bootId: BOOT }),
      start: async () => ({ bootId: BOOT }),
      exec: async (boot, script, timeoutSec) => {
        calls.push(["exec", boot, script, timeoutSec]);
        return boot === BOOT ? { ok: { stdout: "out", stderr: "", code: 0 } } : { lost: true };
      },
      writeFile: async (boot, path, data) => {
        if (boot !== BOOT) return { lost: true };
        assert.ok(data instanceof Uint8Array);
        files.set(path, data);
        return { ok: true };
      },
      readFile: async (boot, path) => {
        if (boot !== BOOT) return { lost: true };
        const bytes = files.get(path);
        return { ok: bytes ? new Response(bytes).body : null };
      },
      remove: async () => {
        calls.push(["remove"]);
      },
    },
  };
}

const call = (stub, path, init = {}) =>
  routeSandboxRequest(new Request(`http://sandbox.qm.internal${path}`, init), (name) => {
    stub.name = name;
    return stub;
  });

test("only a bearer token that matches exactly is accepted", () => {
  const req = (auth) =>
    new Request("http://sandbox.qm.internal/v1/sandboxes/x", { headers: auth ? { authorization: auth } : {} });
  assert.equal(authorizedSandboxCaller(req("Bearer secret"), "secret"), true);
  assert.equal(authorizedSandboxCaller(req("Bearer secreT"), "secret"), false);
  assert.equal(authorizedSandboxCaller(req("Bearer secret2"), "secret"), false);
  assert.equal(authorizedSandboxCaller(req(), "secret"), false);
  assert.equal(authorizedSandboxCaller(req("Bearer "), undefined), false);
  assert.equal(authorizedSandboxCaller(req("Bearer "), " "), false);
});

test("sandbox names and file paths are validated before any object is touched", async () => {
  const { stub } = fakeStub();
  for (const path of [
    "/v1/sandboxes/UPPER",
    "/v1/sandboxes/-lead",
    "/v1/sandboxes/a/b",
    "/v2/sandboxes/a",
    "/v1/sandboxes/a/nope",
  ]) {
    assert.equal((await call(stub, path)).status, 404, path);
  }
  for (const q of ["", "?path=relative", "?path=/root/../etc/passwd"]) {
    const res = await call(stub, `/v1/sandboxes/a/files${q}`, { headers: { "x-qm-boot": BOOT } });
    assert.equal(res.status, 400, q);
  }
});

test("status, start and delete map to the sandbox object", async () => {
  const { stub, calls } = fakeStub();
  assert.deepEqual(await (await call(stub, "/v1/sandboxes/qm-a")).json(), { running: true, bootId: BOOT });
  assert.equal(stub.name, "qm-a");
  assert.deepEqual(await (await call(stub, "/v1/sandboxes/qm-a/start", { method: "POST" })).json(), { bootId: BOOT });
  assert.equal((await call(stub, "/v1/sandboxes/qm-a", { method: "DELETE" })).status, 204);
  assert.deepEqual(calls.at(-1), ["remove"]);
  assert.equal((await call(stub, "/v1/sandboxes/qm-a/start")).status, 405);
});

test("exec forwards the pinned boot and reports a lost boot as 409", async () => {
  const { stub, calls } = fakeStub();
  const exec = (boot, body) =>
    call(stub, "/v1/sandboxes/qm-a/exec", {
      method: "POST",
      headers: { "x-qm-boot": boot, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ok = await exec(BOOT, { script: "echo hi", timeoutSec: 30 });
  assert.deepEqual(await ok.json(), { stdout: "out", stderr: "", code: 0 });
  assert.deepEqual(calls.at(-1), ["exec", BOOT, "echo hi", 30]);
  assert.equal((await exec("old-boot", { script: "echo hi", timeoutSec: 30 })).status, 409);
  assert.equal((await exec(BOOT, { script: "echo hi" })).status, 400);
  assert.equal((await exec(BOOT, { script: "echo hi", timeoutSec: 0 })).status, 400);
});

test("files stream both ways, missing files are 404 and a lost boot is 409", async () => {
  const { stub } = fakeStub();
  const path = `/v1/sandboxes/qm-a/files?path=${encodeURIComponent("/root/a b.bin")}`;
  const bytes = new Uint8Array([0, 1, 2, 255]);
  assert.equal((await call(stub, path, { method: "PUT", headers: { "x-qm-boot": BOOT }, body: bytes })).status, 204);
  const back = await call(stub, path, { headers: { "x-qm-boot": BOOT } });
  assert.deepEqual(new Uint8Array(await back.arrayBuffer()), bytes);
  const missing = await call(stub, `/v1/sandboxes/qm-a/files?path=/root/none`, { headers: { "x-qm-boot": BOOT } });
  assert.equal(missing.status, 404);
  assert.equal((await call(stub, path, { headers: { "x-qm-boot": "stale" } })).status, 409);
  const tooBig = new Uint8Array(MAX_WRITE_BYTES + 1);
  assert.equal((await call(stub, path, { method: "PUT", headers: { "x-qm-boot": BOOT }, body: tooBig })).status, 413);
});

test("instance size and idle timeout come from Worker vars with safe defaults", () => {
  assert.equal(sandboxInstance({}), "standard-3");
  assert.equal(sandboxInstance({ QM_SANDBOX_INSTANCE: "standard-4" }), "standard-4");
  assert.throws(() => sandboxInstance({ QM_SANDBOX_INSTANCE: "huge" }), /QM_SANDBOX_INSTANCE/);
  assert.equal(sandboxIdleMs({}), 30 * 60_000);
  assert.equal(sandboxIdleMs({ QM_SANDBOX_IDLE_MINUTES: "5" }), 5 * 60_000);
  assert.equal(sandboxIdleMs({ QM_SANDBOX_IDLE_MINUTES: "9999" }), 360 * 60_000);
  assert.throws(() => sandboxIdleMs({ QM_SANDBOX_IDLE_MINUTES: "0" }), /QM_SANDBOX_IDLE_MINUTES/);
});
