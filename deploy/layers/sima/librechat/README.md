# LibreChat on Cloudflare (sima)

LibreChat v0.8.8 runs as one Cloudflare Container (`standard-1`) behind a Worker at
https://librechat.calebsima.com. The image is the published `librechat/librechat`
image pinned by digest, plus `librechat.yaml`.

- **Database:** MongoDB Atlas (`MONGO_URI` secret). Cloudflare has no MongoDB, and the
  container disk is wiped on restart, so nothing durable lives in the container.
- **Files:** R2 bucket `librechat-files` through LibreChat's S3 file strategy. The S3
  credentials are derived from the deploy token (key id = token id, secret = SHA-256 of
  the token), so they carry that token's R2 access.
- **Access:** Cloudflare Access apps "LibreChat" (owner-only) and "LibreChat machine
  paths" (bypass for `/health`). LibreChat's own email/password accounts sit behind it;
  the first account registered becomes the LibreChat admin.
- **Off for now:** search (Meilisearch), file search (RAG API), code interpreter, web
  search. The container sleeps after 2 hours without traffic, so scheduled chats only fire
  while it is awake.
- **Config changes:** changing a var or secret restarts the container on the next request.

## Deploy

```bash
npm ci
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…
npx wrangler deploy --secrets-file secrets.json   # first deploy; later deploys need no secrets file
```

`secrets.json` (never committed) holds `MONGO_URI`, `CREDS_KEY` (32-byte hex), `CREDS_IV`
(16-byte hex), `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ANTHROPIC_API_KEY`,
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. Keep `CREDS_KEY`/`CREDS_IV` stable: they
encrypt stored user credentials.

Building the image only pulls and copies, so it needs Docker but no network access during
the build beyond the base image pull.
