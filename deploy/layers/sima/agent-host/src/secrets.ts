import { base64url, fromBase64url } from "./auth.ts";

async function key(material: string): Promise<CryptoKey> {
  let raw: Uint8Array | null = null;
  try {
    raw = fromBase64url(material.trim());
  } catch {
    raw = null;
  }
  if (raw?.length !== 32) throw new Error("CREDENTIALS_KEY must be 32 bytes, base64url encoded");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealCredentials(material: string, values: Record<string, string>, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    await key(material),
    new TextEncoder().encode(JSON.stringify(values)),
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(data))}`;
}

export async function openCredentials(material: string, sealed: string, aad: string): Promise<Record<string, string>> {
  const [iv, data] = sealed.split(".");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64url(iv), additionalData: new TextEncoder().encode(aad) },
    await key(material),
    fromBase64url(data),
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>;
}
