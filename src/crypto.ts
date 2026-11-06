import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { parseBase64 } from "./codec.ts";
import { GistSyncError } from "./types.ts";

export interface CryptoParams {
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  /** base64 */
  salt: string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
// The floor equals the default, so a rewritten manifest cannot downgrade the KDF. The tight ceilings keep a
// hostile one from costing seconds or hundreds of MiB per derive (every startup check would pay it).
const MIN_N = 2 ** 17;
const MAX_N = 2 ** 18;
const FIXED_R = 8;
const MAX_P = 2;
const MAX_SCRYPT_BYTES = 2 ** 28;

export function newCryptoParams(): CryptoParams {
  return { kdf: "scrypt", N: MIN_N, r: FIXED_R, p: 1, salt: randomBytes(16).toString("base64") };
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** Manifest params come from the network, so they are checked before any KDF work. */
export function assertCryptoParams(value: unknown): asserts value is CryptoParams {
  const bad = (why: string): never => {
    throw new GistSyncError("BAD_MANIFEST", `Invalid encryption parameters: ${why}`);
  };
  if (typeof value !== "object" || value === null) return bad("not an object");
  const v = value as Record<string, unknown>;
  if (v.kdf !== "scrypt") bad("unsupported kdf");
  if (!isInt(v.N, MIN_N, MAX_N) || (v.N & (v.N - 1)) !== 0) bad("N out of range");
  if (!isInt(v.r, FIXED_R, FIXED_R)) bad("r out of range");
  if (!isInt(v.p, 1, MAX_P)) bad("p out of range");
  if (128 * (v.N as number) * (v.r as number) > MAX_SCRYPT_BYTES) bad("memory cost too high");
  const salt = typeof v.salt === "string" ? parseBase64(v.salt) : undefined;
  if (!salt || salt.length < 16 || salt.length > 64) bad("salt must be 16 to 64 bytes of base64");
}

export function deriveKey(passphrase: string, params: CryptoParams): Promise<Uint8Array> {
  try {
    assertCryptoParams(params);
  } catch (err) {
    return Promise.reject(err);
  }
  if (passphrase === "") {
    return Promise.reject(new GistSyncError("NO_PASSPHRASE", "The passphrase is empty."));
  }
  const salt = Buffer.from(params.salt, "base64");
  // NFKC so the same typed passphrase derives the same key on every OS keyboard layout.
  const secret = passphrase.normalize("NFKC");
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, KEY_BYTES, { N: params.N, r: params.r, p: params.p, maxmem: MAX_SCRYPT_BYTES * 2 }, (err, key) => {
      if (err) reject(new GistSyncError("BAD_MANIFEST", "Key derivation failed", { cause: err }));
      else resolve(new Uint8Array(key));
    });
  });
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new TypeError(`key must be ${KEY_BYTES} bytes`);
}

// One scrypt output feeds AES-GCM and HMAC, so each gets its own HKDF subkey.
function subKey(key: Uint8Array, purpose: "enc" | "mac"): Buffer {
  assertKey(key);
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `pi-gist-sync ${purpose} v1`, KEY_BYTES));
}

// Binding the path stops a writer from pointing one entry's ciphertext or digest at another path.
function aadFor(path: string): Buffer {
  return Buffer.from(`pi-gist-sync:v1\0${path}`, "utf8");
}

export function encryptBytes(key: Uint8Array, bytes: Uint8Array, path: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", subKey(key, "enc"), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadFor(path));
  const ct = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  });
}

function malformed(why: string): never {
  throw new GistSyncError("BAD_MANIFEST", `Malformed encrypted file: ${why}`);
}

function authFailed(cause?: unknown): never {
  throw new GistSyncError("BAD_PASSPHRASE", "Decryption failed: wrong passphrase, or the encrypted data was modified.", { cause });
}

export function decryptBytes(key: Uint8Array, envelope: string, path: string): Uint8Array {
  const encKey = subKey(key, "enc");
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope);
  } catch {
    return malformed("not JSON");
  }
  if (typeof parsed !== "object" || parsed === null) return malformed("not an object");
  const env = parsed as Record<string, unknown>;
  if (env.v !== 1) malformed("unsupported version");
  if (typeof env.iv !== "string" || typeof env.tag !== "string" || typeof env.ct !== "string") malformed("missing field");
  const iv = parseBase64(env.iv as string);
  if (!iv || iv.length !== IV_BYTES) malformed("bad iv");
  // Content problems in tag or ct are indistinguishable from tampering, so they fail as auth errors.
  const tag = Buffer.from(env.tag as string, "base64");
  if (tag.length !== TAG_BYTES) authFailed();
  try {
    const decipher = createDecipheriv("aes-256-gcm", encKey, iv as Uint8Array, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadFor(path));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(Buffer.from(env.ct as string, "base64")), decipher.final()]);
    return new Uint8Array(pt);
  } catch (err) {
    return authFailed(err);
  }
}

/** HMAC-SHA256 hex over `path NUL bytes`, so a digest is only valid for its own path. */
export function hmacDigest(key: Uint8Array, path: string, bytes: Uint8Array): string {
  return createHmac("sha256", subKey(key, "mac")).update(path).update("\0").update(bytes).digest("hex");
}

/** HMAC over the canonical manifest text, bound to the gist it belongs to. */
export function manifestMac(key: Uint8Array, gistId: string, canonicalText: string): string {
  return createHmac("sha256", subKey(key, "mac")).update(`pi-gist-sync:manifest:v1\0${gistId}\0`).update(canonicalText).digest("hex");
}

/** Constant-time compare of two hex digests. */
export function digestsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
