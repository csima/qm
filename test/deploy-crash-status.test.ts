import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { DeployProvider, DeployRunState } from "../src/deploy/deploy-provider.ts";
import { scopeId } from "../src/types.ts";

function svc(opts: {
  managedScaleToZero?: boolean;
  runState?: (id: string) => Promise<DeployRunState | null>;
  logs?: (id: string) => Promise<string | null>;
}) {
  const deployStore = createDeployStore();
  let runStateCalls = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: opts.managedScaleToZero ?? false },
    apply: async () => ({ host: "127.0.0.1", port: 5000 }),
    destroy: async () => {},
    ...(opts.runState
      ? {
          runState: async (d) => {
            runStateCalls++;
            return opts.runState!(d.id);
          },
        }
      : {}),
    ...(opts.logs ? { logs: async (d) => opts.logs!(d.id) } : {}),
  };
  const deploy = createDeployService({
    deployStore,
    provider,
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    acl: createAclStore(),
    deployDir: mkdtempSync(join(tmpdir(), "deploy-crash-")),
  });
  return {
    deploy,
    deployStore,
    get runStateCalls() {
      return runStateCalls;
    },
  };
}

test("getDeployment downgrades a running deployment whose container exited to crashed, with exit code and detail", async () => {
  const { deploy, deployStore } = svc({ runState: async () => ({ running: false, exitCode: 7 }) });
  const d = await deploy.deploy({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "x",
    files: [],
  });
  assert.equal((await deployStore.get(d.id))!.status, "running");

  const got = await deploy.getDeployment(d.id);
  assert.equal(got!.status, "crashed");
  assert.equal(got!.crash?.exitCode, 7);
  assert.equal((await deployStore.get(d.id))!.status, "crashed");
});

test("listDeployments downgrades every crashed running deployment it observes", async () => {
  const exited = new Set<string>();
  const { deploy } = svc({ runState: async (id) => (exited.has(id) ? { running: false, exitCode: 1 } : { running: true }) });
  const a = await deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });
  const b = await deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });
  exited.add(a.id);

  const list = await deploy.listDeployments();
  const ga = list.find((x) => x.id === a.id)!;
  const gb = list.find((x) => x.id === b.id)!;
  assert.equal(ga.status, "crashed");
  assert.equal(gb.status, "running");
});

test("a provider with no runState signal (container absent) leaves status alone rather than guessing a crash", async () => {
  const { deploy, deployStore } = svc({ runState: async () => null });
  const d = await deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });

  const got = await deploy.getDeployment(d.id);
  assert.equal(got!.status, "running");
  assert.equal((await deployStore.get(d.id))!.status, "running");
});

test("a provider without runState support is never probed and never downgraded", async () => {
  const { deploy, deployStore, runStateCalls } = svc({});
  const d = await deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });

  await deploy.getDeployment(d.id);
  await deploy.listDeployments();
  assert.equal(runStateCalls, 0);
  assert.equal((await deployStore.get(d.id))!.status, "running");
});

test("a managed scale-to-zero provider is never probed for crashes (it owns its own running/stopped semantics)", async () => {
  const { deploy, runStateCalls } = svc({ managedScaleToZero: true, runState: async () => ({ running: false, exitCode: 1 }) });
  const d = await deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });

  const got = await deploy.getDeployment(d.id);
  assert.equal(got!.status, "running");
  assert.equal(runStateCalls, 0);
});

test("a transient run-state probe error preserves the running status rather than false-failing", async () => {
  const { deploy, deployStore } = svc({
    runState: async () => {
      throw new Error("docker daemon unavailable");
    },
  });
  const d = await deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });

  const got = await deploy.getDeployment(d.id);
  assert.equal(got!.status, "running");
  assert.equal((await deployStore.get(d.id))!.status, "running");
});

test("a concurrent redeploy that lands while a crash is being detected is not clobbered", async () => {
  let firstProbe = true;
  const { deploy, deployStore } = svc({
    runState: async () => {
      if (firstProbe) {
        firstProbe = false;
        return { running: false, exitCode: 9 };
      }
      return { running: true };
    },
  });
  const d = await deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });

  const staleAppliedVersion = (await deployStore.get(d.id))!.appliedVersion;
  await deploy.redeploy(d.id, { entrypoint: "y", files: [] });
  const redeployed = (await deployStore.get(d.id))!;
  assert.equal(redeployed.status, "running");
  assert.equal(redeployed.appliedVersion, 2);

  const changed = await deployStore.setCrash(d.id, staleAppliedVersion, { exitCode: 9, at: Date.now() });
  assert.equal(changed, false);
  assert.equal((await deployStore.get(d.id))!.status, "running");
  assert.equal((await deployStore.get(d.id))!.appliedVersion, 2);
});

test("markVersionRunning (redeploy) clears a stale crash marker from a previous version", async () => {
  const { deploy, deployStore } = svc({ runState: async () => ({ running: false, exitCode: 3 }) });
  const d = await deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });
  await deploy.getDeployment(d.id);
  assert.equal((await deployStore.get(d.id))!.status, "crashed");

  const redeployed = await deploy.redeploy(d.id, { entrypoint: "y", files: [] });
  assert.equal(redeployed.status, "running");
  assert.equal(redeployed.crash, undefined);
});

test("deploymentLogs still returns logs for a crashed deployment (logs are preserved, not torn down)", async () => {
  const { deploy } = svc({
    runState: async () => ({ running: false, exitCode: 1, detail: "OOMKilled" }),
    logs: async () => "boot failed: cannot find module",
  });
  const d = await deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });
  await deploy.getDeployment(d.id);

  const logs = await deploy.deploymentLogs(d.id, { tailLines: 100 });
  assert.equal(logs, "boot failed: cannot find module");
});

test("reachDeployment reports a crashed deployment as not_found instead of proxying to a dead container", async () => {
  const { deploy } = svc({ runState: async () => ({ running: false, exitCode: 1 }) });
  const d = await deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });

  const reach = await deploy.reachDeployment(d.id, "U1", { bypassAcl: true });
  assert.equal(reach.status, "not_found");
});

test("keepAlwaysOnWarm skips a crashed always-on deployment instead of pretending to warm it", async () => {
  const { deploy, deployStore } = svc({ runState: async () => ({ running: false, exitCode: 1 }) });
  const d = await deploy.deploy({ ownerScopeId: scopeId("personal", "U1"), createdBy: "U1", entrypoint: "x", files: [] });
  await deploy.setDeploymentAlwaysOn(d.id, true);

  const warmed = await deploy.keepAlwaysOnWarm();
  assert.equal(warmed, 0);
  assert.equal((await deployStore.get(d.id))!.status, "crashed");
});
