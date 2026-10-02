import { pollProcess } from "../src/sandbox/process-poll.ts";
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloudflareSandbox, SandboxBootLostError } from "../src/sandbox/cloudflare-sandbox.ts";
import { sandboxScopeName } from "../src/sandbox/exec-sandbox-base.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";
import { createMemorySnapshotStore } from "../src/sandbox/home-snapshot.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { instrumentedSnapshotStore } from "./support/snapshot-stores.ts";
import {
  installFakeCloudflareSandbox,
  FAKE_CLOUDFLARE_SANDBOX_TOKEN,
  FAKE_CLOUDFLARE_SANDBOX_URL,
  type FakeCloudflareSandbox,
} from "./support/fake-cloudflare-sandbox.ts";
import type { StoredCloudflareSandbox } from "../src/sandbox/cloudflare-sandbox.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

let fake: FakeCloudflareSandbox;
let sandbox: Sandbox;
const scope = scopeId("personal", "tester");
const layers = [{ scopeId: scope, mountPath: "/", mode: "rw" as const }];
const scopeName = (): string => sandboxScopeName("qmt", scope);

function make(extra: Record<string, unknown> = {}): Sandbox {
  return createCloudflareSandbox(createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "cf-ws-"))), {
    url: FAKE_CLOUDFLARE_SANDBOX_URL,
    token: FAKE_CLOUDFLARE_SANDBOX_TOKEN,
    namePrefix: "qmt",
    fetchImpl: fake.fetchImpl,
    snapshots: createMemorySnapshotStore(),
    ...extra,
  });
}

beforeEach(() => {
  fake = installFakeCloudflareSandbox();
  sandbox = make();
});
after(() => fake?.cleanup());

test("a url, a token and a snapshot store are required", () => {
  const ws = () => createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "cf-ws-")));
  assert.throws(() => createCloudflareSandbox(ws()), /CLOUDFLARE_SANDBOX_URL/);
  assert.throws(
    () => createCloudflareSandbox(ws(), { url: FAKE_CLOUDFLARE_SANDBOX_URL, token: FAKE_CLOUDFLARE_SANDBOX_TOKEN }),
    /CLOUDFLARE_SANDBOX_SNAPSHOT_S3_BUCKET/,
  );
});

test("provision starts the sandbox and runs commands with env and cwd", async () => {
  const h = await sandbox.provision(layers, { env: { MY_VAR: "v1" } });
  assert.equal(h.coldStart, true);
  assert.equal(h.id, scopeName());
  const r = await sandbox.run(h, "pwd; echo VAR=$MY_VAR");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /workspace/);
  assert.match(r.stdout, /VAR=v1/);
});

test("streams and exit codes are exact and every call pins the boot it was issued", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "echo out; echo err >&2; exit 3");
  assert.equal(r.code, 3);
  assert.equal(r.stdout.trim(), "out");
  assert.equal(r.stderr.trim(), "err");
  const pinned = fake.calls.filter((c) => c.path.endsWith("/exec") || c.path.endsWith("/files"));
  assert.ok(pinned.length);
  assert.ok(pinned.every((c) => c.boot === fake.bootOf(h.id)));
});

test("exit code 124 from the sandbox's timeout is reported as a timeout", async () => {
  const h = await sandbox.provision(layers);
  const r = await sandbox.run(h, "exit 124");
  assert.equal(r.timedOut, true);
});

test("file roundtrip incl. large binary, empty and missing files", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.writeFile(h, "a/b.txt", "hello\n");
  assert.equal(await sandbox.readFile(h, "a/b.txt"), "hello\n");
  assert.equal(await sandbox.readFile(h, "nope.txt"), null);
  const big = Buffer.alloc(1300 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 13) % 256;
  await sandbox.writeFileBytes(h, "big.bin", big);
  const back = await sandbox.readFileBytes(h, "big.bin");
  assert.ok(back && Buffer.from(back).equals(big));
  await sandbox.writeFileBytes(h, "empty.bin", Buffer.alloc(0));
  assert.equal((await sandbox.readFileBytes(h, "empty.bin"))?.length, 0);
});

test("process sessions capability works end to end", async () => {
  assert.ok(supportsProcessSessions(sandbox));
  if (!supportsProcessSessions(sandbox)) return;
  const h = await sandbox.provision(layers);
  const { processId } = await sandbox.startProcess(h, "echo one; echo two");
  const { output, status } = await pollProcess(sandbox, h, processId, { deadlineMs: 5_000, waitMs: 100 });
  assert.equal(status.state, "exited");
  assert.match(output, /one/);
  assert.match(output, /two/);
});

