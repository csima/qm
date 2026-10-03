import fs from "node:fs";
import { parseArgs } from "node:util";

const HOST = process.env.AGENT_HOST_URL ?? "http://host.internal";
const USAGE = `usage:
  agent-list (or agent-call list)          agents you can call, and who you are acting for
  agent-call <instance> <message…>         send a message and wait for the reply ("-" reads stdin)
  agent-call --wait <call-id>              keep waiting for an earlier call
options:
  --timeout <seconds>                      how long to wait before returning the call id (default 540)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { wait: { type: "string" }, timeout: { type: "string", default: "540" }, help: { type: "boolean" } },
});

function fail(message, code = 1) {
  process.stderr.write(`agent-call: ${message}\n`);
  process.exit(code);
}

function parent() {
  const window = process.env.AGENT_WINDOW;
  if (!window) return null;
  try {
    return fs.readFileSync(`/var/lib/agent/current/${window}`, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function request(method, route, body) {
  const init = body
    ? { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
    : { method };
  const res = await fetch(`${HOST}${route}`, init).catch((error) =>
    fail(`could not reach the agent host: ${error.message}`),
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) fail(data.error ?? `the agent host returned ${res.status}`);
  return data;
}

async function follow(id, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const left = Math.ceil((deadline - Date.now()) / 1000);
    const { call } = await request("GET", `/v1/calls/${id}?wait=${Math.max(0, Math.min(50, left))}`);
    if (call.status === "done") {
      process.stdout.write(`${call.result ?? ""}\n`);
      return;
    }
    if (call.status === "failed") fail(`${call.instance} could not finish: ${call.error ?? "unknown error"}`);
    if (Date.now() >= deadline) fail(`${call.instance} is still working (call ${id}); run: agent-call --wait ${id}`, 3);
  }
}

const timeout = Number(values.timeout);
if (!Number.isFinite(timeout) || timeout < 0) fail("--timeout must be a number of seconds");
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
} else if (values.wait) {
  await follow(values.wait, timeout);
} else if (positionals[0] === "list" && positionals.length === 1) {
  const p = parent();
  const data = await request("GET", `/v1/agents${p ? `?parent=${p}` : ""}`);
  process.stdout.write(`acting for ${data.actingFor}\n`);
  for (const a of data.agents) process.stdout.write(`${a.instance}\t${a.agent}\t${a.status}\t${a.description}\n`);
  if (!data.agents.length) process.stdout.write("no other agents you can call\n");
} else if (positionals.length >= 2) {
  const [target, ...words] = positionals;
  const message = words.length === 1 && words[0] === "-" ? fs.readFileSync(0, "utf8") : words.join(" ");
  const { call, actingFor } = await request("POST", "/v1/calls", { target, message, parent: parent() });
  process.stderr.write(`agent-call: ${target} is working on call ${call.id} for ${actingFor}\n`);
  await follow(call.id, timeout);
} else {
  fail(USAGE, 2);
}
