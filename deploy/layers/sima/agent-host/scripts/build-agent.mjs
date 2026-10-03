#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dockerfile, guardConfig, parseManifest, safeRelativePath, sqlString, versionId } from "./lib.mjs";

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values: args } = parseArgs({
  options: {
    source: { type: "string" },
    ref: { type: "string" },
    subdir: { type: "string" },
    "no-deploy": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "no-push": { type: "boolean", default: false },
  },
});
const fail = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};
const run = (cmd, argv, opts = {}) => {
  const res = spawnSync(cmd, argv, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], ...opts });
  if (res.status !== 0) fail(`${cmd} ${argv[0]} failed:\n${res.stderr || res.stdout}`);
  return res.stdout;
};

if (!args.source) fail("--source <path or git URL> is required");
if (args.subdir && !safeRelativePath(args.subdir)) fail("--subdir must be a relative path inside the repo");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!args["dry-run"] && !args["no-push"])
  for (const n of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!process.env[n]) fail(`${n} is not set`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-build-"));
process.on("exit", () => fs.rmSync(work, { recursive: true, force: true }));
let checkout = path.resolve(args.source);
let commit = null;
let source = args.source;
if (/^(https:\/\/|git@)/.test(args.source)) {
  checkout = path.join(work, "src");
  const token = process.env.GITHUB_TOKEN;
  const auth =
    token && args.source.startsWith("https://github.com/")
      ? [
          "-c",
          `http.https://github.com/.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        ]
      : [];
  run("git", [
    ...auth,
    "clone",
    "--quiet",
    "--depth",
    "1",
    ...(args.ref ? ["--branch", args.ref] : []),
    args.source,
    checkout,
  ]);
} else if (!fs.existsSync(checkout)) fail(`${checkout} does not exist`);
const head = spawnSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" });
if (head.status === 0) {
  const dirty = spawnSync("git", ["-C", checkout, "status", "--porcelain", "--", args.subdir ?? "."], {
    encoding: "utf8",
  });
  commit = head.stdout.trim() + (dirty.stdout.trim() ? "-dirty" : "");
}

const agentDir = path.join(checkout, args.subdir ?? "");
const manifestPath = path.join(agentDir, "agent.yaml");
if (!fs.existsSync(manifestPath)) fail(`${manifestPath} not found`);
const manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"));
if (manifest.setup && !fs.existsSync(path.join(agentDir, manifest.setup)))
  fail(`setup script ${manifest.setup} not found`);

const version = versionId(commit);
const context = path.join(work, "context");
fs.cpSync(agentDir, path.join(context, "agent"), {
  recursive: true,
  filter: (src) => path.basename(src) !== ".git",
});
fs.cpSync(path.join(HERE, "runtime"), path.join(context, "runtime"), { recursive: true });
fs.writeFileSync(path.join(context, "runtime", "guard.json"), guardConfig(manifest));
fs.writeFileSync(path.join(context, "Dockerfile"), dockerfile(manifest, { version }));
console.log(`Building ${manifest.name} ${version}${commit ? ` from ${commit.slice(0, 12)}` : ""}…`);
if (args["dry-run"]) {
  console.log(fs.readFileSync(path.join(context, "Dockerfile"), "utf8"));
  process.exit(0);
}

const repository = `agent-host-${manifest.name}`;
const tag = `${repository}:${version}`;
const ca = process.env.BUILD_CA_FILE;
run(
  "docker",
  [
    "buildx",
    "build",
    "--provenance=false",
    "--sbom=false",
    "--platform",
    "linux/amd64",
    "--load",
    "-t",
    tag,
    ...(ca ? ["--secret", `id=buildca,src=${ca}`] : []),
    context,
  ],
  { stdio: ["inherit", "inherit", "inherit"] },
);
if (args["no-push"]) {
  console.log(`✔ Built ${tag} (not pushed)`);
  process.exit(0);
}
const pushed = run("npx", ["--no-install", "wrangler", "containers", "push", tag], { cwd: HERE });
const digest = pushed.match(/digest: (sha256:[0-9a-f]{64})/)?.[1];
if (!digest) fail(`could not find the pushed digest in:\n${pushed}`);
const image = `registry.cloudflare.com/${account}/${repository}@${digest}`;

const sql = path.join(work, "version.sql");
fs.writeFileSync(
  sql,
  `INSERT INTO versions (agent, version, image, commit_sha, source, subdir, manifest, created_at) VALUES (${[
    manifest.name,
    version,
    image,
    commit,
    source.replace(/\/\/[^@/]+@/, "//"),
    args.subdir ?? "",
    JSON.stringify(manifest),
  ]
    .map(sqlString)
    .join(", ")}, ${Date.now()});\n`,
);
run("npx", ["--no-install", "wrangler", "d1", "execute", "agent-host", "--remote", "--file", sql], { cwd: HERE });
console.log(`✔ Recorded ${manifest.name} ${version} → ${image}`);

if (!args["no-deploy"]) {
  const res = spawnSync(process.execPath, [path.join(HERE, "scripts", "deploy.mjs")], { stdio: "inherit", cwd: HERE });
  process.exit(res.status ?? 1);
}
