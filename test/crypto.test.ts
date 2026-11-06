import assert from "node:assert/strict";
import { createHmac, randomBytes, scryptSync } from "node:crypto";
import { test } from "node:test";
import {
  assertCryptoParams,
  decryptBytes,
  deriveKey,
  digestsEqual,
  encryptBytes,
  hmacDigest,
  manifestMac,
  newCryptoParams,
  type CryptoParams,
} from "../src/crypto.ts";
import { GistSyncError } from "../src/types.ts";

const PATH = "auth.json";
const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));
const code = (c: string) => (err: unknown): boolean => err instanceof GistSyncError && err.code === c;

// One shared derivation keeps the suite fast; scrypt at N=2**17 costs ~200 ms.
const params = newCryptoParams();
const key = await deriveKey("correct horse", params);

function tamper(envelope: string, field: "iv" | "tag" | "ct"): string {
  const env = JSON.parse(envelope) as Record<string, string>;
  const raw = Buffer.from(env[field] as string, "base64");
  raw[0] = (raw[0] as number) ^ 0x01;
  env[field] = raw.toString("base64");
  return JSON.stringify(env);
}

test("newCryptoParams uses the documented cost and a fresh 16-byte salt", () => {
  const p = newCryptoParams();
  assert.deepEqual({ ...p, salt: undefined }, { kdf: "scrypt", N: 2 ** 17, r: 8, p: 1, salt: undefined });
  assert.equal(Buffer.from(p.salt, "base64").length, 16);
  assert.notEqual(p.salt, newCryptoParams().salt);
  assert.doesNotThrow(() => assertCryptoParams(p));
});

test("deriveKey is deterministic, 32 bytes, and matches node's scrypt", async () => {
  assert.equal(key.length, 32);
  assert.deepEqual(await deriveKey("correct horse", params), key);
  const expected = scryptSync("correct horse", Buffer.from(params.salt, "base64"), 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 2 ** 29,
  });
  assert.deepEqual(key, new Uint8Array(expected));
});

test("deriveKey depends on passphrase and salt", async () => {
  assert.notDeepEqual(await deriveKey("other", params), key);
  assert.notDeepEqual(await deriveKey("correct horse", newCryptoParams()), key);
});

test("deriveKey normalizes the passphrase so composed and decomposed forms agree", async () => {
  assert.deepEqual(await deriveKey("r\u00e9sum\u00e9", params), await deriveKey("re\u0301sume\u0301", params));
});

test("deriveKey rejects an empty passphrase", async () => {
  await assert.rejects(deriveKey("", params), code("NO_PASSPHRASE"));
});

test("deriveKey rejects hostile or malformed parameters before doing any work", async () => {
  const base = newCryptoParams();
  const hostile: unknown[] = [
    { ...base, N: 2 ** 30 },
    { ...base, N: 2 ** 17 + 1 },
    { ...base, N: 2 ** 16 },
    { ...base, N: 2 ** 14 },
    { ...base, N: 2 ** 19 },
    { ...base, r: 16 },
    { ...base, p: 3 },
    { ...base, N: 2 },
    { ...base, r: 1 },
    { ...base, r: 4096 },
    { ...base, p: 0 },
    { ...base, p: 1000 },
    { ...base, N: 2 ** 20, r: 32 },
    { ...base, kdf: "pbkdf2" },
    { ...base, salt: "" },
    { ...base, salt: "AAAA" },
    { ...base, salt: "not base64!" },
    { ...base, N: "32768" },
    null,
  ];
  for (const p of hostile) {
    await assert.rejects(deriveKey("pw", p as CryptoParams), code("BAD_MANIFEST"), JSON.stringify(p));
  }
});

test("assertCryptoParams accepts the documented range and nothing outside it", () => {
  const base = newCryptoParams();
  for (const ok of [{}, { N: 2 ** 18 }, { p: 2 }]) assert.doesNotThrow(() => assertCryptoParams({ ...base, ...ok }), JSON.stringify(ok));
});

test("encrypt/decrypt round-trips empty, text, binary and 1 MiB payloads", () => {
  const payloads = [new Uint8Array(), utf8("hello"), utf8("héllo 日本語"), new Uint8Array([0, 255, 1, 254]), new Uint8Array(randomBytes(1024 * 1024))];
  for (const p of payloads) assert.deepEqual(decryptBytes(key, encryptBytes(key, p, PATH), PATH), p);
});

