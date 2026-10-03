import assert from "node:assert/strict";
import { test } from "node:test";
import { base64url, constantTimeEqual, verifyAccessJwt } from "../src/auth.ts";
import { modelEnvironment, systemPrompt } from "../src/boot-env.ts";
import { can, parseSharing } from "../src/policy.ts";
import { PartBuffer, putStream } from "../src/r2.ts";
import { openCredentials, sealCredentials } from "../src/secrets.ts";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-tag";

async function signer() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  const sign = async (
    payload: Record<string, unknown>,
    header: Record<string, unknown> = { alg: "RS256", kid: "k1" },
  ) => {
    const enc = (o: unknown) => base64url(new TextEncoder().encode(JSON.stringify(o)));
    const data = `${enc(header)}.${enc(payload)}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(data));
    return `${data}.${base64url(new Uint8Array(sig))}`;
  };
  return { sign, certs: async () => [jwk as JsonWebKey] };
}

test("Access tokens are accepted only with a valid signature, audience, issuer and expiry", async () => {
  const { sign, certs } = await signer();
  const now = Date.parse("2026-10-03T12:00:00Z");
  const exp = now / 1000 + 600;
  const good = { aud: [AUD], iss: `https://${TEAM}`, exp, email: "Caleb@Sima.cx" };
  const opts = { team: TEAM, aud: AUD, now, certs };
  assert.deepEqual(await verifyAccessJwt(await sign(good), opts), { email: "caleb@sima.cx" });
  assert.equal(await verifyAccessJwt(await sign({ ...good, aud: ["other"] }), opts), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good, iss: "https://evil.cloudflareaccess.com" }), opts), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good, exp: now / 1000 - 1 }), opts), null);
  assert.equal(await verifyAccessJwt(await sign({ ...good, email: "" }), opts), null);
  assert.equal(await verifyAccessJwt(await sign(good, { alg: "HS256", kid: "k1" }), opts), null);
  assert.equal(await verifyAccessJwt(await sign(good, { alg: "RS256", kid: "other" }), opts), null);
  const token = await sign(good);
  const tampered = token.replace(
    /\.[^.]+\./,
    `.${base64url(new TextEncoder().encode(JSON.stringify({ ...good, email: "x@y.z" })))}.`,
  );
  assert.equal(await verifyAccessJwt(tampered, opts), null);
  assert.equal(await verifyAccessJwt("not-a-jwt", opts), null);
  assert.equal(await verifyAccessJwt(token, { ...opts, aud: "" }), null);
});

test("constant-time comparison matches only identical strings", () => {
  assert.equal(constantTimeEqual("abc", "abc"), true);
  assert.equal(constantTimeEqual("abc", "abd"), false);
  assert.equal(constantTimeEqual("abc", "abcd"), false);
});

test("permissions: owner and admins have everything, lists grant what they name", () => {
  const row = { owner: "o@x.io", sharing: { message: ["m@x.io"], attach: ["a@x.io"], admin: ["ad@x.io"] } };
  const who = (email: string, admin = false) => ({ email, via: "access" as const, admin });
  assert.equal(can(who("o@x.io"), row, "admin"), true);
  assert.equal(can(who("z@x.io", true), row, "attach"), true);
  assert.equal(can(who("m@x.io"), row, "message"), true);
  assert.equal(can(who("m@x.io"), row, "attach"), false);
  assert.equal(can(who("a@x.io"), row, "attach"), true);
  assert.equal(can(who("a@x.io"), row, "message"), false);
  assert.equal(can(who("a@x.io"), row, "view"), true);
  assert.equal(can(who("ad@x.io"), row, "message"), true);
  assert.equal(can(who("z@x.io"), row, "view"), false);
  assert.equal(
    can(who("z@x.io"), { owner: "o@x.io", sharing: { message: ["*"], attach: [], admin: [] } }, "message"),
    true,
  );
});

test("sharing lists are validated and normalised", () => {
  assert.deepEqual(parseSharing({ message: ["A@B.io", "a@b.io"], attach: ["*"] }), {
    message: ["a@b.io"],
    attach: ["*"],
    admin: [],
  });
  assert.throws(() => parseSharing({ message: "a@b.io" }), /must be a list/);
  assert.throws(() => parseSharing({ admin: ["not an email"] }), /invalid entry/);
});

