import type { Caller, InstanceRow } from "./env.ts";
import { can } from "./policy.ts";

const XTERM = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0";
const FIT = "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0";

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
button{cursor:pointer}button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
textarea{width:100%;min-height:72px;resize:vertical}
#term{height:min(60vh,560px);background:var(--term);border-radius:8px;padding:6px;overflow:hidden}
.muted{color:var(--quiet);font-size:13px}.result{white-space:pre-wrap;font-size:14px}
.key{padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);word-break:break-all}
@media (max-width:640px){th:nth-child(n+4),td:nth-child(n+4){display:none}}
`;

export function page(title: string, caller: Caller, body: string, head = ""): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style>${head}</head><body>
<header><a href="/">Agent host</a><nav><a href="/keys">API keys</a><span>${esc(caller.email)}</span></nav></header>
<main>${body}</main></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function unauthorizedPage(): Response {
  return new Response(
    "<!doctype html><title>Sign in</title><p>Sign in through Cloudflare Access to use the agent host.</p>",
    { status: 401, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const pill = (status: string) => `<span class="pill ${esc(status)}">${esc(status)}</span>`;

export function homePage(caller: Caller, rows: InstanceRow[]): Response {
  const visible = rows.filter((r) => can(caller, r, "view"));
  const body = visible.length
    ? `<table><thead><tr><th>Instance</th><th>Agent</th><th>Status</th><th>Version</th><th>Owner</th></tr></thead><tbody>${visible
        .map(
          (r) =>
            `<tr><td><a href="/i/${esc(r.id)}">${esc(r.id)}</a></td><td>${esc(r.agent)}</td><td>${pill(r.status)}</td><td><code>${esc(r.version)}</code></td><td>${esc(r.owner)}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : `<p class="muted">No instances you can see yet.</p>`;
  return page("Agent host", caller, `<h1>Instances</h1>${body}`);
}

export function instancePage(caller: Caller, row: InstanceRow, sessions: string[]): Response {
  const canMessage = can(caller, row, "message");
  const canAttach = can(caller, row, "attach");
  const options = sessions.map((s) => `<option>${esc(s)}</option>`).join("");
  const body = `
<h1>${esc(row.id)} ${pill(row.status)}</h1>
<p class="muted">${esc(row.agent)} · <code>${esc(row.version)}</code> · owner ${esc(row.owner)}${row.last_error ? ` · <span class="error">${esc(row.last_error)}</span>` : ""}</p>
<div class="bar"><label>Session <select id="session">${options}</select></label>
${canMessage ? `<button id="new-session">New session</button>` : ""}
${canAttach ? `<button id="attach" class="primary">Attach terminal</button>` : ""}</div>
${canAttach ? `<div id="term" hidden></div>` : ""}
${
  canMessage
    ? `<h2>Send a message</h2><textarea id="message" placeholder="Ask the agent to do something"></textarea>
<div class="bar"><button id="send" class="primary">Send</button><span id="send-status" class="muted"></span></div>`
    : ""
}
<h2>Recent tasks</h2><table><thead><tr><th>When</th><th>From</th><th>Status</th><th>Message / result</th></tr></thead><tbody id="tasks"></tbody></table>
<script type="module">
const id = ${JSON.stringify(row.id)};
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
async function call(path, init) {
  const res = await fetch("/ui/v1" + path, { ...init, headers: { "content-type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}
async function refresh() {
  const { tasks } = await call("/instances/" + id);
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
$("#new-session")?.addEventListener("click", async () => {
  const name = prompt("Session name (lowercase, digits, dashes)");
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
