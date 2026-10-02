#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GENERATED_SECRETS, adminLoginUrl } from "./lib.mjs";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.cloudflare.com/client/v4";

const OPTIONAL_SECRETS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AUTH_PASSWORD_USERS",
  "AUTH_EMAIL_TRANSPORT",
  "AUTH_EMAIL_FROM",
  "RESEND_API_KEY",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USERNAME",
  "SMTP_PASSWORD",
  "SMTP_TLS",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SPRITES_EGRESS_PROXY_URL",
  "E2B_API_KEY",
  "E2B_EGRESS_PROXY_URL",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "DROPBOX_OAUTH_CLIENT_SECRET",
  "LINEAR_OAUTH_CLIENT_SECRET",
  "DATABASE_CA_CERT",
];
const PASSTHROUGH = ["QM_CORE_ENV_JSON", "QM_WEB_ENV_JSON", "QM_PORTAL_ENV_JSON", "QM_ALLOWED_EMAILS"];

const { values: args } = parseArgs({
  options: {
    org: { type: "string" },
    admin: { type: "string" },
    name: { type: "string", default: "qm" },
    domain: { type: "string" },
    "model-provider": { type: "string", default: "anthropic" },
    model: { type: "string" },
    sandbox: { type: "string", default: "cloudflare" },
    "allowed-email-domain": { type: "string" },
    "skip-health": { type: "boolean", default: false },
  },
});

const fail = (msg) => {
  console.error(`\n✘ ${msg}`);
  process.exit(1);
};
const step = (msg) => console.log(`\n▸ ${msg}`);

