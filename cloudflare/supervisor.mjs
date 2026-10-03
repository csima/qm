import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORTS = { portal: 8080, core: 8081, web: 8082 };
const AUTH_CLIENT_ID = "qm-portal";
const AUTH_PREFIX = "/idp";
const AUTH_LOOPBACK = "http://127.0.0.1:8099";
const SANDBOX_API_URL = "http://sandbox.qm.internal";

export function buildServiceEnvs(env) {
  const problems = [];
  const need = (name) => {
    const value = env[name]?.trim();
    if (!value) problems.push(name);
    return value ?? "";
  };
  const opt = (name) => env[name]?.trim() || undefined;
  const pick = (names) => Object.fromEntries(names.flatMap((n) => (opt(n) ? [[n, env[n]]] : [])));
  const extra = (name) => {
    const raw = opt(name);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      return Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch (error) {
      problems.push(`${name} (must be a JSON object of strings: ${error.message})`);
      return {};
    }
  };

  const publicUrl = need("QM_PUBLIC_URL").replace(/\/$/, "");
  const orgId = need("QM_ORG_ID");
  const admins = need("QM_ADMIN_EMAILS")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const allowedEmails = [
    ...new Set([...admins, ...(opt("QM_ALLOWED_EMAILS") ?? "").split(",").map((e) => e.trim().toLowerCase())]),
  ]
    .filter(Boolean)
    .join(",");
  const allowedDomain = opt("QM_ALLOWED_EMAIL_DOMAIN")?.toLowerCase();
  const coreUrl = `http://127.0.0.1:${PORTS.core}`;
  const webUrl = `http://127.0.0.1:${PORTS.web}`;
  const issuer = `${publicUrl}${AUTH_PREFIX}`;

  const base = {
    PATH: env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: env.HOME ?? "/home/node",
    NODE_ENV: "production",
    ...pick(["TZ", "GIT_SHA"]),
  };
  const shared = {
    CORE_SIGNING_SECRET: need("CORE_SIGNING_SECRET"),
    PORTAL_IDENTITY_SECRET: need("PORTAL_IDENTITY_SECRET"),
  };

  const sandbox = opt("QM_SANDBOX_BACKEND") ?? "cloudflare";
  const core = {
    ...base,
    ...shared,
    PORT: String(PORTS.core),
    ORG_ID: orgId,
    PUBLIC_WEB_URL: publicUrl,
    WEB_UI_PUBLIC_URL: publicUrl,
    PUBLIC_API_URL: publicUrl,
    REQUIRE_SIGNED_PORTAL_IDENTITY: "1",
    DATA_DIR: "/data",
    SESSION_STORE: "postgres",
    RUN_STORE: "postgres",
    DATABASE_URL: need("DATABASE_URL"),
    HARNESS: opt("QM_HARNESS") ?? "pi",
    PI_SYSTEM_CACHE_SPLIT: "1",
    SECURITY_SCREEN: opt("QM_SECURITY_SCREEN") ?? "off",
    SANDBOX_BACKEND: sandbox,
    ADMIN_GRANTS: admins.map((email) => `${email}:org_admin`).join(","),
    ...(allowedEmails ? { AUTH_ALLOWED_EMAILS: allowedEmails } : {}),
    ...(allowedDomain ? { AUTH_ALLOWED_EMAIL_DOMAIN: allowedDomain } : {}),
    CAPABILITY_SECRET: need("CAPABILITY_SECRET"),
    CONNECTOR_SECRET_KEY: need("CONNECTOR_SECRET_KEY"),
    SKILL_SIGNING_SECRET: need("SKILL_SIGNING_SECRET"),
    DEPLOYMENT_CONTROL_SECRET: need("DEPLOYMENT_CONTROL_SECRET"),
    ...(opt("QM_MODEL_PROVIDER") ? { MODEL_PROVIDER: env.QM_MODEL_PROVIDER.trim() } : {}),
    ...(opt("QM_MODEL") ? { PI_MODEL: env.QM_MODEL.trim() } : {}),
    ...pick([
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "SPRITES_TOKEN",
      "SPRITES_EGRESS_PROXY_URL",
      "E2B_API_KEY",
      "E2B_EGRESS_PROXY_URL",
      "MODAL_TOKEN_ID",
      "MODAL_TOKEN_SECRET",
      "SLACK_BOT_TOKEN",
      "SLACK_APP_TOKEN",
      "SLACK_SIGNING_SECRET",
      "RESEND_API_KEY",
      "AUTH_EMAIL_FROM",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "DROPBOX_OAUTH_CLIENT_SECRET",
      "LINEAR_OAUTH_CLIENT_SECRET",
      "DATABASE_POOL_URL",
      "DATABASE_CA_CERT",
    ]),
  };
  if (sandbox === "sprites" && !opt("SPRITES_TOKEN")) problems.push("SPRITES_TOKEN");
  if (sandbox === "cloudflare") {
    if (!opt("S3_BUCKET")) problems.push("S3_BUCKET");
    Object.assign(core, {
      CLOUDFLARE_SANDBOX_URL: SANDBOX_API_URL,
      CLOUDFLARE_SANDBOX_TOKEN: need("QM_SANDBOX_API_TOKEN"),
    });
  }
  if (opt("QM_MODEL_PROVIDER") === "anthropic" && !opt("ANTHROPIC_API_KEY")) problems.push("ANTHROPIC_API_KEY");
  if (opt("S3_BUCKET")) {
    Object.assign(core, {
      SNAPSHOT_STORE: "s3",
      TRANSFER_STORE: "s3",
      S3_BUCKET: env.S3_BUCKET.trim(),
      S3_REGION: opt("S3_REGION") ?? "auto",
      AWS_REGION: opt("S3_REGION") ?? "auto",
      AWS_ACCESS_KEY_ID: need("AWS_ACCESS_KEY_ID"),
      AWS_SECRET_ACCESS_KEY: need("AWS_SECRET_ACCESS_KEY"),
      AWS_ENDPOINT_URL_S3: need("AWS_ENDPOINT_URL_S3"),
      ...(sandbox === "sprites" ? { SPRITES_SNAPSHOT_S3_BUCKET: env.S3_BUCKET.trim() } : {}),
      ...(sandbox === "e2b" ? { E2B_SNAPSHOT_S3_BUCKET: env.S3_BUCKET.trim() } : {}),
      ...(sandbox === "cloudflare" ? { CLOUDFLARE_SANDBOX_SNAPSHOT_S3_BUCKET: env.S3_BUCKET.trim() } : {}),
    });
  }
  Object.assign(core, extra("QM_CORE_ENV_JSON"));

  const web = {
    ...base,
    ...shared,
    PORT: String(PORTS.web),
    CORE_API_URL: coreUrl,
    CORE_ORG_ID: orgId,
    WEB_UI_PUBLIC_URL: publicUrl,
    ADMIN_BASE_PATH: "/admin",
    ADMIN_ENABLED: "1",
    ...extra("QM_WEB_ENV_JSON"),
  };

  const portal = {
    ...base,
    ...shared,
    PORT: String(PORTS.portal),
    CORE_API_URL: coreUrl,
    CORE_ORG_ID: orgId,
    PORTAL_PUBLIC_URL: publicUrl,
    PORTAL_SESSION_SECRET: need("PORTAL_SESSION_SECRET"),
    PORTAL_XFF_TRUSTED_HOPS: "1",
    WEB_UI_UPSTREAM: webUrl,
    ADMIN_UPSTREAM: `${webUrl}/admin`,
    AUTH_BROKER_UPSTREAM: AUTH_LOOPBACK,
    AUTH_EMBEDDED: "1",
    AUTH_ISSUER: issuer,
    AUTH_CLIENT_ID,
    AUTH_REDIRECT_URI: `${publicUrl}/auth/callback`,
    AUTH_BROKER_PREFIX: AUTH_PREFIX,
    AUTH_TOKEN_SECRET: need("AUTH_TOKEN_SECRET"),
    AUTH_SIGNING_JWK: need("AUTH_SIGNING_JWK"),
    AUTH_CLIENT_SECRET: need("AUTH_CLIENT_SECRET"),
    OIDC_CLIENT_ID: AUTH_CLIENT_ID,
    OIDC_CLIENT_SECRET: env.AUTH_CLIENT_SECRET ?? "",
    OIDC_ISSUER: issuer,
    OIDC_AUTH_ENDPOINT: `${issuer}/authorize`,
    OIDC_TOKEN_ENDPOINT: `${AUTH_LOOPBACK}/token`,
    OIDC_USERINFO_ENDPOINT: `${AUTH_LOOPBACK}/userinfo`,
    OIDC_JWKS_URI: `${AUTH_LOOPBACK}/.well-known/jwks.json`,
    OIDC_SCOPES: "openid email",
    OIDC_PRINCIPAL_CLAIM: "email",
    ...(allowedEmails ? { OIDC_ALLOWED_EMAILS: allowedEmails, AUTH_ALLOWED_EMAILS: allowedEmails } : {}),
    ...(allowedDomain ? { OIDC_ALLOWED_EMAIL_DOMAIN: allowedDomain, AUTH_ALLOWED_EMAIL_DOMAIN: allowedDomain } : {}),
    ...pick([
      "AUTH_PASSWORD_USERS",
      "AUTH_EMAIL_TRANSPORT",
      "AUTH_EMAIL_FROM",
      "AUTH_BRAND_NAME",
      "RESEND_API_KEY",
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_USERNAME",
      "SMTP_PASSWORD",
      "SMTP_TLS",
    ]),
    ...extra("QM_PORTAL_ENV_JSON"),
  };

  return { problems, services: { core, web, portal } };
}

