import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HOST = process.env.AGENT_HOST_URL ?? "http://host.internal";
const ROOT = "/var/lib/agent";
const QUEUE = path.join(ROOT, "queue");
const EVENTS = path.join(ROOT, "events");
const OUTBOX = path.join(ROOT, "outbox");
const CURRENT = path.join(ROOT, "current");
const TICK_MS = 500;
const READY_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 60_000;
const IDLE_GRACE_MS = 60_000;
const OPEN_TOOL_GRACE_MS = 5 * 60_000;
const TASK_TIMEOUT_MS = 60 * 60_000;
const MAX_TEXT = 200_000;
const MAX_TOOL_INPUT = 2_000;
const READY_PATTERN = /bypass permissions/i;
const WORKING_PATTERN = /esc to interrupt/i;
const HEADER_PREFIX = "[agent-host task";

const windows = new Map();
const pendingTools = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const target = (name) => `agent:=${name}`;

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

const looksLikeHeader = (line) =>
  line
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .startsWith("agenthosttask");

export function sanitizeMessage(text) {
  return text
    .replace(/[\u2028\u2029\u0085]/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .split("\n")
    .map((line) => (looksLikeHeader(line) ? `(quoted) ${line}` : line))
    .join("\n");
}

function windowState(name) {
  let state = windows.get(name);
  if (!state) {
    state = { offset: 0, partial: "", busy: false, lastEventAt: 0, openTools: 0, transcript: null, current: null };
    windows.set(name, state);
  }
  return state;
}

async function tmux(...args) {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout;
}

function tmuxWithInput(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", (error) => (stderr += String(error)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tmux ${args[0]} exited ${code}: ${stderr}`)),
    );
    child.stdin.end(input);
  });
}

