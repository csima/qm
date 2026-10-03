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
const DIGEST_PINNED = /^[a-z0-9][a-z0-9._\/:-]*@sha256:[0-9a-f]{64}$/;
const LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?";
const EGRESS_HOST = new RegExp(`^(\\*\\.)?${LABEL}(\\.${LABEL})+$`);
const MAX_RULES = 100;
const SHARED_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "com.au",
  "co.jp",
  "co.nz",
  "com.br",
  "workers.dev",
  "pages.dev",
  "r2.dev",
  "trycloudflare.com",
  "cloudflareaccess.com",
  "github.io",
  "githubusercontent.com",
  "gitlab.io",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "fly.dev",
  "onrender.com",
  "replit.app",
  "glitch.me",
  "ngrok.io",
  "ngrok-free.app",
  "ngrok.app",
  "loca.lt",
  "deno.dev",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
  "cloudfront.net",
  "amazonaws.com",
  "azurewebsites.net",
  "blob.core.windows.net",
  "googleusercontent.com",
  "storage.googleapis.com",
  "s3.amazonaws.com",
]);

export function parseManifest(text) {
  const raw = parse(text);
  const problems = [];
  const fail = (msg) => problems.push(msg);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("agent.yaml must be a mapping");
  const known = new Set([
    "name",
    "description",
    "base",
    "setup",
    "harness",
    "instance",
    "credentials",
    "egress",
    "deny",
  ]);
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
  let egress = null;
  if (raw.egress !== undefined) {
    if (!Array.isArray(raw.egress) || raw.egress.length > MAX_RULES)
      fail(`egress must be a list of at most ${MAX_RULES} host names`);
    else {
      raw.egress.forEach((h, i) => {
        if (typeof h !== "string" || !EGRESS_HOST.test(h.toLowerCase()))
          fail(`egress[${i}] must be a host name like api.example.com or *.example.com`);
        else if (h.startsWith("*.") && SHARED_SUFFIXES.has(h.slice(2).toLowerCase()))
          fail(`egress[${i}] ${h} would allow anyone's site; list the exact hosts instead`);
      });
      egress = [...new Set(raw.egress.filter((h) => typeof h === "string").map((h) => h.toLowerCase()))];
    }
  }
  const deny = raw.deny ?? [];
  if (!Array.isArray(deny) || deny.length > MAX_RULES) fail(`deny must be a list of at most ${MAX_RULES} rules`);
  const rules = (Array.isArray(deny) ? deny : []).map((rule, i) => {
    const pattern = typeof rule === "string" ? rule : rule?.pattern;
    const reason = typeof rule === "object" && rule !== null ? rule.reason : undefined;
    if (typeof pattern !== "string" || !pattern || pattern.length > 500) {
      fail(`deny[${i}] must be a regular expression or {pattern, reason}`);
      return null;
    }
    try {
      new RegExp(pattern, "i");
    } catch (error) {
      fail(`deny[${i}] is not a valid regular expression: ${error.message}`);
    }
    if (reason !== undefined && (typeof reason !== "string" || reason.length > 200))
      fail(`deny[${i}].reason must be text of at most 200 characters`);
    return reason ? { pattern, reason } : { pattern };
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
    egress,
    deny: rules,
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
    "COPY runtime/agentd.mjs runtime/agent-call.mjs runtime/agent-secret.mjs runtime/guard.mjs runtime/guard.json runtime/claude-settings.json /opt/agent-host/",
    "COPY runtime/managed-settings.json /etc/claude-code/managed-settings.json",
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

export function guardConfig(manifest) {
  return `${JSON.stringify({ deny: manifest.deny }, null, 2)}\n`;
}

export function sqlString(value) {
  return value === null || value === undefined ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
}

const UNRECORDED_GRACE_MS = 24 * 60 * 60_000;

export function versionTime(tag) {
  const m = /^(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})(\d{2})-/.exec(tag);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

export function imagesToDelete(registry, versions, kept, now = Date.now()) {
  const recorded = new Set(versions.map((v) => imageKey(v.agent, v.version)));
  const doomed = [];
  for (const { name, tags } of registry) {
    if (!name.startsWith("agent-host-")) continue;
    const agent = name.slice("agent-host-".length);
    for (const tag of tags) {
      const key = imageKey(agent, tag);
      if (kept[key]) continue;
      const time = versionTime(tag);
      if (recorded.has(key) || (time !== null && now - time > UNRECORDED_GRACE_MS)) doomed.push(`${name}:${tag}`);
    }
  }
  return doomed;
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