test("a running sandbox is reused across provisions as a warm start", async () => {
  const a = await sandbox.provision(layers);
  await sandbox.writeFile(a, "kept.txt", "still here\n");
  await sandbox.teardown(a);
  const b = await sandbox.provision(layers);
  assert.equal(b.coldStart, false);
  assert.equal(await sandbox.readFile(b, "kept.txt"), "still here\n");
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/start")).length, 1);
});

test("a sandbox that stopped for inactivity is restarted and its home restored from the snapshot", async () => {
  const snapshots = createMemorySnapshotStore();
  const s = make({ snapshots });
  const a = await s.provision(layers);
  await s.writeFile(a, "notes.txt", "keep me\n");
  await s.teardown(a);
  assert.ok(await snapshots.open(scope));
  fake.stop(a.id);
  assert.equal((await s.computerStatus!(scope)).lifecycleState, "paused");
  assert.equal(fake.running(a.id), false, "status never starts a stopped sandbox");
  const b = await s.provision(layers);
  assert.equal(b.coldStart, false, "a restored home is not a cold start");
  assert.equal(await s.readFile(b, "notes.txt"), "keep me\n");
});

test("a sandbox that restarts mid-turn fails loudly instead of running on an empty disk", async () => {
  const snapshots = createMemorySnapshotStore();
  const s = make({ snapshots });
  const a = await s.provision(layers);
  await s.writeFile(a, "saved.txt", "saved\n");
  await s.teardown(a);
  const h = await s.provision(layers);
  await s.writeFile(h, "unsaved.txt", "lost\n");
  fake.restart(h.id);
  await assert.rejects(s.run(h, "ls"), SandboxBootLostError);
  await assert.rejects(s.readFile(h, "saved.txt"), SandboxBootLostError);
  const next = await s.provision(layers);
  assert.equal(await s.readFile(next, "saved.txt"), "saved\n");
  assert.equal(await s.readFile(next, "unsaved.txt"), null);
});

test("a handle from before a restart keeps failing after another turn restored the sandbox", async () => {
  const held = await sandbox.provision(layers);
  await sandbox.writeFile(held, "saved.txt", "v1\n");
  await sandbox.teardown(held);
  const stale = await sandbox.provision(layers);
  await sandbox.writeFile(stale, "unsaved.txt", "x");
  fake.stop(stale.id);
  const fresh = await sandbox.provision(layers);
  assert.equal(await sandbox.readFile(fresh, "saved.txt"), "v1\n");
  await assert.rejects(sandbox.run(stale, "true"), SandboxBootLostError);
  await assert.rejects(sandbox.readFile(stale, "saved.txt"), SandboxBootLostError);
  await assert.rejects(sandbox.writeFile(stale, "late.txt", "x"), SandboxBootLostError);
  assert.equal((await sandbox.run(fresh, "echo ok")).stdout.trim(), "ok");
});

test("a handle from before a restart fails on a core that did not see the restart", async () => {
  const store = createMemoryMap<StoredCloudflareSandbox>();
  const advisoryLock = createMemoryAdvisoryLock();
  const snapshots = createMemorySnapshotStore();
  const a = make({ snapshots, store, advisoryLock });
  const b = make({ snapshots, store, advisoryLock });
  const ha = await a.provision(layers);
  await a.writeFile(ha, "shared.txt", "v1\n");
  await a.teardown(ha);
  const held = await a.provision(layers);
  await a.writeFile(held, "unsaved.txt", "x");
  fake.stop(held.id);
  const hb = await b.provision(layers);
  assert.equal(await b.readFile(hb, "shared.txt"), "v1\n");
  await assert.rejects(a.readFile(held, "shared.txt"), SandboxBootLostError);
  const again = await a.provision(layers);
  assert.equal(await a.readFile(again, "unsaved.txt"), null);
});

test("a teardown on a stale handle never overwrites the snapshot", async () => {
  const counting = instrumentedSnapshotStore();
  const errors: string[] = [];
  const s = make({ snapshots: counting.store, onError: (e: { code: string }) => errors.push(e.code) });
  const first = await s.provision(layers);
  await s.writeFile(first, "keep.txt", "good\n");
  await s.teardown(first);
  const stale = await s.provision(layers);
  fake.stop(stale.id);
  const fresh = await s.provision(layers);
  const puts = counting.puts();
  await s.teardown(stale);
  assert.equal(counting.puts(), puts, "the stale handle's empty boot is not snapshotted");
  assert.ok(errors.includes("teardown_snapshot_failed"));
  assert.equal((await s.computerStatus!(scope)).recovery?.error, undefined, "a lost boot is not a snapshot failure");
  assert.equal(await s.readFile(fresh, "keep.txt"), "good\n");
});

