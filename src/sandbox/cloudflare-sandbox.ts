import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createMemoryAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { fetchWithRetry } from "../util/async.ts";
import { errMessage, httpFailure, swallowAs } from "../util/errors.ts";
import { createExecProcessSessions } from "./exec-process-session.ts";
import {
  createBackendBlobStaging,
  createExecExport,
  createExecFileOps,
  type BlobStagingOptions,
} from "./exec-file-ops.ts";
import { ephemeralCredLinkPaths, type CredentialPathSpec } from "../credentials/resident-paths.ts";
import { visibleNotInstalled, visibleTools } from "./sandbox.ts";
import { createExecSandboxBase, sandboxScopeName } from "./exec-sandbox-base.ts";
import { createLayerToolInstaller } from "./layer-tool-install.ts";
import { createHomeSnapshotOps, HOME_SNAPSHOT_PRUNE, snapshotDue, type HomeSnapshotStore } from "./home-snapshot.ts";
import type { LayerInstallFile } from "../deployment/load-layer.ts";
import type { AgentComputerProfile, ComputerStatus, ExecResult, Sandbox, TeardownOptions } from "./sandbox.ts";

const HOME_DIR = "/root";
const HOME_TAR = `${HOME_DIR}/.qm-home.tar`;
const SNAPSHOT_PART_BYTES = 16 * 1024 * 1024;
const CONTROL_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 300_000;
const FILE_TRANSFER_TIMEOUT_MS = 300_000;
const EXIT_GRACE_MS = 60_000;
const GUEST_PROBE_TIMEOUT_SEC = 15;

interface SandboxStatus {
  running: boolean;
  bootId?: string;
}

export interface StoredCloudflareSandbox {
  bootId?: string;
  initializationPending?: boolean;
  lastSnapshotMs?: number;
  homeDirty?: boolean;
  snapshotError?: string;
}

export interface CloudflareSandboxOptions extends BlobStagingOptions {
  url?: string;
  token?: string;
  namePrefix?: string;
  defaultTimeoutSec?: number;
  snapshotIntervalMs?: number;
  store?: DurableMap<StoredCloudflareSandbox>;
  advisoryLock?: AdvisoryLock;
  snapshots?: HomeSnapshotStore;
  extraTools?: string[];
  credentialPaths?: CredentialPathSpec[];
  layerToolFiles?: () => readonly LayerInstallFile[];
  fetchImpl?: typeof fetch;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export class SandboxBootLostError extends Error {
  constructor(name: string) {
    super(
      `cloudflare sandbox ${name} restarted while in use; changes since its last home snapshot are gone and the next turn restores that snapshot`,
    );
    this.name = "SandboxBootLostError";
  }
}

export function createCloudflareSandbox(workspace: WorkspaceStore, opts: CloudflareSandboxOptions = {}): Sandbox {
  if (!opts.url || !opts.token)
    throw new Error("SANDBOX_BACKEND=cloudflare requires CLOUDFLARE_SANDBOX_URL and CLOUDFLARE_SANDBOX_TOKEN");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.url.replace(/\/+$/, "");
  const authorization = `Bearer ${opts.token}`;
  const prefix = opts.namePrefix ?? "qm";
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const snapshotIntervalMs = opts.snapshotIntervalMs ?? 0;
  const store = opts.store ?? createMemoryMap<StoredCloudflareSandbox>();
  const advisoryLock = opts.advisoryLock ?? createMemoryAdvisoryLock();
  const lifecycleKey = (scope: string): string => `cloudflare-provision:${prefix}:${scope}`;
  const bootByName = new Map<string, string>();

  const sandboxUrl = (name: string, sub = ""): string => `${baseUrl}/v1/sandboxes/${encodeURIComponent(name)}${sub}`;

  async function control(method: string, name: string, sub = "", timeoutMs = CONTROL_TIMEOUT_MS): Promise<Response> {
    const res = await fetchWithRetry(
      (signal) => fetchImpl(sandboxUrl(name, sub), { method, headers: { authorization }, signal }),
      "idempotent",
      { timeoutMs },
    );
    if (!res.ok) throw new Error(`cloudflare sandbox ${method} ${name}${sub}: ${await httpFailure(res)}`);
    return res;
  }

  const status = async (name: string): Promise<SandboxStatus> =>
    (await (await control("GET", name)).json()) as SandboxStatus;

  async function start(name: string): Promise<string> {
    const { bootId } = (await (await control("POST", name, "/start", START_TIMEOUT_MS)).json()) as { bootId: string };
    bootByName.set(name, bootId);
    return bootId;
  }

  async function deleteSandbox(name: string): Promise<void> {
    bootByName.delete(name);
    await control("DELETE", name);
  }

  async function adoptRecordedBoot(name: string): Promise<boolean> {
    const scope = base.scopeFor(name);
    if (!scope) return false;
    const [stored, current] = await Promise.all([store.get(scope), status(name)]);
    if (!stored?.bootId || stored.initializationPending || stored.bootId !== current.bootId) return false;
    if (stored.bootId === bootByName.get(name)) return false;
    bootByName.set(name, stored.bootId);
    return true;
  }

  async function pinned(name: string, send: (bootId: string) => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const bootId = bootByName.get(name);
      if (!bootId) throw new SandboxBootLostError(name);
      const res = await send(bootId);
      if (res.status !== 409) return res;
      await res.body?.cancel().catch(() => undefined);
      if (attempt > 0 || !(await adoptRecordedBoot(name))) {
        bootByName.delete(name);
        throw new SandboxBootLostError(name);
      }
    }
  }

