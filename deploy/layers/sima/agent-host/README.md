# Agent host (sima)

Runs agents defined by git repos as always-on Claude Code sessions on Cloudflare Containers, at
https://agents.calebsima.com. Requirements: the "Agent Host — Requirements" doc.

```
people (browser, CLI) ─┐
scripts, other agents ─┼─► Worker (Access JWT or API key) ─► Instance Durable Object ─► container
                       │        D1: versions, instances,          always on, tmux sessions running
                       │        tasks, audit, API keys            Claude Code, agentd, hooks
                       └──────────────────────────────────────────► R2: home-directory state, attach recordings
```

## Concepts

- **Agent**: a repo with `agent.yaml` (see `samples/notes`). Fields: `name`, `description`, `base`
  (digest-pinned, Debian-based), `setup` (runs at build), `harness` (`claude`), `instance` (container
  size), `credentials` (declared names; values never live in the repo), `egress` and `deny` (below).
- **Version**: one image built from one commit, recorded in D1 and listed in the host's container
  `images`. Cloudflare only starts declared images, so every build redeploys the host; running
  instances survive that redeploy.
- **Instance**: an always-on container of one version with its own credentials, sharing lists and
  sessions. Its home directory is saved to R2 every five minutes when changed and before restarts,
  and restored on boot, so conversations and files survive restarts and upgrades.
- **Session**: a tmux window running Claude Code. `main` exists from the start; more can be added.

## Guardrails

- **Egress allowlist.** With `egress: [api.example.com, "*.example.org"]` the container starts without
  internet access and every HTTP and HTTPS request goes through the host's `EgressProxy`, which lets
  through the listed hosts (`*.` matches subdomains only; wildcards on shared hosting suffixes such as
  `*.workers.dev` are refused), plus `api.anthropic.com` only for requests carrying the instance's own
  model key or token and limited to reads and `POST /v1/messages` (and `count_tokens`) whose JSON never asks Anthropic to
  fetch other hosts (`mcp_servers`, `web_fetch` tools or `url` sources anywhere in the body),
  answers 403 otherwise and audits `egress.blocked` (once a minute per host, at
  most 30 a minute per instance). HTTPS is intercepted with a CA that
  Cloudflare creates per container; `agent-boot` adds it to the system store and sets
  `NODE_EXTRA_CA_CERTS`. `egress: []` allows only the model API. Leaving `egress` out keeps open
  internet. Other ports and DNS for unlisted names do not work in restricted mode.
- **Command guard.** Claude Code's hooks live in `/etc/claude-code/managed-settings.json`, which the
  agent cannot edit or disable. The `PreToolUse` hook blocks Bash commands matching a small baseline
  (deleting `/` or `~`, `mkfs`, `dd` to a disk, fork bombs) plus the agent's
  `deny: ["regex", {pattern, reason}]` rules (case-insensitive; line continuations joined and runs of spaces collapsed, lines kept apart), tells the model
  why and audits `harness.blocked`. Baseline rules match `rm` and `mkfs` as words anywhere, so a quoted mention such as `echo "rm -rf /"` is blocked too; the check gets five
  seconds and blocks when it cannot finish. It is a speed bump against mistakes, not a sandbox: the agent can
  still write a script that does the same thing.

## Agents calling agents

Inside a container, `agent-list` shows the instances this agent may call and `agent-call <instance>
"<message>"` sends one a task and waits for the reply (`--wait <id>` resumes a long one). The call is
made for the person whose task is in progress in that session (from agentd's
`/var/lib/agent/current/<session>`, written when the message is delivered), or for the instance owner
when there is none; that person shows in the target's header and in the audit.

Every session of a container runs as the same Unix user, so the host cannot prove which person a call
really comes from, and the target's reply can steer the caller. Authorization therefore rests on the
people who can steer either side: a call is allowed only if the named person **and everyone who can
message, attach to or administer the calling instance** (owner and sharing lists; `*` means anyone) may
message the target, **and everyone who can steer the target may message the calling instance**. Calls
can then only connect instances whose steerers could already reach each other directly. A call made
without a current task acts for the owner and is refused while any task is open on the instance, so
loop and depth limits cannot be dodged by leaving the parent out. Agents cannot message private
sessions. Host-admin rights never apply to calls. The host records the parent task and the chain of instances, refuses loops and
chains deeper than four, and allows eight open calls per instance, checked in the statement that
queues the call. The target sees `via agent:<caller instance>` in the header. Sessions named `p-…`
(LibreChat private sessions) only take messages from their person, the instance owner and host admins.

## Builds from GitHub

