import { createHmac, randomBytes, generateKeyPairSync } from "node:crypto";

export function adminLoginUrl({ publicUrl, secret, email, now = Math.floor(Date.now() / 1000) }) {
  const origin = new URL(publicUrl).origin;
  if (secret.trim().length < 32) throw new Error("PORTAL_SESSION_SECRET must be at least 32 characters");
  const payload = {
    k: "admin-login",
    sub: email.trim().toLowerCase(),
    aud: origin,
    iat: now,
    exp: now + 300,
    jti: randomBytes(18).toString("base64url"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const key = createHmac("sha256", secret).update("portal.admin-login.v1").digest();
  const signature = createHmac("sha256", key).update(body).digest("base64url");
  return `${origin}/auth/admin-login#token=${body}.${signature}`;
}

export const GENERATED_SECRETS = {
  CORE_SIGNING_SECRET: hex,
  DEPLOYMENT_CONTROL_SECRET: hex,
  CAPABILITY_SECRET: hex,
  PORTAL_IDENTITY_SECRET: hex,
  CONNECTOR_SECRET_KEY: hex,
  SKILL_SIGNING_SECRET: hex,
  PORTAL_SESSION_SECRET: hex,
  AUTH_TOKEN_SECRET: hex,
  AUTH_CLIENT_SECRET: hex,
  QM_SANDBOX_API_TOKEN: hex,
  AUTH_SIGNING_JWK: () =>
    JSON.stringify(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" })),
};

function hex() {
  return randomBytes(32).toString("hex");
}

export function nodePostgresUrl(url) {
  const parsed = new URL(url.trim());
  if (parsed.searchParams.get("sslrootcert") === "system") parsed.searchParams.delete("sslrootcert");
  return parsed.toString();
}
