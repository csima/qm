import { parse } from "yaml";
import { ENV_NAME, INSTANCE_TYPES, MODEL_CREDENTIALS, imageKey } from "../shared/naming.js";

export { imageKey };

export const RUNTIME_IMAGE =
  "mirror.gcr.io/library/node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c";
export const CLAUDE_CODE_VERSION = "2.1.288";
export const HARNESSES = ["claude"];
export const VERSIONS_KEPT = 5;

const NAME = /^[a-z][a-z0-9-]{1,30}$/;
const RESERVED_ENV = /^(AGENT_|XDG_)|^(HOME|PATH|USER|SHELL|TERM)$/;
const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/;

export function parseManifest(text) {
  const raw = parse(text);
  const problems = [];
  const fail = (msg) => problems.push(msg);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("agent.yaml must be a mapping");
  const known = new Set(["name", "description", "base", "setup", "harness", "instance", "credentials"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) fail(`unknown field ${key}`);
  if (typeof raw.name !== "string" || !NAME.test(raw.name)) fail("name must match ^[a-z][a-z0-9-]{1,30}$");
  if (typeof raw.description !== "string" || !raw.description.trim() || raw.description.length > 500)
    fail("description is required (at most 500 characters)");
  if (typeof raw.base !== "string" || !DIGEST_PINNED.test(raw.base))
    fail("base must be an image reference pinned by digest (…@sha256:<64 hex>)");
  if (raw.setup !== undefined && !safeRelativePath(raw.setup)) fail("setup must be a relative path inside the repo");
  const harness = raw.harness ?? "claude";
  if (!HARNESSES.includes(harness)) fail(`harness must be one of ${HARNESSES.join(", ")}`);
  const instance = raw.instance ?? "standard-1";
  if (!INSTANCE_TYPES.includes(instance)) fail(`instance must be one of ${INSTANCE_TYPES.join(", ")}`);
  const credentials = raw.credentials ?? [];
  if (!Array.isArray(credentials)) fail("credentials must be a list");
  const seen = new Set();
  const creds = (Array.isArray(credentials) ? credentials : []).map((c, i) => {
    if (!c || typeof c !== "object") {
      fail(`credentials[${i}] must be a mapping`);
      return null;
    }
    if (
      typeof c.name !== "string" ||
      !ENV_NAME.test(c.name) ||
      RESERVED_ENV.test(c.name) ||
      MODEL_CREDENTIALS.includes(c.name)
    )
      fail(`credentials[${i}].name must be an environment variable name that is not reserved`);
    if (seen.has(c.name)) fail(`credentials[${i}].name ${c.name} is duplicated`);
    seen.add(c.name);
    if (typeof c.description !== "string" || !c.description.trim()) fail(`credentials[${i}].description is required`);
    if (c.required !== undefined && typeof c.required !== "boolean")
      fail(`credentials[${i}].required must be true or false`);
    return { name: c.name, description: c.description, required: c.required !== false };
  });
  if (problems.length) throw new Error(`agent.yaml is invalid:\n- ${problems.join("\n- ")}`);
  return {
    name: raw.name,
    description: raw.description.trim(),
    base: raw.base,
    setup: raw.setup ?? null,
    harness,
    instance,
    credentials: creds,
  };
}

export function safeRelativePath(p) {
  if (typeof p !== "string" || !/^[A-Za-z0-9._/-]+$/.test(p) || p.startsWith("/")) return false;
  return p.split("/").every((part) => part && part !== "." && part !== "..");
}

const CA_EXPORTS =
  "if [ -f /run/secrets/buildca ]; then export SSL_CERT_FILE=/run/secrets/buildca CURL_CA_BUNDLE=/run/secrets/buildca NODE_EXTRA_CA_CERTS=/run/secrets/buildca GIT_SSL_CAINFO=/run/secrets/buildca REQUESTS_CA_BUNDLE=/run/secrets/buildca PIP_CERT=/run/secrets/buildca; fi";

export function dockerfile(manifest, { version }) {
  const secret = "--mount=type=secret,id=buildca,required=false";
  const lines = [
    `FROM ${RUNTIME_IMAGE} AS runtime`,
    `RUN ${secret} sh -c '${CA_EXPORTS}; npm install -g --no-fund --no-audit @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}'`,
    "",
    `FROM ${manifest.base}`,
    `RUN ${secret} sh -c '${CA_EXPORTS}; apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tmux git jq ca-certificates curl procps less && rm -rf /var/lib/apt/lists/*'`,
    "COPY --from=runtime /usr/local/bin/node /usr/local/bin/node",
    "COPY --from=runtime /usr/local/lib/node_modules/@anthropic-ai /usr/local/lib/node_modules/@anthropic-ai",
    "RUN ln -sf /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe /usr/local/bin/claude && claude --version && (id agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent)",
    "COPY --chown=root:root agent/ /agent/",
  ];
  if (manifest.setup) lines.push(`RUN ${secret} sh -c '${CA_EXPORTS}; cd /agent && ./${manifest.setup}'`);
  lines.push(
    "RUN chmod -R a-w /agent",
    "COPY runtime/agentd.mjs runtime/claude-settings.json /opt/agent-host/",
    "COPY --chmod=755 runtime/bin/ /usr/local/bin/",
    `LABEL agent-host.agent="${manifest.name}" agent-host.version="${version}"`,
    'CMD ["/usr/local/bin/agent-idle"]',
    "",
  );
  return lines.join("\n");
}

export function versionId(commit, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "t").slice(0, 15);
  if (!commit) return `${stamp}-local`;
  return `${stamp}-${commit.slice(0, 8)}${commit.endsWith("-dirty") ? "-dirty" : ""}`;
}

export function sqlString(value) {
  return value === null || value === undefined ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
}

export function imagesToKeep(versions, instances, kept = VERSIONS_KEPT) {
  const inUse = new Set(instances.map((i) => imageKey(i.agent, i.version)));
  const perAgent = new Map();
  const images = {};
  for (const v of [...versions].sort((a, b) => b.created_at - a.created_at)) {
    const key = imageKey(v.agent, v.version);
    const count = perAgent.get(v.agent) ?? 0;
    if (count < kept || inUse.has(key)) images[key] = { image: v.image };
    perAgent.set(v.agent, count + 1);
  }
  return images;
}