function wrangler(argv, { input, allowFail = false, quiet = false } = {}) {
  const res = spawnSync("npx", ["--no-install", "wrangler", ...argv], {
    cwd: HERE,
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "inherit" : "pipe", quiet ? "pipe" : "inherit", quiet ? "pipe" : "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (res.status !== 0 && !allowFail) fail(`wrangler ${argv[0]} ${argv[1] ?? ""} failed`);
  return res;
}

async function cf(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const err = new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${JSON.stringify(body.errors ?? body)}`);
    err.status = res.status;
    throw err;
  }
  return body.result;
}

const env = process.env;
const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "QM_DATABASE_URL"].filter((n) => !env[n]?.trim());
const provider = args["model-provider"];
const providerKey = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" }[
  provider
];
if (!providerKey) fail(`--model-provider must be anthropic, openai, or openrouter`);
if (!env[`QM_${providerKey}`]?.trim()) missing.push(`QM_${providerKey}`);
if (args.sandbox === "sprites" && !env.QM_SPRITES_TOKEN?.trim()) missing.push("QM_SPRITES_TOKEN");
if (!args.org || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(args.org)) missing.push("--org <lowercase-slug>");
if (!args.admin) missing.push("--admin <email>");
if (missing.length) fail(`missing: ${missing.join(", ")}`);
if (/pooler|pgbouncer|:6543\b/.test(env.QM_DATABASE_URL)) {
  console.warn(
    "⚠ QM_DATABASE_URL looks like a pooled endpoint. qm needs LISTEN/NOTIFY and session advisory locks — use the direct URL.",
  );
}
const account = env.CLOUDFLARE_ACCOUNT_ID.trim();
const name = args.name;
const bucket = `${name}-data`;
const admins = args.admin
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
for (const email of admins)
  if (!/^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(email)) fail(`bad admin email ${email}`);

step("Resolving public URL");
let publicUrl;
if (args.domain) {
  publicUrl = `https://${args.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
} else {
  const sub = await cf(`/accounts/${account}/workers/subdomain`).catch((e) =>
    fail(`could not read the account's workers.dev subdomain (${e.message}); pass --domain instead`),
  );
  if (!sub?.subdomain)
    fail("this account has no workers.dev subdomain yet; create one in the dashboard or pass --domain");
  publicUrl = `https://${name}.${sub.subdomain}.workers.dev`;
}
console.log(`  ${publicUrl}`);

step(`Reading existing secrets on Worker "${name}"`);
const listed = wrangler(["secret", "list", "--name", name, "--format", "json"], { allowFail: true, quiet: true });
let existing = new Set();
if (listed.status === 0) {
  try {
    existing = new Set(JSON.parse(listed.stdout.slice(listed.stdout.indexOf("["))).map((s) => s.name));
  } catch {
    fail("could not parse `wrangler secret list` output");
  }
}
console.log(existing.size ? `  ${existing.size} secrets already set` : "  none (first deploy)");

const secrets = {};
const generated = [];
for (const [key, mint] of Object.entries(GENERATED_SECRETS)) {
  if (!existing.has(key)) {
    secrets[key] = mint();
    generated.push(key);
  }
}
if (generated.length && generated.length !== Object.keys(GENERATED_SECRETS).length) {
  console.warn(`  minting only the missing generated secrets: ${generated.join(", ")}`);
}

step(`Ensuring R2 bucket ${bucket}`);
try {
  await cf(`/accounts/${account}/r2/buckets/${bucket}`);
  console.log("  exists");
} catch (e) {
  if (e.status !== 404) fail(`R2 lookup failed: ${e.message}`);
  await cf(`/accounts/${account}/r2/buckets`, { method: "POST", body: JSON.stringify({ name: bucket }) });
  console.log("  created");
}

if (env.QM_R2_ACCESS_KEY_ID && env.QM_R2_SECRET_ACCESS_KEY) {
  secrets.AWS_ACCESS_KEY_ID = env.QM_R2_ACCESS_KEY_ID;
  secrets.AWS_SECRET_ACCESS_KEY = env.QM_R2_SECRET_ACCESS_KEY;
} else if (!existing.has("AWS_ACCESS_KEY_ID")) {
  step("Minting a bucket-scoped R2 credential");
  try {
    const groups = await cf(`/accounts/${account}/tokens/permission_groups`);
    const write = groups.find((g) => g.name === "Workers R2 Storage Bucket Item Write");
    if (!write) throw new Error("permission group 'Workers R2 Storage Bucket Item Write' not found");
    const token = await cf(`/accounts/${account}/tokens`, {
      method: "POST",
      body: JSON.stringify({
        name: `${name} R2 ${bucket}`,
        policies: [
          {
            effect: "allow",
            permission_groups: [{ id: write.id }],
            resources: { [`com.cloudflare.edge.r2.bucket.${account}_default_${bucket}`]: "*" },
          },
        ],
      }),
    });
    secrets.AWS_ACCESS_KEY_ID = token.id;
    secrets.AWS_SECRET_ACCESS_KEY = createHash("sha256").update(token.value).digest("hex");
    console.log(`  created account token "${name} R2 ${bucket}"`);
  } catch (e) {
    console.warn(`  could not mint a scoped token (${e.message})`);
    const verified =
      (await cf(`/accounts/${account}/tokens/verify`).catch(() => undefined)) ??
      (await cf(`/user/tokens/verify`).catch(() => undefined));
    if (!verified?.id) {
      fail(
        `no R2 credential. Create an R2 API token scoped to ${bucket} (Object Read & Write) in the dashboard ` +
          `and set QM_R2_ACCESS_KEY_ID / QM_R2_SECRET_ACCESS_KEY.`,
      );
    }
    secrets.AWS_ACCESS_KEY_ID = verified.id;
    secrets.AWS_SECRET_ACCESS_KEY = createHash("sha256").update(env.CLOUDFLARE_API_TOKEN.trim()).digest("hex");
    console.warn(
      "  ⚠ using S3 credentials derived from CLOUDFLARE_API_TOKEN: the container gets that token's R2 access " +
        `(not just ${bucket}). Set QM_R2_ACCESS_KEY_ID/QM_R2_SECRET_ACCESS_KEY to a bucket-scoped token to narrow it.`,
    );
  }
}

secrets.DATABASE_URL = env.QM_DATABASE_URL;
secrets[providerKey] = env[`QM_${providerKey}`];
if (env.QM_SPRITES_TOKEN) secrets.SPRITES_TOKEN = env.QM_SPRITES_TOKEN;
for (const n of OPTIONAL_SECRETS) if (env[`QM_${n}`]?.trim()) secrets[n] = env[`QM_${n}`];
for (const n of PASSTHROUGH) if (env[n]?.trim()) secrets[n] = env[n];

const vars = {
  QM_PUBLIC_URL: publicUrl,
  QM_ORG_ID: args.org,
  QM_ADMIN_EMAILS: admins.join(","),
  QM_HARNESS: "pi",
  QM_MODEL_PROVIDER: provider,
  QM_SANDBOX_BACKEND: args.sandbox,
  S3_BUCKET: bucket,
  S3_REGION: "auto",
  AWS_ENDPOINT_URL_S3: `https://${account}.r2.cloudflarestorage.com`,
  ...(args.model ? { QM_MODEL: args.model } : {}),
  ...(env.QM_SANDBOX_INSTANCE?.trim() ? { QM_SANDBOX_INSTANCE: env.QM_SANDBOX_INSTANCE.trim() } : {}),
  ...(env.QM_SANDBOX_IDLE_MINUTES?.trim() ? { QM_SANDBOX_IDLE_MINUTES: env.QM_SANDBOX_IDLE_MINUTES.trim() } : {}),
  ...(args["allowed-email-domain"] ? { QM_ALLOWED_EMAIL_DOMAIN: args["allowed-email-domain"] } : {}),
};

step(`Deploying Worker "${name}" and building the container image (first build takes several minutes)`);
const dir = mkdtempSync(join(tmpdir(), "qm-cf-"));
const secretsFile = join(dir, "secrets.json");
writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
try {
  wrangler([
    "deploy",
    "--name",
    name,
    "--secrets-file",
    secretsFile,
    ...Object.entries(vars).flatMap(([k, v]) => ["--var", `${k}:${v}`]),
    ...(args.domain ? ["--domain", new URL(publicUrl).host] : []),
  ]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (!args["skip-health"]) {
  step("Waiting for the container to report healthy (cold start pulls the image)");
  const deadline = Date.now() + 15 * 60_000;
  let last;
  for (;;) {
    try {
      const res = await fetch(`${publicUrl}/healthz`, { signal: AbortSignal.timeout(30_000) });
      last = `${res.status}`;
      if (res.ok) break;
    } catch (e) {
      last = e.message;
    }
    if (Date.now() > deadline)
      fail(`not healthy after 15 minutes (last: ${last}); check \`npx wrangler tail ${name}\``);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log("  healthy");
}

console.log(`\n✔ qm is deployed at ${publicUrl}`);
if (generated.includes("PORTAL_SESSION_SECRET")) {
  console.log(
    `\nOne-time admin sign-in link for ${admins[0]} (single use, expires in 5 minutes — keep it private):\n\n  ${adminLoginUrl({ publicUrl, secret: secrets.PORTAL_SESSION_SECRET, email: admins[0] })}\n`,
  );
} else {
  console.log("\nTo sign in as an administrator without email set up, run: npm run admin-login -- --name " + name);
}
