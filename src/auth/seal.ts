/**
 * Authenticated encryption for OAuth artifacts (client ids, codes, tokens).
 * Sealing lets the bridge stay stateless: everything it needs is inside the value
 * the client hands back, and nobody without MCP_TOKEN_SECRET can read or forge it.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type SealPurpose = "client" | "authreq" | "mfa" | "google" | "code" | "access" | "refresh" | "launch" | "letter-launch";

export class Sealer {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = createHash("sha256").update(secret).digest();
  }

  seal(purpose: SealPurpose, payload: object): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    // The purpose is bound as AAD so a refresh token can never be replayed as an access token, etc.
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  /** Returns null for anything tampered, truncated, or sealed for another purpose */
  unseal<T>(purpose: SealPurpose, value: string | undefined | null): T | null {
    if (!value || typeof value !== "string") return null;
    try {
      const raw = Buffer.from(value, "base64url");
      if (raw.length < 29) return null;
      const decipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(raw.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      return JSON.parse(plaintext) as T;
    } catch {
      return null;
    }
  }
}

export const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Reads `exp` from a JWT without verifying it (Spur verifies its own tokens) */
export function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}