On the Builds page (admins) or `POST /sources {repo, ref?, subdir?, auto?}`, register an agent repo.
The host builds it at once and, with `auto`, checks the branch head every five minutes and builds new
commits. A build is a run of `.github/workflows/agent-build.yml` in `BUILD_REPO`, dispatched on
`BUILD_WORKFLOW_REF` (GitHub only dispatches workflows present on that ref). The run checks out the
builder from the repository variable `AGENT_BUILDER_REF` when set, otherwise from the workflow's own
commit; callers cannot choose it. A commit counts as built once a version records it; a dispatched
build that produced no version (failed, or dropped by the one-at-a-time build queue) is retried after
30 minutes. Needed: host secret `GITHUB_BUILD_TOKEN` (fine-grained
token: Actions read/write on `BUILD_REPO`, Contents read on agent repos), and repository secrets
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AGENT_REPOS_TOKEN` (Contents read on agent repos)
in `BUILD_REPO`.

## Build an agent

```bash
npm ci
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…
npm run build-agent -- --source samples/notes                      # local path
npm run build-agent -- --source https://github.com/org/repo --subdir agents/x --ref main
```

The builder validates `agent.yaml`, generates the Dockerfile (agent base + Claude Code + runtime),
builds single-platform without provenance attestations (Cloudflare rejects attestation indexes),
pushes, records the version in D1 and redeploys. Set `GITHUB_TOKEN` for private repos and
`BUILD_CA_FILE` when the build machine sits behind a TLS-intercepting proxy; the CA is mounted as a
build secret and never lands in an image layer. The newest five versions per agent, plus any
version an instance runs, stay deployed.

## API

`/api/v1/*` takes `Authorization: Bearer <API key>` (Cloudflare Access bypasses this path; the
Worker checks the key). The browser uses the same handlers under `/ui/v1/*` with its Access session.

| Method              | Path                                               | Who                                                          | Does                                                                                               |
| ------------------- | -------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| GET                 | `/agents`                                          | anyone signed in                                             | Agents you may use, with declared credentials (admins also see each use list)                      |
| PUT                 | `/agents/:agent/access`                            | admins                                                       | `{use: [emails or "*"]}` sets who may use an agent; nobody but admins by default                   |
| POST                | `/agents/:agent/run`                               | agent users                                                  | `{message, credentials?}` one-off run in a fresh container, removed when the task ends (2 h cap)   |
| GET / PUT           | `/credentials`, `/credentials/:agent`              | agent users                                                  | Your saved credentials per agent: `{set: {NAME: value}, clear: [NAME]}`; values never returned     |
| GET / POST          | `/instances`                                       | list: anyone; create: agent users (3 each, admins unlimited) | Create `{id, agent, version?, credentials?, sharing?}`; blank credentials come from your saved set |
| GET                 | `/instances/:id`                                   | view                                                         | Status, runtime, recent tasks                                                                      |
| POST                | `/instances/:id/tasks`                             | message                                                      | `{message, session?, callback_url?}` → task id, runs async                                         |
| GET                 | `/tasks/:id?wait=50`                               | task's caller or instance admin                              | Long-polls until done or failed                                                                    |
| PUT                 | `/instances/:id/sharing`                           | admin                                                        | `{message, attach, admin}` email lists                                                             |
| GET / PUT           | `/instances/:id/credentials`                       | admin                                                        | Names set; `{set, clear}` replaces values, applied on restart                                      |
| POST                | `/instances/:id/sessions`                          | admin                                                        | `{name}` adds a session (8 max)                                                                    |
| GET (WebSocket)     | `/instances/:id/attach?session=main`               | attach                                                       | Joins the live terminal; recorded to R2                                                            |
| POST                | `/instances/:id/restart`, `/instances/:id/upgrade` | admin                                                        | Save state, reboot (on a newer version)                                                            |
| POST                | `/instances/:id/pause`, `/instances/:id/resume`    | admin                                                        | Save state and stop the container (open tasks fail; messages and attach refused) / start it again  |
| DELETE              | `/instances/:id`                                   | owner or host admin                                          | Remove the instance and its saved state (attach recordings and audit stay); the id is not reused   |
| GET                 | `/instances/:id/audit`                             | admin                                                        | Audit trail                                                                                        |
| GET / POST / DELETE | `/keys`, `/keys/:id`                               | anyone signed in                                             | List, mint (shown once) and revoke your API keys                                                   |

Sharing lists on an instance: `message`, `attach`, `admin` (emails, or `*`). Owners and
`ADMIN_EMAILS` have everything. Non-admin owners can only share with people on the agent's use list
(and `*` only when the use list is `*`). Every message reaches the harness with a header naming the caller.

## LibreChat

LibreChat's Worker has a service binding to this Worker's `LibreChatGateway` entrypoint and maps
`http://agents.internal` inside the LibreChat container to it. The custom endpoint "Agent host"
authenticates with a shared key (`LIBRECHAT_GATEWAY_KEY` here, `AGENT_GATEWAY_KEY` in LibreChat, used
as the endpoint's `apiKey`), so nothing else reaching `agents.internal` can call the gateway. Each
instance you can message is a model; `<id>+private` (instance admins) uses a session of your own on
that instance (at most seven people per instance, because sessions are capped at eight including
`main`). LibreChat sends the signed-in user's email in `X-User-Email`, so agent-host trusts
LibreChat's account emails: keep LibreChat registration closed to people you would not let claim an
email address.

## Configuration

Vars in `wrangler.jsonc`: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` (the "Agent host" Access app),
`ADMIN_EMAILS`. Secrets: `CREDENTIALS_KEY` (32 bytes, base64url; encrypts instance credentials),
`DEFAULT_ANTHROPIC_API_KEY` and/or `DEFAULT_CLAUDE_CODE_OAUTH_TOKEN` (default model credentials; an
instance can supply its own), `HOST_ADMIN_TOKEN` (bootstrap admin bearer token; rotate after
minting personal keys). Deploy with `npm run deploy`, which regenerates the image list from D1.

Access apps: "Agent host" (owner-only) and "Agent host machine paths" (bypass for `/api/` and
`/healthz`).

## Not yet built

Drift checks, cost reports, Codex. Accepted risks: agents without an `egress` list have open
internet; secrets typed into messages or returned by another agent persist in task results, session
logs and state; typing in an attached terminal can collide with queued messages; an agent can forge its
own hook events and name another session's person in a call's audit trail (authorization does not
depend on it); restricted agents can still reach the internet indirectly through Anthropic's
server-side web search; the shared-hosting wildcard list is a short fixed list, not the Public Suffix
List.
