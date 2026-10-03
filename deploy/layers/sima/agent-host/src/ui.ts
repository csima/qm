import type { AgentSummary } from "./access.ts";
import type { Caller, InstanceRow } from "./env.ts";
import { can } from "./policy.ts";

const XTERM = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0";
const FIT = "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0";

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

export const esc = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const STYLE = `
:root{--bg:#fafaf9;--panel:#fff;--ink:#1c1917;--quiet:#57534e;--line:#e7e5e4;--accent:#2563eb;--ok:#15803d;--bad:#b91c1c;--term:#0c0a09}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--panel:#1c1917;--ink:#f5f5f4;--quiet:#a8a29e;--line:#292524;--accent:#60a5fa;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,sans-serif}
header{display:flex;gap:16px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
header a{color:var(--ink);text-decoration:none;font-weight:600}header nav{margin-left:auto;display:flex;gap:16px;color:var(--quiet);font-size:14px}
header nav a{font-weight:400;color:var(--quiet)}main{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0 16px}h2{font-size:16px;margin:24px 0 8px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);font-size:14px;vertical-align:top}th{color:var(--quiet);font-weight:500}
a{color:var(--accent)}code{font:13px ui-monospace,monospace}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:12px}
.running{color:var(--ok);border-color:currentColor}.error{color:var(--bad);border-color:currentColor}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}
select,input,textarea,button{font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
textarea{width:100%;min-height:72px;resize:vertical}
#term{height:min(60vh,560px);background:var(--term);border-radius:8px;padding:6px;overflow:hidden}
.muted{color:var(--quiet);font-size:13px}.result{white-space:pre-wrap;font-size:14px}
fieldset{border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0;background:var(--panel)}legend{font-weight:600;padding:0 4px}
.field{display:grid;gap:4px;margin:8px 0}.field input[type=text],.field input[type=password]{width:100%}
.req{color:var(--bad);font-size:12px}.set{color:var(--ok);font-size:12px}
.key{padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);word-break:break-all}
@media (max-width:640px){header nav span{display:none}.tasks th:first-child,.tasks td:first-child,.instances th:nth-child(n+4),.instances td:nth-child(n+4){display:none}}
`;

