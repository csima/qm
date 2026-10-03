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
const TICK_MS = 500;
const READY_TIMEOUT_MS = 120_000;
const START_TIMEOUT_MS = 60_000;
const TASK_TIMEOUT_MS = 60 * 60_000;
const MAX_TEXT = 200_000;
const MAX_TOOL_INPUT = 2_000;
const READY_PATTERN = /bypass permissions/i;

const windows = new Map();
const pendingTools = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

function windowState(name) {
  let state = windows.get(name);
  if (!state) {
    state = { offset: 0, partial: "", busy: false, current: null };
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
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tmux ${args[0]} exited ${code}: ${stderr}`)),
    );
    child.stdin.end(input);
  });
}

async function post(route, body) {
  try {
    const res = await fetch(`${HOST}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return;
    if (res.status >= 400 && res.status < 500) {
      log("host rejected", route, res.status, await res.text());
      return;
    }
    throw new Error(`host returned ${res.status}`);
  } catch (error) {
    log("deferring", route, String(error));
    const file = path.join(OUTBOX, `${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    await fs.writeFile(file, JSON.stringify({ route, body }));
  }
}

async function flushOutbox() {
  const files = (await fs.readdir(OUTBOX).catch(() => [])).sort();
  for (const name of files) {
    const file = path.join(OUTBOX, name);
    const { route, body } = JSON.parse(await fs.readFile(file, "utf8"));
    try {
      const res = await fetch(`${HOST}${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok && res.status >= 500) return;
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

async function finish(state, status, fields) {
  const task = state.current;
  state.current = null;
  await fs.unlink(task.file).catch(() => {});
  await post(`/v1/tasks/${task.id}`, { status, ...fields });
  log("task", task.id, status);
}

async function handleEvent(name, event) {
  const state = windowState(name);
  if (event.agent_event === "start") {
    state.busy = true;
    const task = state.current;
    if (task && !task.promptId && typeof event.prompt === "string" && event.prompt.includes(task.marker)) {
      task.promptId = event.prompt_id;
      task.sessionId = event.session_id;
    }
  } else if (event.agent_event === "stop") {
    state.busy = false;
    const task = state.current;
    if (task?.promptId && event.prompt_id === task.promptId) {
      const result = typeof event.last_assistant_message === "string" ? event.last_assistant_message : "";
      await finish(state, "done", { result: clip(result, MAX_TEXT), sessionId: task.sessionId });
    }
  } else if (event.agent_event === "tool") {
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

async function windowReady(name) {
  const pane = await tmux("capture-pane", "-p", "-t", `agent:${name}`).catch(() => "");
  return READY_PATTERN.test(pane);
}

async function deliver(name, task) {
  const text = `${task.marker} from ${task.caller} via ${task.via}]\n${task.message}`;
  const buffer = `task-${task.id}`;
  await tmuxWithInput(["load-buffer", "-b", buffer, "-"], text);
  await tmux("paste-buffer", "-p", "-d", "-b", buffer, "-t", `agent:${name}`);
  await sleep(400);
  await tmux("send-keys", "-t", `agent:${name}`, "Enter");
}

async function nextQueued() {
  const files = (await fs.readdir(QUEUE).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
  const byWindow = new Map();
  for (const name of files) {
    const file = path.join(QUEUE, name);
    const task = JSON.parse(await fs.readFile(file, "utf8"));
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
      if (await windowReady(name)) {
        await deliver(name, task);
        task.deliveredAt = now;
      } else if (now - task.takenAt > READY_TIMEOUT_MS) {
        await finish(state, "failed", { error: "session did not become ready" });
      }
    } else if (!task.promptId && now - task.deliveredAt > START_TIMEOUT_MS) {
      await finish(state, "failed", { error: "the harness did not accept the message" });
    } else if (now - task.deliveredAt > TASK_TIMEOUT_MS) {
      await finish(state, "failed", { error: "timed out" });
    }
    return;
  }
  if (!queued || state.busy) return;
  state.current = {
    ...queued,
    marker: `[agent-host task ${queued.id}`,
    takenAt: now,
    deliveredAt: 0,
    promptId: null,
  };
  await post(`/v1/tasks/${queued.id}`, { status: "running" });
}

async function knownWindows() {
  const listed = await tmux("list-windows", "-t", "agent", "-F", "#{window_name}").catch(() => "");
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
    const candidate = queued.get(name);
    const state = windowState(name);
    await advance(name, state.current ? null : candidate);
  }
  if (pendingTools.length) await post("/v1/events", { tools: pendingTools.splice(0, pendingTools.length) });
  await flushOutbox();
}

for (const dir of [QUEUE, EVENTS, OUTBOX]) await fs.mkdir(dir, { recursive: true });
log("agentd started", HOST);
for (;;) {
  try {
    await tick();
  } catch (error) {
    log("tick failed", error instanceof Error ? error.stack : String(error));
  }
  await sleep(TICK_MS);
}
