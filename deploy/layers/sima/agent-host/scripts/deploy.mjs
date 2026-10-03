#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { experimental_readRawConfig } from "wrangler";
import { imagesToDelete, imagesToKeep } from "./lib.mjs";

const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};
for (const n of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!process.env[n]) fail(`${n} is not set`);

const query = (sql) => {
  const res = spawnSync(
    "npx",
    ["--no-install", "wrangler", "d1", "execute", "agent-host", "--remote", "--json", "--command", sql],
    { cwd: HERE, encoding: "utf8" },
  );
  if (res.status !== 0) fail(`D1 query failed:\n${res.stderr || res.stdout}`);
  return JSON.parse(res.stdout)[0].results;
};

const versions = query("SELECT agent, version, image, created_at FROM versions");
const instances = query("SELECT agent, version FROM instances WHERE status != 'deleted'");
const images = imagesToKeep(versions, instances);

const { rawConfig } = experimental_readRawConfig({ config: path.join(HERE, "wrangler.jsonc") });
const config = structuredClone(rawConfig);
config.containers = config.containers.map((c) =>
  c.class_name === "Instance" && Object.keys(images).length ? { ...c, images } : c,
);
const generated = path.join(HERE, ".wrangler-deploy.json");
fs.writeFileSync(generated, JSON.stringify(config, null, 2));
console.log(`Deploying with ${Object.keys(images).length} agent image(s): ${Object.keys(images).join(", ") || "none"}`);
const res = spawnSync("npx", ["--no-install", "wrangler", "deploy", "--config", generated, ...process.argv.slice(2)], {
  cwd: HERE,
  stdio: "inherit",
});
if (res.status !== 0 || process.argv.includes("--dry-run")) process.exit(res.status ?? 1);

const listed = spawnSync(
  "npx",
  ["--no-install", "wrangler", "containers", "images", "list", "--json", "--filter", "agent-host"],
  { cwd: HERE, encoding: "utf8" },
);
if (listed.status !== 0) {
  console.warn(`Could not list registry images, nothing pruned:\n${listed.stderr}`);
  process.exit(0);
}
const doomed = imagesToDelete(JSON.parse(listed.stdout), versions, images);
for (const image of doomed) {
  const deleted = spawnSync("npx", ["--no-install", "wrangler", "containers", "images", "delete", image], {
    cwd: HERE,
    encoding: "utf8",
  });
  console.log(deleted.status === 0 ? `Pruned ${image}` : `Could not prune ${image}: ${deleted.stderr.trim()}`);
}
