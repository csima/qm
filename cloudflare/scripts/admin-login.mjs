#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GENERATED_SECRETS, adminLoginUrl } from "./lib.mjs";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: { name: { type: "string", default: "qm" }, email: { type: "string" } },
});
const fail = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};
for (const n of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!process.env[n]) fail(`${n} is not set`);

const res = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${args.name}/settings`,
  { headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } },
);
const body = await res.json();
if (!res.ok) fail(`could not read Worker settings: ${JSON.stringify(body.errors)}`);
const vars = Object.fromEntries(
  body.result.bindings.filter((b) => b.type === "plain_text").map((b) => [b.name, b.text]),
);
const publicUrl = vars.QM_PUBLIC_URL;
const admins = (vars.QM_ADMIN_EMAILS ?? "").split(",").filter(Boolean);
const email = (args.email ?? admins[0] ?? "").toLowerCase();
if (!publicUrl) fail("QM_PUBLIC_URL is not set on the Worker; deploy first");
if (!admins.includes(email)) fail(`${email || "(none)"} is not in QM_ADMIN_EMAILS (${admins.join(", ")})`);

const secret = GENERATED_SECRETS.PORTAL_SESSION_SECRET();
console.log("Rotating PORTAL_SESSION_SECRET (signs out existing web sessions)…");
const put = spawnSync(
  "npx",
  ["--no-install", "wrangler", "secret", "put", "PORTAL_SESSION_SECRET", "--name", args.name],
  {
    cwd: HERE,
    input: secret,
    stdio: ["pipe", "inherit", "inherit"],
  },
);
if (put.status !== 0) fail("wrangler secret put failed");

console.log("Waiting for the container to restart with the new key (up to ~6 minutes)…");
const rotatedAt = Date.now();
const deadline = rotatedAt + 8 * 60_000;
const ACCESS_SETTLE_MS = 90_000;
let behindAccess = false;
for (;;) {
  if (behindAccess) {
    const health = await fetch(`${publicUrl}/healthz`, { signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
    if (health?.ok && Date.now() - rotatedAt > ACCESS_SETTLE_MS) break;
  } else {
    const probe = adminLoginUrl({ publicUrl, secret, email }).split("#token=")[1];
    const r = await fetch(`${publicUrl}/auth/admin-login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(publicUrl).origin },
      body: new URLSearchParams({ token: probe }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => undefined);
    if (r?.status === 303) break;
    behindAccess = /\.cloudflareaccess\.com\//.test(r?.headers.get("location") ?? "");
    if (behindAccess)
      console.log("  the site is behind Cloudflare Access; waiting for /healthz after the restart instead");
  }
  if (Date.now() > deadline)
    fail(`portal did not accept the new key in time; check \`npx wrangler tail ${args.name}\``);
  await new Promise((r) => setTimeout(r, 10_000));
}

console.log(
  `\nOne-time admin sign-in link for ${email} (single use, expires in 5 minutes — keep it private):\n\n  ${adminLoginUrl({ publicUrl, secret, email })}\n`,
);
if (behindAccess) console.log(`Sign in to Cloudflare Access at ${publicUrl} first, then open the link.`);
