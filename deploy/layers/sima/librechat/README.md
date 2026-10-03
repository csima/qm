# LibreChat on Cloudflare (sima)

LibreChat v0.8.8 runs behind a Worker at https://librechat.calebsima.com as three
Cloudflare Containers, each a published image pinned by digest:

| Container   | Image                                        | Size       | Reached by                           |
| ----------- | -------------------------------------------- | ---------- | ------------------------------------ |
| `LibreChat` | `librechat/librechat` + `librechat.yaml`     | standard-1 | the Worker (public)                  |
| `Meili`     | `getmeili/meilisearch`                       | basic      | LibreChat at `http://meili.internal` |
| `RagApi`    | LibreChat RAG API (lite) + `rag-prestart.py` | standard-1 | LibreChat at `http://rag.internal`   |

The `.internal` hostnames are outbound intercepts on the calling container's class, so only
that container can reach them. Each container receives only the settings it needs; the RAG
database password (`RAGSVC_*`) never reaches LibreChat.

- **Database:** MongoDB Atlas (`MONGO_URI` secret). Cloudflare has no MongoDB, and the
  container disk is wiped on restart, so nothing durable lives in the container.
- **Files:** R2 bucket `librechat-files` through LibreChat's S3 file strategy. The S3
  credentials are derived from the deploy token (key id = token id, secret = SHA-256 of
  the token), so they carry that token's R2 access.
- **Access:** Cloudflare Access apps "LibreChat" (owner-only) and "LibreChat machine
  paths" (bypass for `/health`). LibreChat's own email/password accounts sit behind it;
  the first account registered becomes the LibreChat admin.
- **Conversation search:** Meilisearch with an ephemeral index. LibreChat rebuilds it from
  MongoDB when LibreChat starts against an empty index, and Meilisearch idles out after
  LibreChat does, so the index is normally rebuilt on LibreChat's next start. If Meilisearch
  alone restarts, search can be incomplete until LibreChat restarts.
- **File search (RAG):** vectors in pgvector, in the `librechat_rag` schema of the
  PlanetScale Postgres database qm uses; `rag-prestart.py` creates the extension and schema
  on start. Embeddings come from Workers AI (`@cf/baai/bge-m3`): the RAG API calls
  `http://embeddings.internal/v1/embeddings`, which the Worker serves through its `AI`
  binding in OpenAI's response format, so no API key enters a container.
- **Off for now:** code interpreter and web search (web search needs search, scraper and
  reranker API keys). LibreChat sleeps after 2 hours without traffic, so scheduled chats
  only fire while it is awake.
- **Config changes:** changing a var or secret restarts the container on the next request.

## Deploy

```bash
npm ci
export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…
npx wrangler deploy --secrets-file secrets.json   # first deploy; later deploys need no secrets file
```

`secrets.json` (never committed) holds `MONGO_URI`, `CREDS_KEY` (32-byte hex), `CREDS_IV`
(16-byte hex), `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ANTHROPIC_API_KEY`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `MEILI_MASTER_KEY` and `RAGSVC_DB_PASSWORD`. Keep `CREDS_KEY`/`CREDS_IV` stable: they
encrypt stored user credentials.

Building the images only pulls and copies files, so it needs Docker but runs no commands
inside the build.