  async function execRaw(name: string, script: string, timeoutSec: number): Promise<ExecResult> {
    const res = await pinned(name, (bootId) =>
      fetchImpl(sandboxUrl(name, "/exec"), {
        method: "POST",
        headers: { authorization, "content-type": "application/json", "x-qm-boot": bootId },
        body: JSON.stringify({ script, timeoutSec }),
        signal: AbortSignal.timeout(timeoutSec * 1000 + EXIT_GRACE_MS),
      }),
    );
    if (!res.ok) throw new Error(`cloudflare sandbox exec ${name}: ${await httpFailure(res)}`);
    const r = (await res.json()) as { stdout: string; stderr: string; code: number };
    return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.code === 124 };
  }

  const fileUrl = (name: string, absPath: string): string =>
    `${sandboxUrl(name, "/files")}?path=${encodeURIComponent(absPath)}`;

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    const res = await pinned(name, (bootId) =>
      fetchWithRetry(
        (signal) =>
          fetchImpl(fileUrl(name, absPath), {
            method: "PUT",
            headers: { authorization, "content-type": "application/octet-stream", "x-qm-boot": bootId },
            body: Buffer.from(data),
            signal,
          }),
        "idempotent",
        { timeoutMs: FILE_TRANSFER_TIMEOUT_MS },
      ),
    );
    if (!res.ok) throw new Error(`cloudflare sandbox write ${absPath}: ${await httpFailure(res)}`);
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    const res = await pinned(name, (bootId) =>
      fetchWithRetry(
        (signal) => fetchImpl(fileUrl(name, absPath), { headers: { authorization, "x-qm-boot": bootId }, signal }),
        "idempotent",
        { timeoutMs: FILE_TRANSFER_TIMEOUT_MS },
      ),
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`cloudflare sandbox read ${absPath}: ${await httpFailure(res)}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  const homeSnapshots = opts.snapshots
    ? createHomeSnapshotOps<string>({
        label: "cloudflare",
        homeDir: HOME_DIR,
        homeTarPath: HOME_TAR,
        partBytes: SNAPSHOT_PART_BYTES,
        prunePaths: [
          ...HOME_SNAPSHOT_PRUNE,
          ...ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => `./${rel}`),
        ],
        store: opts.snapshots,
        io: {
          runCommand: async (name, script, timeoutMs) => {
            const r = await execRaw(name, script, Math.ceil(timeoutMs / 1000));
            return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
          },
          readFileBytes: readAbsBytes,
          writeFileBytes: writeAbsBytes,
        },
      })
    : undefined;

  async function mergeStored(scope: string, patch: Partial<StoredCloudflareSandbox>): Promise<void> {
    await store.putIfAbsent(scope, {});
    await store.merge(scope, patch);
  }

  async function snapshotHome(scope: string, name: string): Promise<void> {
    try {
      await homeSnapshots!.snapshotHome(scope, name);
      await mergeStored(scope, { lastSnapshotMs: Date.now(), homeDirty: false, snapshotError: undefined });
    } catch (e) {
      await mergeStored(scope, { snapshotError: errMessage(e) });
      throw e;
    }
  }

  async function initializeSandbox(
    name: string,
    scope: string,
    onStatus?: (text: string) => void,
  ): Promise<{ coldStart: boolean }> {
    const [stored, current] = await Promise.all([store.get(scope), status(name)]);
    if (current.running && current.bootId && current.bootId === stored?.bootId && !stored.initializationPending) {
      bootByName.set(name, current.bootId);
      return { coldStart: false };
    }
    await mergeStored(scope, { initializationPending: true });
    try {
      onStatus?.("Preparing the sandbox…");
    } catch (error) {
      void error;
    }
    const bootId = await start(name);
    try {
      const hydrated = homeSnapshots ? await homeSnapshots.hydrateHome(scope, name) : false;
      await mergeStored(scope, { bootId, initializationPending: undefined, ...(hydrated ? { homeDirty: false } : {}) });
      return { coldStart: !hydrated };
    } catch (e) {
      await deleteSandbox(name).catch(swallowAs("cloudflare-sandbox: delete after failed hydration", undefined));
      opts.onError?.({
        category: "sandbox_hydrate",
        code: "hydrate_failed",
        message: errMessage(e),
        scopeLabel: scope,
      });
      throw new Error(
        `cloudflare provision: home hydration failed (${errMessage(e)}); not risking the stored snapshot`,
        { cause: e },
      );
    }
  }

  const ensureSandbox = (name: string, scope: string, onStatus?: (text: string) => void) =>
    advisoryLock.withLock(lifecycleKey(scope), () => initializeSandbox(name, scope, onStatus));

  const base = createExecSandboxBase({
    workspace,
    label: "cloudflare",
    prefix,
    homeDir: HOME_DIR,
    defaultTimeoutSec,
    credentialPaths: opts.credentialPaths ?? [],
    ...(opts.layerToolFiles ? { installLayerTools: createLayerToolInstaller(opts.layerToolFiles) } : {}),
    deleteFailureCode: "sandbox_delete_failed",
    onError: opts.onError,
    exec: execRaw,
    writeAbsBytes,
    readAbsBytes,
    ensureResident: (name, onStatus) => ensureSandbox(name, base.scopeFor(name) ?? "default", onStatus),
    isProvisioned: (name) => bootByName.has(name),
    async recreateScratch(name) {
      await deleteSandbox(name).catch(swallowAs("cloudflare-sandbox: stale scratch delete", undefined));
      await start(name);
    },
    deleteInstance: (name) =>
      advisoryLock.withLock(lifecycleKey(base.scopeFor(name) ?? name), () => deleteSandbox(name)),
    forgetInstance: (name) => bootByName.delete(name),
  });

  const profile: AgentComputerProfile = {
    backend: "cloudflare",
    writablePersistence: "snapshot_to_workspace",
    processSessions: true,
    egressEnforcement: "none",
    spec: {
      os: "Debian 12 (bookworm), glibc — a Cloudflare Container that stops when idle; the home directory is restored from its last snapshot on the next start, everything outside it is reset",
      runtimes: ["Node 24", "Python 3 (venv on PATH — `pip install` just works)"],
      get tools() {
        return visibleTools([
          "git",
          "curl",
          "wget",
          "jq",
          "unzip",
          "gnupg",
          "python3",
          "gh",
          "aws (CLI v2)",
          ...(opts.extraTools ?? []),
        ]);
      },
      get notInstalled() {
        return visibleNotInstalled(["gcloud", "kubectl", "flyctl", "glab"], opts.extraTools ?? []);
      },
      homeDir: HOME_DIR,
      workdir: base.workspaceDir,
    },
  };

  const procSessions = createExecProcessSessions({
    run: (handle, command, execOpts) =>
      execRaw(handle.id, command, execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec),
  });

  const execFileOps = createExecFileOps({
    label: "cloudflare",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const blobStaging = createBackendBlobStaging("cloudflare", (id, script, t) => execRaw(id, script, t), opts);

  const execExport = createExecExport({
    label: "cloudflare",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: HOME_DIR,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths(opts.credentialPaths ?? []).map(({ rel }) => rel),
  });

  function recoveryFor(stored: StoredCloudflareSandbox | null): Pick<ComputerStatus, "recovery"> {
    if (!homeSnapshots) return {};
    return {
      recovery: {
        strategy: "workspace_snapshot",
        ...(stored?.lastSnapshotMs ? { checkpointAtMs: stored.lastSnapshotMs } : {}),
        ...(stored?.snapshotError ? { error: stored.snapshotError } : {}),
      },
    };
  }

  return {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,
    ...blobStaging,
    provision: base.provision,
    run: base.run,
    writeFileBytes: base.writeFileBytes,
    writeFile: base.writeFile,
    readFileBytes: base.readFileBytes,
    readFile: base.readFile,
    exportFiles: execExport.exportFiles,

    ...(homeSnapshots
      ? {
          async persistHomeSnapshot(scopeId: string): Promise<void> {
            const name = sandboxScopeName(prefix, scopeId);
            await base.provisionQueue(scopeId, () =>
              advisoryLock.withLock(lifecycleKey(scopeId), async () => {
                await initializeSandbox(name, scopeId);
                await snapshotHome(scopeId, name);
              }),
            );
          },
        }
      : {}),

    async computerStatus(scopeId: string): Promise<ComputerStatus> {
      const name = sandboxScopeName(prefix, scopeId);
      const stored = await store.get(scopeId);
      const recovery = recoveryFor(stored);
      let current: SandboxStatus;
      try {
        current = await status(name);
      } catch (e) {
        return { ...recovery, machine: `lookup failed: ${errMessage(e)}`, guestResponsive: false };
      }
      if (!stored?.bootId)
        return { ...recovery, machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false };
      if (!current.running || current.bootId !== stored.bootId) {
        return {
          ...recovery,
          machine: `sandbox ${name} stopped; the next turn starts it and restores the home snapshot`,
          listed: "stopped",
          lifecycleState: "paused",
          provisioned: true,
          guestResponsive: false,
        };
      }
      bootByName.set(name, current.bootId);
      let guestResponsive = false;
      let probeError: string | undefined;
      try {
        guestResponsive = (await execRaw(name, "true", GUEST_PROBE_TIMEOUT_SEC)).code === 0;
      } catch (e) {
        probeError = errMessage(e);
      }
      return {
        ...recovery,
        machine: `sandbox ${name} running`,
        listed: "running",
        lifecycleState: "running",
        provisioned: true,
        guestResponsive,
        ...(probeError ? { probeError } : {}),
      };
    },

    async destroyScope(scopeId: string): Promise<void> {
      return base.provisionQueue(scopeId, () =>
        advisoryLock.withLock(lifecycleKey(scopeId), async () => {
          await deleteSandbox(sandboxScopeName(prefix, scopeId));
          await store.delete(scopeId);
        }),
      );
    },

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      if (homeSnapshots && !handle.scratch && !tdOpts?.destroy) {
        const scope = base.scopeFor(handle.id) ?? "default";
        await base.provisionQueue(scope, () =>
          advisoryLock.withLock(lifecycleKey(scope), async () => {
            const stored = await store.get(scope);
            if (stored?.initializationPending) return;
            if (!tdOpts?.homeUnchanged) await mergeStored(scope, { homeDirty: true });
            if (!snapshotDue(stored, tdOpts, snapshotIntervalMs)) return;
            try {
              await snapshotHome(scope, handle.id);
            } catch (e) {
              opts.onError?.({
                category: "sandbox_snapshot",
                code: "teardown_snapshot_failed",
                message: errMessage(e),
                scopeLabel: scope,
              });
            }
          }),
        );
      }
      return base.teardown(handle, tdOpts);
    },
  };
}