test("credentials round-trip and are bound to their instance", async () => {
  const key = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const sealed = await sealCredentials(key, { NOTES_TOKEN: "s3cret" }, "notes-main");
  assert.doesNotMatch(sealed, /s3cret/);
  assert.deepEqual(await openCredentials(key, sealed, "notes-main"), { NOTES_TOKEN: "s3cret" });
  await assert.rejects(openCredentials(key, sealed, "other-instance"));
  await assert.rejects(sealCredentials("short", {}, "x"), /32 bytes/);
});

test("model credentials: the instance's own win, then the subscription default, then the API key default", () => {
  const both = { DEFAULT_ANTHROPIC_API_KEY: "api", DEFAULT_CLAUDE_CODE_OAUTH_TOKEN: "oauth" };
  assert.deepEqual(modelEnvironment(both, { ANTHROPIC_API_KEY: "own" }), {});
  assert.deepEqual(modelEnvironment(both, {}), { CLAUDE_CODE_OAUTH_TOKEN: "oauth" });
  assert.deepEqual(modelEnvironment({ DEFAULT_ANTHROPIC_API_KEY: "api" }, {}), { ANTHROPIC_API_KEY: "api" });
  assert.throws(() => modelEnvironment({}, {}), /no model credentials/);
  assert.match(systemPrompt({ id: "notes-main", agent: "notes" }), /instance notes-main/);
});

test("multipart buffering emits equal parts and keeps the remainder", () => {
  const buffer = new PartBuffer(4);
  assert.deepEqual(buffer.push(new Uint8Array([1, 2, 3])), []);
  const parts = buffer.push(new Uint8Array([4, 5, 6, 7, 8, 9]));
  assert.deepEqual(
    parts.map((p) => [...p]),
    [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ],
  );
  assert.deepEqual([...buffer.rest()], [9]);
});

function fakeBucket() {
  const objects = new Map<string, Uint8Array>();
  const calls: string[] = [];
  return {
    objects,
    calls,
    bucket: {
      async put(key: string, value: Uint8Array) {
        calls.push("put");
        objects.set(key, value);
      },
      async createMultipartUpload(key: string) {
        calls.push("create");
        const parts: Uint8Array[] = [];
        return {
          async uploadPart(n: number, data: Uint8Array) {
            parts[n - 1] = data;
            return { partNumber: n, etag: String(n) };
          },
          async complete() {
            const total = parts.reduce((a, p) => a + p.length, 0);
            const out = new Uint8Array(total);
            let o = 0;
            for (const p of parts) {
              out.set(p, o);
              o += p.length;
            }
            objects.set(key, out);
            calls.push("complete");
          },
          async abort() {
            calls.push("abort");
          },
        };
      },
    } as unknown as R2Bucket,
  };
}

const streamOf = (chunks: number[][]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new Uint8Array(chunk));
      c.close();
    },
  });

test("small streams are a single put; large ones a multipart upload in order", async () => {
  const small = fakeBucket();
  assert.equal(await putStream(small.bucket, "k", streamOf([[1, 2]]), 4), 2);
  assert.deepEqual(small.calls, ["put"]);
  const large = fakeBucket();
  assert.equal(
    await putStream(
      large.bucket,
      "k",
      streamOf([
        [1, 2, 3],
        [4, 5, 6, 7, 8, 9],
      ]),
      4,
    ),
    9,
  );
  assert.deepEqual(large.calls, ["create", "complete"]);
  assert.deepEqual([...large.objects.get("k")!], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("a failing stream aborts the multipart upload", async () => {
  const { bucket, calls } = fakeBucket();
  const failing = new ReadableStream<Uint8Array>({
    pull(c) {
      if (!calls.includes("create")) c.enqueue(new Uint8Array(8));
      else c.error(new Error("boom"));
    },
  });
  await assert.rejects(putStream(bucket, "k", failing, 4), /boom/);
  assert.deepEqual(calls, ["create", "abort"]);
});
