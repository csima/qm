import type { Caller, Env } from "./env.ts";

const encoder = new TextEncoder();
const CERT_TTL_MS = 60 * 60_000;
let certCache: { team: string; at: number; keys: JsonWebKey[] } | null = null;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newApiKey(): string {
  return `ahk_${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

export function adminEmails(env: Pick<Env, "ADMIN_EMAILS">): Set<string> {
  return new Set(
    (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

type CertFetcher = (team: string) => Promise<JsonWebKey[]>;

async function fetchCerts(team: string): Promise<JsonWebKey[]> {
  if (certCache && certCache.team === team && Date.now() - certCache.at < CERT_TTL_MS) return certCache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs returned ${res.status}`);
  const body = (await res.json()) as { keys: JsonWebKey[] };
  certCache = { team, at: Date.now(), keys: body.keys };
  return body.keys;
}

export async function verifyAccessJwt(
  token: string,
  opts: { team: string; aud: string; now?: number; certs?: CertFetcher },
): Promise<{ email: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3 || !opts.team || !opts.aud) return null;
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string };
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  const keys = await (opts.certs ?? fetchCerts)(opts.team);
  const jwk = keys.find((k) => (k as { kid?: string }).kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ]);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    fromBase64url(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(opts.aud)) return null;
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
  if (payload.iss !== `https://${opts.team}`) return null;
  if (typeof payload.email !== "string" || !payload.email) return null;
  return { email: payload.email.toLowerCase() };
}

export async function callerFromAccess(req: Request, env: Env): Promise<Caller | null> {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  const verified = await verifyAccessJwt(token, { team: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
  if (!verified) return null;
  return { email: verified.email, via: "access", admin: adminEmails(env).has(verified.email) };
}

export async function callerFromBearer(req: Request, env: Env): Promise<Caller | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) return null;
  const token = match[1];
  if (env.HOST_ADMIN_TOKEN && env.HOST_ADMIN_TOKEN.length >= 32 && constantTimeEqual(token, env.HOST_ADMIN_TOKEN))
    return { email: "admin-token", via: "admin_token", admin: true };
  if (!token.startsWith("ahk_")) return null;
  const row = await env.DB.prepare("SELECT owner FROM api_keys WHERE hash = ? AND revoked_at IS NULL")
    .bind(await sha256Hex(token))
    .first<{ owner: string }>();
  if (!row) return null;
  return { email: row.owner, via: "api_key", admin: adminEmails(env).has(row.owner) };
}