test("encryptBytes emits a v1 envelope with a fresh IV each time", () => {
  const a = JSON.parse(encryptBytes(key, utf8("same"), PATH)) as Record<string, unknown>;
  const b = JSON.parse(encryptBytes(key, utf8("same"), PATH)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(a), ["v", "iv", "tag", "ct"]);
  assert.equal(a.v, 1);
  assert.equal(Buffer.from(a.iv as string, "base64").length, 12);
  assert.equal(Buffer.from(a.tag as string, "base64").length, 16);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test("the envelope does not contain the plaintext", () => {
  const env = encryptBytes(key, utf8("super-secret-plaintext"), PATH);
  assert.ok(!env.includes("super-secret-plaintext"));
  assert.ok(!Buffer.from(env).toString("latin1").includes("super-secret-plaintext"));
});

test("a wrong key fails with BAD_PASSPHRASE", async () => {
  const env = encryptBytes(key, utf8("data"), PATH);
  const wrong = await deriveKey("wrong horse", params);
  assert.throws(() => decryptBytes(wrong, env, PATH), code("BAD_PASSPHRASE"));
});

test("tampering with ct, tag or iv fails with BAD_PASSPHRASE", () => {
  const env = encryptBytes(key, utf8("some payload that is long enough"), PATH);
  for (const field of ["ct", "tag", "iv"] as const) {
    assert.throws(() => decryptBytes(key, tamper(env, field), PATH), code("BAD_PASSPHRASE"), field);
  }
});

test("truncated or garbage tag and ct fail as auth errors, not crashes", () => {
  const env = JSON.parse(encryptBytes(key, utf8("payload"), PATH)) as Record<string, unknown>;
  for (const patch of [{ tag: "AAAA" }, { tag: "" }, { ct: "AAAA" }, { ct: "!!!!" }, { ct: "" }]) {
    assert.throws(() => decryptBytes(key, JSON.stringify({ ...env, ...patch }), PATH), code("BAD_PASSPHRASE"), JSON.stringify(patch));
  }
});

test("malformed envelopes fail with BAD_MANIFEST", () => {
  const ok = JSON.parse(encryptBytes(key, utf8("x"), PATH)) as Record<string, unknown>;
  const bad = [
    "",
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...ok, v: 2 }),
    JSON.stringify({ ...ok, v: undefined }),
    JSON.stringify({ ...ok, iv: undefined }),
    JSON.stringify({ ...ok, tag: 5 }),
    JSON.stringify({ ...ok, ct: null }),
    JSON.stringify({ ...ok, iv: "AAAA" }),
    JSON.stringify({ ...ok, iv: "%%%%" }),
  ];
  for (const env of bad) assert.throws(() => decryptBytes(key, env, PATH), code("BAD_MANIFEST"), env);
});

test("errors never contain the passphrase, key or plaintext", async () => {
  const env = encryptBytes(key, utf8("plaintext-marker"), PATH);
  const wrong = await deriveKey("hunter2-passphrase", params);
  try {
    decryptBytes(wrong, env, PATH);
    assert.fail("should throw");
  } catch (err) {
    const text = String((err as Error).message) + String((err as Error).stack);
    assert.ok(!text.includes("hunter2-passphrase"));
    assert.ok(!text.includes("plaintext-marker"));
    assert.ok(!text.includes(Buffer.from(wrong).toString("hex")));
  }
});

test("encrypt/decrypt reject keys that are not 32 bytes", () => {
  assert.throws(() => encryptBytes(new Uint8Array(16), utf8("x"), PATH), TypeError);
  assert.throws(() => decryptBytes(new Uint8Array(16), "{}", PATH), TypeError);
});

test("hmacDigest is keyed, path-bound and separated from the raw key", () => {
  const a = hmacDigest(key, PATH, utf8("data"));
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, hmacDigest(key, PATH, utf8("data")));
  assert.notEqual(a, hmacDigest(new Uint8Array(32), PATH, utf8("data")));
  // Same bytes under another path must not verify, or a writer could re-point an entry.
  assert.notEqual(a, hmacDigest(key, "skills/x/SKILL.md", utf8("data")));
  // HKDF subkeys: a digest is not the HMAC of the master key that also feeds AES.
  assert.notEqual(a, createHmac("sha256", key).update(PATH).update("\0").update("data").digest("hex"));
});

test("ciphertext is bound to its path: decrypting under another path fails", () => {
  const env = encryptBytes(key, utf8("OPENAI_API_KEY=secret"), "auth.json");
  assert.deepEqual(decryptBytes(key, env, "auth.json"), utf8("OPENAI_API_KEY=secret"));
  assert.throws(() => decryptBytes(key, env, "prompts/leak.md"), code("BAD_PASSPHRASE"));
});

test("manifestMac depends on the key, the gist id and the text", () => {
  const a = manifestMac(key, "gist1", "{}");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, manifestMac(key, "gist1", "{}"));
  assert.notEqual(a, manifestMac(key, "gist2", "{}"));
  assert.notEqual(a, manifestMac(key, "gist1", "{ }"));
  assert.notEqual(a, manifestMac(new Uint8Array(32), "gist1", "{}"));
});

test("digestsEqual compares hex digests exactly", () => {
  const d = "ab".repeat(32);
  assert.equal(digestsEqual(d, d), true);
  assert.equal(digestsEqual(d, "ac".repeat(32)), false);
  assert.equal(digestsEqual(d, d.slice(1)), false);
  assert.equal(digestsEqual("", ""), true);
});
