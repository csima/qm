import { decodeJwt, type JWTPayload } from "jose";

export function jwtClaims(value: unknown): JWTPayload | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return decodeJwt(value);
  } catch {
    return undefined;
  }
}
