FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS connector-sdk-build
WORKDIR /app
COPY deploy/connector-sdk ./deploy/connector-sdk
RUN npm ci --prefix deploy/connector-sdk --ignore-scripts --no-audit --no-fund \
  && node deploy/connector-sdk/build.mjs

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS web-build
WORKDIR /app
ARG WEB_UI_BASE=/
ENV WEB_UI_BASE=$WEB_UI_BASE
COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./
RUN npm ci
COPY plugins/web-ui/index.html plugins/web-ui/shared.html plugins/web-ui/vite.config.ts plugins/web-ui/tsconfig.json ./
COPY plugins/web-ui/public ./public
COPY plugins/web-ui/src ./src
COPY plugins/chassis/src /chassis/src
COPY docs/images/slack-app-config-token-setup.gif /docs/images/slack-app-config-token-setup.gif
RUN npm run build

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

RUN apk add --no-cache ca-certificates curl git util-linux tini

WORKDIR /srv/qm

COPY package.json package-lock.json ./
COPY .husky/install.mjs .husky/install.mjs
RUN npm ci --omit=dev && npm audit --omit=dev --audit-level=moderate \
  && rm -rf /root/.npm /tmp/node-compile-cache
COPY --from=connector-sdk-build /app/.generated/connector-sdk ./.generated/connector-sdk
COPY src ./src
COPY scripts/migrate-transcript-tape.ts ./scripts/migrate-transcript-tape.ts
COPY scripts/lib/transcript-tape-migration.ts ./scripts/lib/transcript-tape-migration.ts
COPY cli/templates/slack-manifest.json ./cli/templates/slack-manifest.json
COPY skills-seed ./skills-seed
COPY plugins/onboarding ./plugins/onboarding
COPY plugins/chassis ./plugins/chassis
COPY tsconfig.json ./

COPY plugins/web-ui/package.json plugins/web-ui/package-lock.json ./plugins/web-ui/
RUN npm ci --prefix plugins/web-ui --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/web-ui/server ./plugins/web-ui/server
COPY plugins/web-ui/src/app-edit.ts ./plugins/web-ui/src/app-edit.ts
COPY --from=web-build /app/dist-web ./plugins/web-ui/dist-web
COPY plugins/admin/package.json plugins/admin/package-lock.json ./plugins/admin/
RUN npm ci --prefix plugins/admin --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/admin/src ./plugins/admin/src
COPY plugins/admin/ui ./plugins/admin/ui
COPY plugins/admin/public ./plugins/admin/public

COPY plugins/portal/package.json plugins/portal/package-lock.json ./plugins/portal/
RUN npm ci --prefix plugins/portal --omit=dev && rm -rf /root/.npm /tmp/node-compile-cache
COPY plugins/portal/src ./plugins/portal/src
COPY plugins/portal/tsconfig.json ./plugins/portal/
COPY plugins/auth/src ./plugins/auth/src
RUN ln -s /srv/qm/plugins/portal/node_modules /srv/qm/plugins/auth/node_modules

COPY cloudflare/supervisor.mjs ./cloudflare/supervisor.mjs

ENV NODE_ENV=production
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN mkdir -p /data && chown node:node /data
EXPOSE 8080
USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "cloudflare/supervisor.mjs"]