export function page(title: string, caller: Caller, body: string, head = ""): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style>${head}</head><body>
<header><a href="/">Agent host</a><nav><a href="/credentials">Credentials</a><a href="/keys">API keys</a><span>${esc(caller.email)}</span></nav></header>
<main>${body}</main></body></html>`;
  return new Response(html, { headers: PAGE_HEADERS });
}

export function unauthorizedPage(): Response {
  return new Response(
    "<!doctype html><title>Sign in</title><p>Sign in through Cloudflare Access to use the agent host.</p>",
    { status: 401, headers: PAGE_HEADERS },
  );
}

const CLIENT = `
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const emails = (text) => text.split(/[\\s,]+/).map((s) => s.trim()).filter(Boolean);
async function call(path, init = {}) {
  const res = await fetch("/ui/v1" + path, { ...init, headers: { "content-type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
function credentialValues(root) {
  const set = {};
  const clear = [];
  root.querySelectorAll("[data-cred]").forEach((el) => { if (el.value) set[el.dataset.cred] = el.value; });
  root.querySelectorAll("[data-clear]:checked").forEach((el) => clear.push(el.dataset.clear));
  return { set, clear };
}
async function follow(task, status, out) {
  let t = task;
  while (t.status === "queued" || t.status === "running") {
    status.textContent = t.status === "running" ? "Working…" : "Starting…";
    ({ task: t } = await call("/tasks/" + t.id + "?wait=25"));
  }
  status.textContent = t.status === "done" ? "Done" : "Failed";
  out.textContent = t.result ?? t.error ?? "";
}
`;

interface CredentialField {
  name: string;
  description: string;
  required: boolean;
}

function credentialFields(fields: CredentialField[], saved: string[], clearable: boolean): string {
  return fields
    .map(
      (
        f,
      ) => `<div class="field"><label><code>${esc(f.name)}</code> ${f.required ? '<span class="req">required</span>' : ""} ${
        saved.includes(f.name) ? '<span class="set">saved</span>' : ""
      }</label><span class="muted">${esc(f.description)}</span>
<input type="password" autocomplete="off" data-cred="${esc(f.name)}" placeholder="${saved.includes(f.name) ? "leave blank to keep the saved value" : "value"}">${
        clearable && saved.includes(f.name)
          ? `<label class="muted"><input type="checkbox" data-clear="${esc(f.name)}"> clear</label>`
          : ""
      }</div>`,
    )
    .join("");
}

function modelFields(names: string[]): CredentialField[] {
  return names.map((name) => ({
    name,
    description:
      name === "CLAUDE_CODE_OAUTH_TOKEN"
        ? "Optional: your Claude subscription token (claude setup-token) instead of the host's default"
        : "Optional: your Anthropic API key instead of the host's default",
    required: false,
  }));
}

const pill = (status: string) => `<span class="pill ${esc(status)}">${esc(status)}</span>`;

export function homePage(caller: Caller, rows: InstanceRow[], agents: AgentSummary[]): Response {
  const visible = rows.filter((r) => can(caller, r, "view"));
  const agentRows = agents
    .map(
      (a) =>
        `<tr><td><strong>${esc(a.agent)}</strong></td><td>${esc(a.description)}</td><td><a href="/new?agent=${encodeURIComponent(a.agent)}">New instance or one-off run</a></td>${
          caller.admin
            ? `<td><div class="bar"><input data-use="${esc(a.agent)}" value="${esc((a.use ?? []).join(", "))}" placeholder="emails or *"><button data-save-use="${esc(a.agent)}">Save</button></div></td>`
            : ""
        }</tr>`,
    )
    .join("");
  const agentsTable = agents.length
    ? `<h2>Agents you can use</h2><table class="agents"><thead><tr><th>Agent</th><th>Does</th><th></th>${
        caller.admin ? "<th>Who can use it</th>" : ""
      }</tr></thead><tbody>${agentRows}</tbody></table>${
        caller.admin
          ? `<script type="module">${CLIENT}
document.querySelectorAll("[data-save-use]").forEach((b) => b.addEventListener("click", async () => {
  const agent = b.dataset.saveUse;
  try { await call("/agents/" + agent + "/access", { method: "PUT", body: JSON.stringify({ use: emails(document.querySelector('[data-use="' + agent + '"]').value) }) }); b.textContent = "Saved"; }
  catch (e) { alert(e.message); }
}));</script>`
          : ""
      }`
    : "";
  const body = visible.length
    ? `<table class="instances"><thead><tr><th>Instance</th><th>Agent</th><th>Status</th><th>Version</th><th>Owner</th></tr></thead><tbody>${visible
        .map(
          (r) =>
            `<tr><td><a href="/i/${esc(r.id)}">${esc(r.id)}</a></td><td>${esc(r.agent)}</td><td>${pill(r.status)}</td><td><code>${esc(r.version)}</code></td><td>${esc(r.owner)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No instances you can see yet.</p>`;
  return page("Agent host", caller, `<h1>Instances</h1>${body}${agentsTable}`);
}

export function newInstancePage(caller: Caller, agent: AgentSummary, saved: string[]): Response {
  const fields = credentialFields([...agent.credentials, ...modelFields(agent.modelCredentials)], saved, false);
  const body = `<h1>${esc(agent.agent)}</h1><p class="muted">${esc(agent.description)} · latest <code>${esc(agent.latest)}</code></p>
<p class="muted">Credentials you leave blank use what you saved on your <a href="/credentials">credentials page</a>.</p>
<div id="creds">${fields}</div>
<fieldset><legend>New instance</legend><p class="muted">Always on, keeps its files and conversations, can be shared.</p>
<div class="bar"><input id="id" placeholder="instance name, e.g. ${esc(agent.agent)}-team" pattern="[a-z][a-z0-9-]{1,40}"><button id="create" class="primary">Create</button><span id="create-status" class="muted"></span></div></fieldset>
<fieldset><legend>One-off run</legend><p class="muted">A fresh container for one task, removed when it finishes.</p>
<textarea id="message" placeholder="What should the agent do?"></textarea>
<div class="bar"><button id="run" class="primary">Run</button><span id="run-status" class="muted"></span></div><div id="run-out" class="result"></div></fieldset>
<script type="module">${CLIENT}
const agent = ${JSON.stringify(agent.agent)};
$("#create").addEventListener("click", async () => {
  try {
    const { instance } = await call("/instances", { method: "POST", body: JSON.stringify({ id: $("#id").value.trim(), agent, credentials: credentialValues($("#creds")).set }) });
    location.href = "/i/" + instance.id;
  } catch (e) { $("#create-status").textContent = e.message; }
});
$("#run").addEventListener("click", async () => {
  $("#run").disabled = true;
  try {
    const { task } = await call("/agents/" + agent + "/run", { method: "POST", body: JSON.stringify({ message: $("#message").value, credentials: credentialValues($("#creds")).set }) });
    await follow(task, $("#run-status"), $("#run-out"));
  } catch (e) { $("#run-status").textContent = e.message; }
  $("#run").disabled = false;
});
</script>`;
  return page(`New ${agent.agent} · Agent host`, caller, body);
}

export interface PersonalCredentials {
  agent: string;
  declared: CredentialField[];
  model: string[];
  saved: string[];
}

export function credentialsPage(caller: Caller, entries: PersonalCredentials[]): Response {
  const forms = entries
    .map(
      (e) =>
        `<fieldset data-agent="${esc(e.agent)}"><legend>${esc(e.agent)}</legend>${credentialFields(
          [...e.declared, ...modelFields(e.model)],
          e.saved,
          true,
        )}<div class="bar"><button class="primary" data-save="${esc(e.agent)}">Save</button><span class="muted" data-status="${esc(e.agent)}"></span></div></fieldset>`,
    )
    .join("");
  const body = `<h1>Your credentials</h1>
<p class="muted">Saved per agent and used when you create an instance or start a one-off run. Values are encrypted and never shown again; existing instances keep the credentials they were created with.</p>
${forms || '<p class="muted">No agents you can use yet.</p>'}
<script type="module">${CLIENT}
document.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", async () => {
  const agent = b.dataset.save;
  const status = document.querySelector('[data-status="' + agent + '"]');
  try {
    await call("/credentials/" + agent, { method: "PUT", body: JSON.stringify(credentialValues(document.querySelector('[data-agent="' + agent + '"]'))) });
    location.reload();
  } catch (e) { status.textContent = e.message; }
}));
</script>`;
  return page("Credentials · Agent host", caller, body);
}

export function instancePage(caller: Caller, row: InstanceRow, sessions: string[]): Response {
  const canMessage = can(caller, row, "message");
  const canAttach = can(caller, row, "attach");
  const canAdmin = can(caller, row, "admin");
  const options = sessions.map((s) => `<option>${esc(s)}</option>`).join("");
  const body = `
<h1>${esc(row.id)} ${pill(row.status)}</h1>
<p class="muted">${esc(row.agent)} · <code>${esc(row.version)}</code> · owner ${esc(row.owner)}${row.last_error ? ` · <span class="error">${esc(row.last_error)}</span>` : ""}</p>
<div class="bar"><label>Session <select id="session">${options}</select></label>
${canAdmin ? `<button id="new-session">New session</button>` : ""}
${canAttach ? `<button id="attach" class="primary">Attach terminal</button>` : ""}</div>
${canAttach ? `<div id="term" hidden></div>` : ""}
${
  canMessage
    ? `<h2>Send a message</h2><textarea id="message" placeholder="Ask the agent to do something"></textarea>
<div class="bar"><button id="send" class="primary">Send</button><span id="send-status" class="muted"></span></div>`
    : ""
}
${
  canAdmin
    ? `<h2>Settings</h2>
<fieldset><legend>Sharing</legend><p class="muted">Emails separated by commas, or * for everyone who can sign in.</p>
<div class="field"><label>Can message</label><input type="text" id="share-message"></div>
<div class="field"><label>Can attach to the terminal</label><input type="text" id="share-attach"></div>
<div class="field"><label>Can administer</label><input type="text" id="share-admin"></div>
<div class="bar"><button id="save-sharing" class="primary">Save sharing</button><span id="sharing-status" class="muted"></span></div></fieldset>
<fieldset><legend>Credentials</legend><p class="muted">The values this instance runs with. Changes apply after a restart.</p>
<div id="instance-creds"></div>
<div class="bar"><button id="save-creds" class="primary">Save credentials</button><button id="restart">Restart now</button><span id="creds-status" class="muted"></span></div></fieldset>`
    : ""
}
<h2>Recent tasks</h2><table class="tasks"><thead><tr><th>When</th><th>From</th><th>Status</th><th>Message / result</th></tr></thead><tbody id="tasks"></tbody></table>
<script type="module">${CLIENT}
const id = ${JSON.stringify(row.id)};
let sharingLoaded = false;
async function refresh() {
  const { tasks, instance } = await call("/instances/" + id);
  if (instance.sharing && !sharingLoaded) {
    sharingLoaded = true;
    $("#share-message").value = instance.sharing.message.join(", ");
    $("#share-attach").value = instance.sharing.attach.join(", ");
    $("#share-admin").value = instance.sharing.admin.join(", ");
  }
  $("#tasks").innerHTML = tasks.map((t) => "<tr><td>" + new Date(t.created_at).toLocaleString() + "</td><td>" + esc(t.caller) + "</td><td><span class='pill " + esc(t.status === "done" ? "running" : t.status === "failed" ? "error" : "") + "'>" + esc(t.status) + "</span></td><td><div class='muted'>" + esc(t.message.slice(0, 300)) + "</div><div class='result'>" + esc(t.result ?? t.error ?? "") + "</div></td></tr>").join("");
}
refresh();
setInterval(refresh, 5000);
$("#send")?.addEventListener("click", async () => {
  const message = $("#message").value.trim();
  if (!message) return;
  $("#send-status").textContent = "Queued…";
  try {
    const { task } = await call("/instances/" + id + "/tasks", { method: "POST", body: JSON.stringify({ message, session: $("#session").value }) });
    $("#message").value = "";
    refresh();
    let t = task;
    while (t.status === "queued" || t.status === "running") {
      $("#send-status").textContent = t.status === "running" ? "Working…" : "Queued…";
      ({ task: t } = await call("/tasks/" + t.id + "?wait=25"));
    }
    $("#send-status").textContent = t.status === "done" ? "Done" : "Failed: " + (t.error ?? "");
    refresh();
  } catch (e) { $("#send-status").textContent = e.message; }
});
async function loadCredentials() {
  const { allowed, declared, set } = await call("/instances/" + id + "/credentials");
  const described = new Map(declared.map((d) => [d.name, d]));
  $("#instance-creds").innerHTML = allowed.map((name) => {
    const d = described.get(name);
    return "<div class='field'><label><code>" + esc(name) + "</code> " + (d?.required ? "<span class='req'>required</span> " : "") + (set.includes(name) ? "<span class='set'>set</span>" : "") + "</label>" + (d ? "<span class='muted'>" + esc(d.description) + "</span>" : "") + "<input type='password' autocomplete='off' data-cred='" + esc(name) + "' placeholder='" + (set.includes(name) ? "leave blank to keep" : "not set") + "'>" + (set.includes(name) && !d?.required ? "<label class='muted'><input type='checkbox' data-clear='" + esc(name) + "'> clear</label>" : "") + "</div>";
  }).join("");
}
if ($("#instance-creds")) loadCredentials().catch((e) => ($("#creds-status").textContent = e.message));
$("#save-sharing")?.addEventListener("click", async () => {
  try {
    await call("/instances/" + id + "/sharing", { method: "PUT", body: JSON.stringify({ message: emails($("#share-message").value), attach: emails($("#share-attach").value), admin: emails($("#share-admin").value) }) });
    $("#sharing-status").textContent = "Saved";
  } catch (e) { $("#sharing-status").textContent = e.message; }
});
$("#save-creds")?.addEventListener("click", async () => {
  try {
    await call("/instances/" + id + "/credentials", { method: "PUT", body: JSON.stringify(credentialValues($("#instance-creds"))) });
    $("#creds-status").textContent = "Saved. Restart to apply.";
    loadCredentials();
  } catch (e) { $("#creds-status").textContent = e.message; }
});
$("#restart")?.addEventListener("click", async () => {
  if (!confirm("Restart this instance? Its state is saved first; running tasks are interrupted.")) return;
  try { await call("/instances/" + id + "/restart", { method: "POST", body: "{}" }); $("#creds-status").textContent = "Restarting…"; }
  catch (e) { $("#creds-status").textContent = e.message; }
});
$("#new-session")?.addEventListener("click", async () => {
  const name = prompt("Session name (starts with a letter; lowercase, digits, dashes)");
  if (!name) return;
  try { await call("/instances/" + id + "/sessions", { method: "POST", body: JSON.stringify({ name }) }); location.reload(); }
  catch (e) { alert(e.message); }
});
$("#attach")?.addEventListener("click", async () => {
  const [{ Terminal }, { FitAddon }] = await Promise.all([import("${XTERM}/+esm"), import("${FIT}/+esm")]);
  const el = $("#term"); el.hidden = false;
  const term = new Terminal({ cursorBlink: true, fontSize: 13, theme: { background: "#0c0a09" } });
  const fit = new FitAddon(); term.loadAddon(fit); term.open(el); fit.fit();
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/i/" + id + "/ws?session=" + encodeURIComponent($("#session").value) + "&cols=" + term.cols + "&rows=" + term.rows);
  ws.binaryType = "arraybuffer";
  const enc = new TextEncoder();
  ws.onmessage = (e) => term.write(new Uint8Array(e.data));
  ws.onclose = () => term.write("\\r\\n[detached]\\r\\n");
  term.onData((d) => ws.readyState === 1 && ws.send(enc.encode(d)));
  term.onResize(({ cols, rows }) => ws.readyState === 1 && ws.send(JSON.stringify({ type: "resize", cols, rows })));
  new ResizeObserver(() => fit.fit()).observe(el);
  $("#attach").disabled = true;
  term.focus();
});
</script>`;
  return page(`${row.id} · Agent host`, caller, body, `<link rel="stylesheet" href="${XTERM}/css/xterm.css">`);
}

export function keysPage(caller: Caller): Response {
  const body = `<h1>API keys</h1>
<p>An API key lets scripts and other agents call the task API at <code>/api/v1</code> as <strong>${esc(caller.email)}</strong>. It is shown once.</p>
<div class="bar"><input id="label" placeholder="Label, e.g. laptop CLI" maxlength="100"><button id="mint" class="primary">Create key</button></div>
<div id="out"></div>
<script type="module">
document.querySelector("#mint").addEventListener("click", async () => {
  const res = await fetch("/ui/v1/keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label: document.querySelector("#label").value || "api key" }) });
  const body = await res.json();
  const out = document.querySelector("#out");
  out.className = "key";
  out.textContent = res.ok ? body.key : body.error;
});
</script>`;
  return page("API keys · Agent host", caller, body);
}