async function send(route, body) {
  const res = await fetch(`${HOST}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status >= 500) throw new Error(`host returned ${res.status}`);
  if (!res.ok) log("host rejected", route, res.status, await res.text());
  return res.status;
}

async function post(route, body) {
  try {
    await send(route, body);
  } catch (error) {
    log("deferring", route, String(error));
    const file = path.join(OUTBOX, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ route, body }));
    await fs.rename(`${file}.tmp`, file);
  }
}

async function flushOutbox() {
  const files = (await fs.readdir(OUTBOX).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
  for (const name of files) {
    const file = path.join(OUTBOX, name);
    let entry;
    try {
      entry = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      log("quarantining unreadable outbox entry", name, String(error));
      await fs.rename(file, `${file}.bad`).catch(() => {});
      continue;
    }
    try {
      await send(entry.route, entry.body);
      await fs.unlink(file);
    } catch {
      return;
    }
  }
}

async function readEvents(name) {
  const state = windowState(name);
  const file = path.join(EVENTS, `${name}.jsonl`);
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return [];
  try {
    const { size } = await handle.stat();
    if (size < state.offset) state.offset = 0;
    if (size === state.offset) return [];
    const buffer = Buffer.alloc(size - state.offset);
    await handle.read(buffer, 0, buffer.length, state.offset);
    state.offset = size;
    const text = state.partial + buffer.toString("utf8");
    const lines = text.split("\n");
    state.partial = lines.pop() ?? "";
    return lines.flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  } finally {
    await handle.close();
  }
}

async function setCurrent(name, id) {
  const file = path.join(CURRENT, name);
  if (!id) return fs.unlink(file).catch(() => {});
  await fs.writeFile(`${file}.tmp`, `${id}\n`);
  await fs.rename(`${file}.tmp`, file);
}

async function finish(name, state, status, fields) {
  const task = state.current;
  state.current = null;
  state.busy = false;
  state.openTools = 0;
  await setCurrent(name, null);
  await fs.unlink(task.file).catch(() => {});
  await post(`/v1/tasks/${task.id}`, { status, ...fields });
  log("task", task.id, status);
}

async function handleEvent(name, event) {
  const state = windowState(name);
  state.lastEventAt = Date.now();
  if (typeof event.transcript_path === "string") state.transcript = event.transcript_path;
  if (event.agent_event === "tooldone") state.openTools = Math.max(0, state.openTools - 1);
  if (event.agent_event === "start") {
    state.busy = true;
    state.openTools = 0;
    const task = state.current;
    if (task && !task.promptId && typeof event.prompt === "string" && event.prompt.includes(task.marker)) {
      task.promptId = event.prompt_id;
      task.sessionId = event.session_id;
    }
  } else if (event.agent_event === "stop") {
    state.busy = false;
    state.openTools = 0;
    const task = state.current;
    if (task?.promptId && event.prompt_id === task.promptId) {
      const result = typeof event.last_assistant_message === "string" ? event.last_assistant_message : "";
      await finish(name, state, "done", { result: clip(result, MAX_TEXT), sessionId: task.sessionId });
    }
  } else if (event.agent_event === "blocked") {
    pendingTools.push({
      session: name,
      sessionId: event.session_id,
      tool: event.tool_name,
      input: clip(String(event.tool_input?.command ?? JSON.stringify(event.tool_input ?? {})), MAX_TOOL_INPUT),
      blocked: clip(String(event.blocked_reason ?? ""), 500),
      at: event.at,
    });
  } else if (event.agent_event === "tool") {
    state.openTools += 1;
    const input = event.tool_input ?? {};
    const summary = typeof input.command === "string" ? input.command : JSON.stringify(input);
    pendingTools.push({
      session: name,
      sessionId: event.session_id,
      tool: event.tool_name,
      input: clip(summary, MAX_TOOL_INPUT),
      at: event.at,
    });
  }
}

async function pane(name) {
  return tmux("capture-pane", "-p", "-t", target(name)).catch(() => "");
}

async function paneIdle(name) {
  const text = await pane(name);
  return READY_PATTERN.test(text) && !WORKING_PATTERN.test(text);
}

async function quiet(name, state, since) {
  const now = Date.now();
  const grace = state.openTools > 0 ? OPEN_TOOL_GRACE_MS : IDLE_GRACE_MS;
  if (now - Math.max(state.lastEventAt, since) <= grace) return false;
  if (state.transcript) {
    const stat = await fs.stat(state.transcript).catch(() => null);
    if (stat && now - stat.mtimeMs <= grace) return false;
  }
  if (!(await paneIdle(name))) return false;
  state.openTools = 0;
  return true;
}

async function claim(task) {
  try {
    const status = await send(`/v1/tasks/${task.id}`, { status: "running" });
    if (status !== 409) return true;
    log("task", task.id, "was already finished by the host; dropping it");
    await fs.unlink(task.file).catch(() => {});
    return false;
  } catch (error) {
    await post(`/v1/tasks/${task.id}`, { status: "running" });
    return true;
  }
}

async function deliver(name, task) {
  const text = `${task.marker} from ${task.caller} via ${task.via}]\n${sanitizeMessage(task.message)}`;
  const buffer = `task-${task.id}`;
  await tmuxWithInput(["load-buffer", "-b", buffer, "-"], text);
  await tmux("paste-buffer", "-p", "-d", "-b", buffer, "-t", target(name));
  await sleep(400);
  await tmux("send-keys", "-t", target(name), "Enter");
}

async function nextQueued() {
  const files = (await fs.readdir(QUEUE).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
  const byWindow = new Map();
  for (const name of files) {
    const file = path.join(QUEUE, name);
    let task;
    try {
      task = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (error) {
      log("dropping unreadable queue entry", name, String(error));
      await fs.rename(file, `${file}.bad`).catch(() => {});
      continue;
    }
    const session = task.session ?? "main";
    if (!byWindow.has(session)) byWindow.set(session, { ...task, session, file });
  }
  return byWindow;
}

async function advance(name, queued) {
  const state = windowState(name);
  const now = Date.now();
  const task = state.current;
  if (task) {
    if (!task.deliveredAt) {
      if (await paneIdle(name)) {
        await setCurrent(name, task.id);
        await deliver(name, task);
        task.deliveredAt = now;
      } else if (now - task.takenAt > READY_TIMEOUT_MS) {
        await finish(name, state, "failed", { error: "session did not become ready" });
      }
    } else if (!task.promptId && now - task.deliveredAt > START_TIMEOUT_MS) {
      await finish(name, state, "failed", { error: "the harness did not accept the message" });
    } else if (now - task.deliveredAt > TASK_TIMEOUT_MS) {
      await finish(name, state, "failed", { error: "timed out" });
    } else if (task.promptId && (await quiet(name, state, task.deliveredAt))) {
      await finish(name, state, "failed", { error: "the turn ended without a reply (interrupted or an API error)" });
    }
    return;
  }
  if (state.busy && (await quiet(name, state, 0))) state.busy = false;
  if (!queued || state.busy) return;
  if (!(await claim(queued))) return;
  state.current = {
    ...queued,
    marker: `${HEADER_PREFIX} ${queued.id}`,
    takenAt: now,
    deliveredAt: 0,
    promptId: null,
  };
}

async function knownWindows() {
  const listed = await tmux("list-windows", "-t", "=agent", "-F", "#{window_name}").catch(() => "");
  return listed.split("\n").filter(Boolean);
}

async function tick() {
  const names = await knownWindows();
  for (const name of names) {
    for (const event of await readEvents(name)) await handleEvent(name, event);
  }
  const queued = await nextQueued();
  for (const [session, task] of queued) {
    if (!names.includes(session) && !windows.get(session)?.current) {
      await fs.unlink(task.file).catch(() => {});
      await post(`/v1/tasks/${task.id}`, { status: "failed", error: `no session named ${session}` });
    }
  }
  for (const name of names) {
    const state = windowState(name);
    await advance(name, state.current ? null : queued.get(name));
  }
  if (pendingTools.length) await post("/v1/events", { tools: pendingTools.splice(0, pendingTools.length) });
  await flushOutbox();
}

async function main() {
  for (const dir of [QUEUE, EVENTS, OUTBOX, CURRENT]) await fs.mkdir(dir, { recursive: true });
  for (const name of await fs.readdir(CURRENT)) await fs.unlink(path.join(CURRENT, name)).catch(() => {});
  log("agentd started", HOST);
  for (;;) {
    try {
      await tick();
    } catch (error) {
      log("tick failed", error instanceof Error ? error.stack : String(error));
    }
    await sleep(TICK_MS);
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) await main();
