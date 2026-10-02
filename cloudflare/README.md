# QM on Cloudflare

Runs QM on [Cloudflare Containers](https://developers.cloudflare.com/containers/) behind a Worker:

```
browser ──▶ Worker (qm) ──▶ Durable Object "main" ──▶ Container (standard-3)
                                                       ├─ portal  :8080  public front door + embedded auth broker
                                                       ├─ web-ui  :8082  chat UI + /admin
                                                       └─ core    :8081  API, scheduler, agent loop
                         Neon Postgres ◀── core ──▶ R2 (snapshots, transfers, sandbox homes)
                                           └─ http://sandbox.qm.internal ──▶ Durable Object per sandbox ──▶ Container
```

- **One container, three processes.** `supervisor.mjs` starts core, web-ui and portal and wires them over
  loopback, deriving each one's environment the way the `qm` CLI does for its Fly and docker targets
  (`cli/src/services.ts`). Each process gets only the secrets it needs. If any process exits, the container
  exits and the Worker restarts it.
- **Always on.** Core runs crons, background work and Slack socket mode, so the container never sleeps for
  inactivity. A cron trigger every 5 minutes restarts it if it stops.
- **Config changes restart it.** When the Worker's vars or secrets change, the next request or cron tick
  stops the container (with a SIGTERM drain) and starts it with the new values.
- **State lives outside the container.** Postgres holds sessions, memory and the queue; R2 (S3 API) holds
  snapshots, transfers and sandbox home snapshots. The container's disk is scratch.
- **Agent computers are Cloudflare Containers too.** Each sandbox is a `QmSandbox` Durable Object (the
  `durable_object` scheduling policy, in public beta) that starts its own container from the shared sandbox
  base image (`fly/Dockerfile`) and runs commands with the platform's `exec`. Core reaches them at
  `http://sandbox.qm.internal`, a hostname the Worker intercepts for the core container only, with a
  generated bearer token. A sandbox stops after `QM_SANDBOX_IDLE_MINUTES` (default 30) without use and its
  disk is wiped, so core snapshots the home to R2 after each turn and restores it on the next start (see
  `docs/sandbox-preservation.md`). Worker deploys do not restart running sandboxes. Sandboxes have open
  outbound networking. Sprites, E2B and Modal still work with `--sandbox`.

## Prerequisites

- A Cloudflare account on Workers Paid (Containers needs it) with a workers.dev subdomain, or a zone for a
  custom domain.
- An API token with **Workers Scripts: Edit**, **Containers: Edit**, **Workers R2 Storage: Edit** and
  **Account Settings: Read**. If it can also create API tokens, the deploy mints an R2 credential scoped to
  QM's bucket; otherwise it derives S3 credentials from this token, which gives the container the token's
  R2 access. To narrow that, create an R2 token scoped to `<name>-data` and set
  `QM_R2_ACCESS_KEY_ID`/`QM_R2_SECRET_ACCESS_KEY`.
- Postgres: a [Neon](https://neon.tech) project's **direct** connection string (not the `-pooler` host).
  QM uses LISTEN/NOTIFY and session advisory locks.
- A model provider key (Anthropic by default).
- Node 22+, npm, and Docker with Buildx (wrangler builds the image locally and pushes it to Cloudflare's
  registry).

## Deploy

```bash
cd cloudflare
npm ci
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…
export QM_DATABASE_URL='postgresql://…'   # direct Neon URL
export QM_ANTHROPIC_API_KEY=…
npm run deploy -- --org <slug> --admin you@example.com
```

The script:

1. resolves the public URL (`https://<name>.<subdomain>.workers.dev`, or `--domain agent.example.com`);
2. mints the signing keys QM needs (`CORE_SIGNING_SECRET`, `PORTAL_SESSION_SECRET`, `AUTH_SIGNING_JWK`, …)
   **once** — they live only as Worker secrets, and re-deploys never rotate them;
3. creates the `<name>-data` R2 bucket and a credential scoped to it;
4. runs `wrangler deploy` with the vars and secrets, which builds and pushes the qm image and the sandbox
   image;
5. waits for `/healthz`, then prints a one-time admin sign-in link (first deploy only).

Re-run it to ship a new image or update operator secrets. Other options: `--name` (Worker name, default
`qm`), `--model-provider anthropic|openai|openrouter`, `--model`, `--sandbox cloudflare|sprites|e2b|modal`,
`--allowed-email-domain`.

`--sandbox` defaults to `cloudflare` on a first deploy. A re-deploy keeps the backend the Worker already
runs (and stops if it cannot read it), because switching moves every scope's default to an empty computer on
the new backend while the old ones keep running; pass `--sandbox` to switch deliberately, and move homes with
the sandbox migration in Admin. Backends other than `cloudflare` need their own credentials, e.g.
`QM_SPRITES_TOKEN`.

The sandbox Durable Object class arrives in migration `v2`, so `wrangler rollback` to a version from before
it is refused.

## Signing in

The first deploy prints a single-use admin link valid for five minutes. To get another one later:

```bash
npm run admin-login            # --email to pick among several admins
```

The portal session key exists only as a Worker secret, so this rotates `PORTAL_SESSION_SECRET` (signing
everyone out), waits for the restart, then signs the link. For day-to-day sign-in, set up one of:

- **Email links:** `QM_AUTH_EMAIL_TRANSPORT=smtp` with `QM_SMTP_HOST`/`QM_SMTP_USERNAME`/`QM_SMTP_PASSWORD`/
  `QM_AUTH_EMAIL_FROM`, or `QM_RESEND_API_KEY` + `QM_AUTH_EMAIL_FROM`.
- **Passwords:** `QM_AUTH_PASSWORD_USERS=<email>:<hash>` with hashes from
  `node plugins/auth/src/hash-password.ts`.

Then re-run `npm run deploy`. Admit more people with `QM_ALLOWED_EMAILS` (comma-separated) or
`--allowed-email-domain`.

## Optional settings

`QM_SANDBOX_INSTANCE` (Cloudflare sandbox size: `lite` or `standard-1`…`standard-4`, default `standard-3`) and
`QM_SANDBOX_IDLE_MINUTES` (idle minutes before a sandbox stops and its disk is wiped, 1–360, default 30) in the
deploy environment become Worker vars; changing them does not restart core.

Any of these in the deploy environment are stored as Worker secrets and passed to the right process:

| Variable                                                      | Effect                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `QM_OPENAI_API_KEY`, `QM_OPENROUTER_API_KEY`                  | extra model providers                                                           |
| `QM_SLACK_BOT_TOKEN`, `QM_SLACK_APP_TOKEN`                    | Slack bot (socket mode); or enter them in Admin → Slack                         |
| `QM_SPRITES_EGRESS_PROXY_URL`                                 | force sandbox egress through an egress proxy (otherwise fail-open)              |
| `QM_E2B_API_KEY`, `QM_MODAL_TOKEN_ID`/`QM_MODAL_TOKEN_SECRET` | other sandbox backends (with `--sandbox`)                                       |
| `QM_GOOGLE_OAUTH_CLIENT_SECRET` etc.                          | connector client secrets (client ids go in `QM_CORE_ENV_JSON`)                  |
| `QM_CORE_ENV_JSON`, `QM_WEB_ENV_JSON`, `QM_PORTAL_ENV_JSON`   | JSON objects of extra env for one process, e.g. `{"SECURITY_SCREEN":"observe"}` |

## Operating

```bash
npx wrangler tail qm                 # live logs from the Worker and container (prefixed [core]/[web-ui]/[portal])
npx wrangler deployments list        # history; roll back with `npx wrangler rollback`
npx wrangler containers list         # container application status
```

Teardown: `npx wrangler delete qm`, `npx wrangler r2 bucket delete qm-data` (after emptying it), delete the
`qm R2 qm-data` API token, and the Neon project.

## Not supported here (yet)

- **Publishing agent-built web apps.** Core's deploy providers are docker, Fly, AWS and Porter; with none
  reachable, core logs that publishing is unavailable and everything else works. Point `DEPLOY_PROVIDER` at
  Fly or AWS through `QM_CORE_ENV_JSON` to enable it.
- **High availability.** It's one container (`max_instances: 1`), like the Fly target's `--ha=false`. A deploy
  that changes the qm image stops it (SIGTERM, then core drains for up to 300 s) before the new one starts, so
  expect a gap of the drain plus a cold start.
- **Sandbox egress control.** Cloudflare sandboxes can reach the internet freely; there is no egress proxy
  yet.
- **Container disk** (16 GB) is ephemeral; nothing durable is kept there.

## Local check

`npx wrangler dev` runs the Worker and container locally with values from `.dev.vars` (same keys as the
container env: `QM_PUBLIC_URL`, `QM_ORG_ID`, `QM_ADMIN_EMAILS`, `DATABASE_URL`, the generated secrets, …).
`QM_PUBLIC_URL` must be https even locally — the portal refuses to start otherwise. `npm test` covers the
supervisor's environment wiring.
