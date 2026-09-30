import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolContext } from "../src/tools/primitives.ts";
import { createAttachStaging } from "../src/core/orchestrator/attach-tool.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { scopeId, personalScope } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const ws = () => createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "reqdeliv-")));

function memSandbox(seed: Record<string, Uint8Array> = {}): { sandbox: Sandbox; files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>(Object.entries(seed));
  const sandbox = {
    async writeFile(_h: SandboxHandle, rel: string, data: string) {
      files.set(rel, new TextEncoder().encode(data));
    },
    async readFile(_h: SandboxHandle, rel: string) {
      const b = files.get(rel);
      return b ? new TextDecoder().decode(b) : null;
    },
    async writeFileBytes(_h: SandboxHandle, rel: string, data: Uint8Array) {
      files.set(rel, data);
    },
    async readFileBytes(_h: SandboxHandle, rel: string) {
      return files.get(rel) ?? null;
    },
  } as unknown as Sandbox;
  return { sandbox, files };
}

// Reproduces the exact turn shape from qm#851: the agent has an existing writable
// sandbox (the user's own personal DM scope) and calls the `write` tool's `share`
// parameter targeting the *same requesting user's* personal scope — the pattern a
// model takes instead of the sanctioned `attach` tool.
test("write+share to the requesting user's own scope delivers a transcript attachment (qm#851)", async () => {
  const workspace = ws();
  const acl = createAclStore();
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const blobTransfer = createMemoryBlobTransferStore();
  const requester = "U1";
  const requesterScope = personalScope(requester);
  const handle: SandboxHandle = { id: "h", rootDir: "/workspace" } as SandboxHandle;
  const box = memSandbox();
  const provision = async () => handle;

  const attachStaging = createAttachStaging({
    sandbox: box.sandbox,
    provision,
    blobTransfer,
    fileRegistration: { store: files, ownerScopeId: requesterScope, createdBy: requester, seed: "run-1" },
  });

  const ctx = createToolContext({
    sandbox: box.sandbox,
    provision,
    layers: [{ scopeId: requesterScope, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace,
    deploy: {} as never,
    acl,
    files,
    createdBy: requester,
    attach: attachStaging.attach,
    deliverShareToRequester: attachStaging.attach,
    requesterScopeId: requesterScope,
  });

  const result = await ctx.write("report.xlsx", "edited workbook bytes", [
    { scope: requesterScope, permission: "read" },
  ]);

  // The ACL side of the bug already worked before the fix — the file is granted.
  assert.deepEqual(result.shared, [{ scope: requesterScope, permission: "read" }]);
  assert.deepEqual((await acl.list())[0]?.granteeScopeId, requesterScope);

  // What #851 says is missing: a visible transcript delivery. After the fix, the
  // same staging pipeline the sanctioned `attach` tool uses has the file queued
  // for this turn's outgoing delivery.
  const staged = attachStaging.staged();
  assert.equal(staged.length, 1, "expected the shared file to be staged for delivery like an explicit attach() call");
  assert.equal(staged[0]!.name, "report.xlsx");
});

test("write+share to a channel does not leak a requester-private staged attachment", async () => {
  const workspace = ws();
  const acl = createAclStore();
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const blobTransfer = createMemoryBlobTransferStore();
  const requester = "U1";
  const requesterScope = personalScope(requester);
  const channelScope = scopeId("channel", "C1");
  const handle: SandboxHandle = { id: "h", rootDir: "/workspace" } as SandboxHandle;
  const box = memSandbox();
  const provision = async () => handle;

  const attachStaging = createAttachStaging({
    sandbox: box.sandbox,
    provision,
    blobTransfer,
    fileRegistration: { store: files, ownerScopeId: requesterScope, createdBy: requester, seed: "run-2" },
  });

  // deliverShareToRequester is intentionally omitted here, the same way the
  // orchestrator omits it for a non-DM (e.g. channel) turn, so a share aimed at a
  // channel — not the exact requester — never triggers the requester-delivery path.
  const ctx = createToolContext({
    sandbox: box.sandbox,
    provision,
    layers: [{ scopeId: requesterScope, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace,
    deploy: {} as never,
    acl,
    files,
    createdBy: requester,
    requesterScopeId: requesterScope,
  });

  await ctx.write("report.xlsx", "edited workbook bytes", [{ scope: channelScope, permission: "read" }]);

  assert.equal(attachStaging.staged().length, 0, "a channel-targeted share must never auto-stage an attachment");
});

test("write+share to someone else's scope does not trigger the requester-delivery path", async () => {
  const workspace = ws();
  const acl = createAclStore();
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const blobTransfer = createMemoryBlobTransferStore();
  const requester = "U1";
  const requesterScope = personalScope(requester);
  const otherUserScope = personalScope("U2");
  const handle: SandboxHandle = { id: "h", rootDir: "/workspace" } as SandboxHandle;
  const box = memSandbox();
  const provision = async () => handle;

  const attachStaging = createAttachStaging({
    sandbox: box.sandbox,
    provision,
    blobTransfer,
    fileRegistration: { store: files, ownerScopeId: requesterScope, createdBy: requester, seed: "run-3" },
  });

  const ctx = createToolContext({
    sandbox: box.sandbox,
    provision,
    layers: [{ scopeId: requesterScope, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace,
    deploy: {} as never,
    acl,
    files,
    createdBy: requester,
    deliverShareToRequester: attachStaging.attach,
    requesterScopeId: requesterScope,
  });

  await ctx.write("report.xlsx", "edited workbook bytes", [{ scope: otherUserScope, permission: "read" }]);

  assert.equal(attachStaging.staged().length, 0, "sharing to a different user must not stage a delivery attachment");
});

test("write+share to the requester dedupes: repeated shares of the same path stage once", async () => {
  const workspace = ws();
  const acl = createAclStore();
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const blobTransfer = createMemoryBlobTransferStore();
  const requester = "U1";
  const requesterScope = personalScope(requester);
  const handle: SandboxHandle = { id: "h", rootDir: "/workspace" } as SandboxHandle;
  const box = memSandbox();
  const provision = async () => handle;

  const attachStaging = createAttachStaging({
    sandbox: box.sandbox,
    provision,
    blobTransfer,
    fileRegistration: { store: files, ownerScopeId: requesterScope, createdBy: requester, seed: "run-4" },
  });

  const ctx = createToolContext({
    sandbox: box.sandbox,
    provision,
    layers: [{ scopeId: requesterScope, mountPath: "", mode: "rw" }],
    commandPolicy: () => ({}) as never,
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace,
    deploy: {} as never,
    acl,
    files,
    createdBy: requester,
    deliverShareToRequester: attachStaging.attach,
    requesterScopeId: requesterScope,
  });

  await ctx.write("report.xlsx", "v1", [{ scope: requesterScope, permission: "read" }]);
  await ctx.write("report.xlsx", "v2", [{ scope: requesterScope, permission: "read" }]);

  const staged = attachStaging.staged();
  assert.equal(staged.length, 1, "the same path shared twice in a turn must stage once, not accumulate duplicates");
});
