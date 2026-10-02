#!/usr/bin/env node
// Prints a one-time administrator sign-in link, like `qm admin-login`.
//
// The portal session key exists only as a Worker secret, so this rotates
// PORTAL_SESSION_SECRET, waits for the container to restart with it, and signs
// a link with the new key. Rotation signs everyone out of the web UI; use it to
// bootstrap or recover admin access, and set up email or password sign-in for
// day-to-day use (README.md).
//
//   node scripts/admin-login.mjs [--name qm] [--email admin@example.com]
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

// The next request restarts the container with the new key. Probe with a
// throwaway link until the portal accepts this key, then mint the real one.
console.log("Waiting for the container to restart with the new key (up to ~6 minutes)…");
const deadline = Date.now() + 8 * 60_000;
for (;;) {
  const probe = adminLoginUrl({ publicUrl, secret, email }).split("#token=")[1];
  try {
    const r = await fetch(`${publicUrl}/auth/admin-login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: new URL(publicUrl).origin },
      body: new URLSearchParams({ token: probe }),
      signal: AbortSignal.timeout(60_000),
    });
    if (r.status === 303) break;
  } catch {
    // container restarting
  }
  if (Date.now() > deadline)
    fail(`portal did not accept the new key in time; check \`npx wrangler tail ${args.name}\``);
  await new Promise((r) => setTimeout(r, 10_000));
}

console.log(
  `\nOne-time admin sign-in link for ${email} (single use, expires in 5 minutes — keep it private):\n\n  ${adminLoginUrl({ publicUrl, secret, email })}\n`,
);