const SERVICES = [
  { name: "core", cwd: ".", entry: "src/index.ts", env: "core" },
  { name: "web-ui", cwd: "plugins/web-ui", entry: "server/index.ts", env: "web" },
  { name: "portal", cwd: "plugins/portal", entry: "src/index.ts", env: "portal" },
];

function prefixLines(stream, out, name) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    let nl;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      out.write(`[${name}] ${buffered.slice(0, nl)}\n`);
      buffered = buffered.slice(nl + 1);
    }
  });
  stream.on("end", () => buffered && out.write(`[${name}] ${buffered}\n`));
}

function main() {
  const { problems, services } = buildServiceEnvs(process.env);
  if (problems.length) {
    console.error(`[supervisor] missing or invalid configuration: ${problems.join(", ")}`);
    process.exit(78);
  }
  mkdirSync("/data", { recursive: true });

  const children = new Map();
  let stopping = false;
  const stopAll = (signal, code) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of children.values()) child.kill(signal);
    setTimeout(() => {
      for (const child of children.values()) child.kill("SIGKILL");
      process.exit(code);
    }, 290_000).unref();
  };

  for (const svc of SERVICES) {
    const child = spawn(process.execPath, [svc.entry], {
      cwd: join(ROOT, svc.cwd),
      env: services[svc.env],
      stdio: ["ignore", "pipe", "pipe"],
    });
    prefixLines(child.stdout, process.stdout, svc.name);
    prefixLines(child.stderr, process.stderr, svc.name);
    children.set(svc.name, child);
    child.on("exit", (code, signal) => {
      children.delete(svc.name);
      if (!stopping) {
        console.error(`[supervisor] ${svc.name} exited (code=${code}, signal=${signal}); stopping container`);
        stopAll("SIGTERM", 1);
      }
      if (children.size === 0) process.exit(process.exitCode ?? 0);
    });
  }

  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stopAll("SIGTERM", 0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