test("a failed hydration deletes the empty sandbox and never cold-starts over the snapshot", async () => {
  const flaky = instrumentedSnapshotStore();
  const errors: string[] = [];
  const s = make({ snapshots: flaky.store, onError: (e: { code: string }) => errors.push(e.code) });
  const a = await s.provision(layers);
  await s.writeFile(a, "precious.txt", "irreplaceable\n");
  await s.teardown(a);
  fake.stop(a.id);
  flaky.failReads(true);
  await assert.rejects(s.provision(layers), /hydration failed/);
  assert.ok(errors.includes("hydrate_failed"));
  assert.equal(fake.running(a.id), false);
  flaky.failReads(false);
  const b = await s.provision(layers);
  assert.equal(await s.readFile(b, "precious.txt"), "irreplaceable\n");
});

test("every teardown of a changed home snapshots it and scratch sandboxes are never snapshotted", async () => {
  const counting = instrumentedSnapshotStore();
  const s = make({ snapshots: counting.store });
  await s.teardown(await s.provision(layers));
  await s.teardown(await s.provision(layers));
  assert.equal(counting.puts(), 2);
  await s.teardown(await s.provision(layers), { homeUnchanged: true });
  assert.equal(counting.puts(), 2, "an unchanged, already-snapshotted home is not snapshotted again");
  await s.teardown(await s.provision(layers, { scratch: { key: "job" } }));
  assert.equal(counting.puts(), 2);
});

test("persistHomeSnapshot stores the home on demand", async () => {
  const snapshots = createMemorySnapshotStore();
  const s = make({ snapshots });
  const h = await s.provision(layers);
  await s.writeFile(h, "explicit.txt", "saved\n");
  await s.persistHomeSnapshot!(scope);
  fake.stop(h.id);
  const next = await s.provision(layers);
  assert.equal(await s.readFile(next, "explicit.txt"), "saved\n");
});

test("scratch sandboxes are fresh and deleted at release", async () => {
  const h = await sandbox.provision(layers, { scratch: { key: "job-1" } });
  assert.equal(h.scratch, true);
  assert.ok(fake.names().includes(h.id));
  await sandbox.teardown(h);
  assert.ok(!fake.names().includes(h.id));
});

test("computerStatus distinguishes never provisioned, running and stopped", async () => {
  assert.deepEqual(await sandbox.computerStatus!(scope), {
    recovery: { strategy: "workspace_snapshot" },
    machine: "no sandbox provisioned yet",
    provisioned: false,
    guestResponsive: false,
  });
  const h = await sandbox.provision(layers);
  const running = await sandbox.computerStatus!(scope);
  assert.equal(running.lifecycleState, "running");
  assert.equal(running.guestResponsive, true);
  fake.stop(h.id);
  const stopped = await sandbox.computerStatus!(scope);
  assert.equal(stopped.lifecycleState, "paused");
  assert.equal(stopped.provisioned, true);
});

test("destroyScope deletes the sandbox and forgets its boot", async () => {
  const h = await sandbox.provision(layers);
  await sandbox.destroyScope!(scope);
  assert.deepEqual(fake.names(), []);
  await sandbox.destroyScope!(scope);
  const again = await sandbox.provision(layers);
  assert.equal(again.coldStart, true);
  assert.notEqual(fake.bootOf(h.id), undefined);
});

test("a start the platform refuses surfaces the error and retries cleanly", async () => {
  fake.failStarts(true);
  await assert.rejects(sandbox.provision(layers), /500/);
  fake.failStarts(false);
  const h = await sandbox.provision(layers);
  assert.equal((await sandbox.run(h, "echo ok")).stdout.trim(), "ok");
});

test("profile advertises snapshot persistence, process sessions and no egress enforcement", () => {
  assert.equal(sandbox.profile.backend, "cloudflare");
  assert.equal(sandbox.profile.writablePersistence, "snapshot_to_workspace");
  assert.equal(sandbox.profile.processSessions, true);
  assert.equal(sandbox.profile.egressEnforcement, "none");
  assert.equal(typeof sandbox.persistHomeSnapshot, "function");
});
