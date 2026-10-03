# Agent host (sima)

Runs agents defined by git repos as always-on Claude Code sessions on Cloudflare Containers, at
https://agents.calebsima.com. Requirements: the "Agent Host — Requirements" doc. This is phase 1.

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
  size), `credentials` (declared names; values never live in the repo).
- **Version**: one image built from one commit, recorded in D1 and listed in the host's container
  `images`. Cloudflare only starts declared images, so every build redeploys the host; running
  instances survive that redeploy.
- **Instance**: an always-on container of one version with its own credentials, sharing lists and
  sessions. Its home directory is saved to R2 every five minutes when changed and before restarts,
  and restored on boot, so conversations and files survive restarts and upgrades.
- **Session**: a tmux window running Claude Code. `main` exists from the start; more can be added.

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
that instance. LibreChat sends the signed-in user's email in `X-User-Email`, so agent-host trusts
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

Pause, kill and delete for persistent instances, drift checks, agent-to-agent registry and
delegation, cost reports, Codex. Accepted
risks: full-auto agents with open egress, secrets typed into messages persist in session logs and
state, and typing in an attached terminal can collide with queued messages.
