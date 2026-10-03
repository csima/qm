import fs from "node:fs";
import { parseArgs } from "node:util";

const HOST = process.env.AGENT_HOST_URL ?? "http://host.internal";
const USAGE = `usage:
  <command printing a secret> | agent-secret put    hand the secret to the agent that called you; prints a handle
  agent-secret get <handle>                         print a secret another agent handed you (works once)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { task: { type: "string" }, help: { type: "boolean" } },
});

function fail(message, code = 1) {
  process.stderr.write(`agent-secret: ${message}\n`);
  process.exit(code);
}

function currentTask() {
  const window = process.env.AGENT_WINDOW;
  if (!window) return null;
  try {
    return fs.readFileSync(`/var/lib/agent/current/${window}`, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function post(route, body) {
  const res = await fetch(`${HOST}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((error) => fail(`could not reach the agent host: ${error.message}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error ?? `the agent host returned ${res.status}`);
  return data;
}

if (values.help) {
  process.stdout.write(`${USAGE}\n`);
} else if (positionals[0] === "put" && positionals.length === 1) {
  if (process.stdin.isTTY) fail("pipe the secret in, for example: op read op://vault/item/field | agent-secret put", 2);
  const value = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (!value) fail("nothing was piped in", 2);
  const task = values.task ?? currentTask();
  if (!task) fail("no task is in progress in this session", 2);
  const drop = await post("/v1/secrets", { value, task });
  process.stdout.write(`${drop.handle}\n`);
  process.stderr.write(`agent-secret: only ${drop.for} can read it, once, within 10 minutes\n`);
} else if (positionals[0] === "get" && positionals.length === 2) {
  const { value } = await post("/v1/secrets/redeem", { handle: positionals[1] });
  process.stdout.write(value);
} else {
  fail(USAGE, 2);
}
