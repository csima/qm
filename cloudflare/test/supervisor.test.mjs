import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServiceEnvs } from "../supervisor.mjs";

const base = {
  PATH: "/usr/bin",
  QM_PUBLIC_URL: "https://qm.acme.workers.dev/",
  QM_ORG_ID: "acme",
  QM_ADMIN_EMAILS: "Admin@Acme.com",
  QM_MODEL_PROVIDER: "anthropic",
  DATABASE_URL: "postgres://u:p@db/qm",
  ANTHROPIC_API_KEY: "sk-ant-x",
  QM_SANDBOX_API_TOKEN: "sandbox-token",
  S3_BUCKET: "qm-data",
  AWS_ACCESS_KEY_ID: "id",
  AWS_SECRET_ACCESS_KEY: "secret",
  AWS_ENDPOINT_URL_S3: "https://acct.r2.cloudflarestorage.com",
  ...Object.fromEntries(
    [
      "CORE_SIGNING_SECRET",
      "DEPLOYMENT_CONTROL_SECRET",
      "CAPABILITY_SECRET",
      "PORTAL_IDENTITY_SECRET",
      "CONNECTOR_SECRET_KEY",
      "SKILL_SIGNING_SECRET",
      "PORTAL_SESSION_SECRET",
      "AUTH_TOKEN_SECRET",
      "AUTH_CLIENT_SECRET",
      "AUTH_SIGNING_JWK",
    ].map((k) => [k, `${k}-value`]),
  ),
};

test("wires core, web-ui, and portal over loopback", () => {
  const { problems, services } = buildServiceEnvs(base);
  assert.deepEqual(problems, []);
  const { core, web, portal } = services;
  assert.equal(core.PORT, "8081");
  assert.equal(core.PUBLIC_WEB_URL, "https://qm.acme.workers.dev");
  assert.equal(core.PUBLIC_API_URL, "https://qm.acme.workers.dev");
  assert.equal(core.ADMIN_GRANTS, "admin@acme.com:org_admin");
  assert.equal(core.SNAPSHOT_STORE, "s3");
  assert.equal(core.SANDBOX_BACKEND, "cloudflare");
  assert.equal(core.CLOUDFLARE_SANDBOX_URL, "http://sandbox.qm.internal");
  assert.equal(core.CLOUDFLARE_SANDBOX_TOKEN, "sandbox-token");
  assert.equal(core.CLOUDFLARE_SANDBOX_SNAPSHOT_S3_BUCKET, "qm-data");
  assert.equal(web.CORE_API_URL, "http://127.0.0.1:8081");
  assert.equal(portal.PORT, "8080");
  assert.equal(portal.WEB_UI_UPSTREAM, "http://127.0.0.1:8082");
  assert.equal(portal.ADMIN_UPSTREAM, "http://127.0.0.1:8082/admin");
  assert.equal(portal.OIDC_ISSUER, "https://qm.acme.workers.dev/idp");
  assert.equal(portal.OIDC_CLIENT_SECRET, portal.AUTH_CLIENT_SECRET);
  assert.equal(portal.OIDC_ALLOWED_EMAILS, "admin@acme.com");
});

test("keeps each secret with the process that needs it", () => {
  const { core, web, portal } = buildServiceEnvs(base).services;
  for (const svc of [web, portal]) {
    for (const key of [
      "DATABASE_URL",
      "ANTHROPIC_API_KEY",
      "CLOUDFLARE_SANDBOX_TOKEN",
      "QM_SANDBOX_API_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "CONNECTOR_SECRET_KEY",
    ])
      assert.equal(svc[key], undefined, key);
  }
  for (const key of ["PORTAL_SESSION_SECRET", "AUTH_SIGNING_JWK", "AUTH_TOKEN_SECRET"]) {
    assert.equal(core[key], undefined, key);
    assert.equal(web[key], undefined, key);
  }
});

test("reports missing configuration instead of starting half-configured", () => {
  const rest = { ...base };
  delete rest.DATABASE_URL;
  delete rest.QM_SANDBOX_API_TOKEN;
  const { problems } = buildServiceEnvs({ ...rest, QM_CORE_ENV_JSON: "[1]" });
  assert.ok(problems.includes("DATABASE_URL"));
  assert.ok(problems.includes("QM_SANDBOX_API_TOKEN"));
  assert.ok(buildServiceEnvs({ ...base, QM_SANDBOX_BACKEND: "sprites" }).problems.includes("SPRITES_TOKEN"));
  const noBucket = { ...base };
  delete noBucket.S3_BUCKET;
  assert.ok(buildServiceEnvs(noBucket).problems.includes("S3_BUCKET"));
  assert.ok(problems.some((p) => p.startsWith("QM_CORE_ENV_JSON")));
});

test("per-service JSON overrides apply last", () => {
  const { core, portal } = buildServiceEnvs({
    ...base,
    QM_CORE_ENV_JSON: JSON.stringify({ SECURITY_SCREEN: "observe", GOOGLE_OAUTH_CLIENT_ID: "abc" }),
    QM_PORTAL_ENV_JSON: JSON.stringify({ PORTAL_PLAYGROUND: 1 }),
  }).services;
  assert.equal(core.SECURITY_SCREEN, "observe");
  assert.equal(core.GOOGLE_OAUTH_CLIENT_ID, "abc");
  assert.equal(portal.PORTAL_PLAYGROUND, "1");
});

test("other sandbox backends get their own wiring and no Cloudflare sandbox credentials", () => {
  const { problems, services } = buildServiceEnvs({ ...base, QM_SANDBOX_BACKEND: "sprites", SPRITES_TOKEN: "sprites" });
  assert.deepEqual(problems, []);
  assert.equal(services.core.SANDBOX_BACKEND, "sprites");
  assert.equal(services.core.SPRITES_SNAPSHOT_S3_BUCKET, "qm-data");
  assert.equal(services.core.CLOUDFLARE_SANDBOX_TOKEN, undefined);
  assert.equal(services.core.CLOUDFLARE_SANDBOX_SNAPSHOT_S3_BUCKET, undefined);
});
