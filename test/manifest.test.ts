import assert from "node:assert/strict";
import { test } from "node:test";
import { newCryptoParams } from "../src/crypto.ts";
import { manifestSigningText, parseManifest, serializeManifest } from "../src/manifest.ts";
import { GistSyncError, MANIFEST_FILE, type Manifest, type ManifestEntry } from "../src/types.ts";

const D = "a".repeat(64);
const entry = (over: Partial<ManifestEntry> = {}): ManifestEntry => ({
  gist: "settings.json",
  digest: D,
  size: 10,
  mode: 0o600,
  enc: "utf8",
  protection: "plain",
  ...over,
});

function manifest(over: Partial<Manifest> = {}): Manifest {
  return {
    schema: 1,
    revision: 3,
    updatedAt: "2026-11-05T00:00:00.000Z",
    host: "laptop",
    tool: "pi-gist-sync@0.1.0",
    files: { "settings.json": entry() },
    ...over,
  };
}

const withCrypto = (): Manifest =>
  manifest({
    files: { "auth.json": entry({ gist: "auth.json", protection: "encrypted", digest: "b".repeat(64) }) },
    crypto: newCryptoParams(),
    mac: "c".repeat(64),
  });

const badManifest = (err: unknown): boolean => err instanceof GistSyncError && err.code === "BAD_MANIFEST";

/** Parses, mutates, and re-stringifies so each test corrupts exactly one field. */
function corrupt(base: Manifest, edit: (raw: Record<string, any>) => void): string {
  const raw = JSON.parse(serializeManifest(base)) as Record<string, any>;
  edit(raw);
  return JSON.stringify(raw);
}

test("serializeManifest is stable: sorted files, 2-space indent, trailing newline", () => {
  const a = manifest({ files: { "b.md": entry({ gist: "b.md" }), "a.md": entry({ gist: "a.md" }), "z/y": entry({ gist: "z%2Fy" }) } });
  const b = manifest({ files: { "z/y": entry({ gist: "z%2Fy" }), "a.md": entry({ gist: "a.md" }), "b.md": entry({ gist: "b.md" }) } });
  const text = serializeManifest(a);
  assert.equal(text, serializeManifest(b));
  assert.ok(text.endsWith("}\n"));
  assert.ok(!text.endsWith("\n\n"));
  assert.ok(text.includes('\n  "files": {\n    "a.md": {\n      "gist": "a.md",'));
  assert.deepEqual(Object.keys(JSON.parse(text).files), ["a.md", "b.md", "z/y"]);
});

test("serializeManifest orders top-level and entry keys deterministically", () => {
  const raw = JSON.parse(serializeManifest(withCrypto())) as Record<string, any>;
  assert.deepEqual(Object.keys(raw), ["schema", "revision", "updatedAt", "host", "tool", "files", "crypto", "mac"]);
  assert.deepEqual(Object.keys(raw.files["auth.json"]), ["gist", "digest", "size", "mode", "enc", "protection"]);
  assert.deepEqual(Object.keys(raw.crypto), ["kdf", "N", "r", "p", "salt"]);
  assert.ok(!("crypto" in JSON.parse(serializeManifest(manifest()))));
});

test("parseManifest(serializeManifest(m)) round-trips", () => {
  for (const m of [manifest(), withCrypto(), manifest({ files: {} })]) {
    assert.deepEqual(parseManifest(serializeManifest(m)), m);
  }
});

test("round-trips an empty-file entry with gist null", () => {
  const m = manifest({ files: { "empty.txt": entry({ gist: null, size: 0 }) } });
  assert.deepEqual(parseManifest(serializeManifest(m)), m);
});

test("round-trips every file mode and both encodings", () => {
  const m = manifest({
    files: {
      a: entry({ mode: 0, gist: "a" }),
      b: entry({ mode: 0o777, gist: "b", enc: "base64" }),
      c: entry({ mode: 0o644, gist: "c" }),
    },
  });
  assert.deepEqual(parseManifest(serializeManifest(m)), m);
});

test("parseManifest ignores unknown extra fields", () => {
  const text = corrupt(manifest(), (r) => {
    r.future = true;
    r.files["settings.json"].extra = 1;
  });
  assert.deepEqual(parseManifest(text), manifest());
});

test("parseManifest rejects non-JSON and non-object roots", () => {
  for (const text of ["", "nope", "null", "[]", "42", '"x"', "{"]) {
    assert.throws(() => parseManifest(text), badManifest, text);
  }
});

test("parseManifest rejects a wrong schema or bad header fields", () => {
  const edits: Array<(r: Record<string, any>) => void> = [
    (r) => (r.schema = 2),
    (r) => delete r.schema,
    (r) => (r.revision = -1),
    (r) => (r.revision = 1.5),
    (r) => (r.revision = "3"),
    (r) => (r.updatedAt = 5),
    (r) => (r.host = null),
    (r) => delete r.tool,
    (r) => (r.files = []),
    (r) => (r.files = null),
    (r) => delete r.files,
  ];
  for (const edit of edits) assert.throws(() => parseManifest(corrupt(manifest(), edit)), badManifest);
});

test("parseManifest rejects path traversal and unsafe paths in files", () => {
  for (const path of ["../x", "a/../../b", "/etc/passwd", "C:\\x", "a\\b", "a/", ".", "", "a//b"]) {
    const text = corrupt(manifest(), (r) => {
      r.files = { [path]: r.files["settings.json"] };
    });
    assert.throws(() => parseManifest(text), badManifest, JSON.stringify(path));
  }
});

test("parseManifest rejects bad entry field types and values", () => {
  const edits: Array<(e: Record<string, any>) => void> = [
    (e) => (e.gist = 5),
    (e) => (e.gist = ""),
    (e) => (e.gist = "a/b"),
    (e) => (e.gist = MANIFEST_FILE),
    (e) => delete e.gist,
    (e) => (e.digest = 5),
    (e) => (e.digest = ""),
    (e) => delete e.digest,
    (e) => (e.size = -1),
    (e) => (e.size = 1.5),
    (e) => (e.size = "10"),
    (e) => (e.gist = null),
    (e) => (e.mode = -1),
    (e) => (e.mode = 0o1000),
    (e) => (e.mode = 0o4755),
    (e) => (e.mode = 1.5),
    (e) => (e.mode = "600"),
    (e) => (e.enc = "latin1"),
    (e) => delete e.enc,
    (e) => (e.protection = "secret"),
    (e) => delete e.protection,
  ];
  for (const edit of edits) {
    const text = corrupt(manifest(), (r) => edit(r.files["settings.json"]));
    assert.throws(() => parseManifest(text), badManifest, String(edit));
  }
  for (const entryValue of [null, 5, "x", []]) {
    const text = corrupt(manifest(), (r) => (r.files["settings.json"] = entryValue));
    assert.throws(() => parseManifest(text), badManifest, JSON.stringify(entryValue));
  }
});

test("an encrypted entry needs crypto parameters, and crypto and mac come as a pair", () => {
  const noCrypto = corrupt(withCrypto(), (r) => {
    delete r.crypto;
    delete r.mac;
  });
  assert.throws(() => parseManifest(noCrypto), badManifest);
  assert.throws(() => parseManifest(corrupt(withCrypto(), (r) => delete r.mac)), badManifest);
  assert.throws(() => parseManifest(corrupt(manifest(), (r) => (r.mac = "c".repeat(64)))), badManifest);
  assert.throws(() => parseManifest(corrupt(manifest(), (r) => (r.crypto = newCryptoParams()))), badManifest);
});

test("a signed manifest may hold no encrypted entries", () => {
  const m = manifest({ crypto: newCryptoParams(), mac: "d".repeat(64) });
  assert.deepEqual(parseManifest(serializeManifest(m)), m);
});

test("parseManifest rejects a malformed mac", () => {
  for (const mac of [5, "", "zz".repeat(32), "C".repeat(64), "c".repeat(63), "c".repeat(65), null]) {
    assert.throws(() => parseManifest(corrupt(withCrypto(), (r) => (r.mac = mac))), badManifest, String(mac));
  }
});

test("manifestSigningText is the canonical text without the mac", () => {
  const m = withCrypto();
  const text = manifestSigningText(m);
  assert.ok(!text.includes('"mac"'));
  assert.equal(text, manifestSigningText({ ...m, mac: "e".repeat(64) }));
  assert.equal(text, serializeManifest({ ...m, mac: undefined }));
});

test("a digest must be 64 lowercase hex characters", () => {
  for (const digest of ["abc", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65)]) {
    const text = corrupt(manifest(), (r) => (r.files["settings.json"].digest = digest));
    assert.throws(() => parseManifest(text), badManifest, digest);
  }
});

test("a gist name must be the path's own encoding, so entries cannot alias each other", () => {
  const alias = corrupt(manifest({ files: { "a.md": entry({ gist: "a.md" }), "b.md": entry({ gist: "a.md" }) } }), () => {});
  assert.throws(() => parseManifest(alias), badManifest);
  const other = corrupt(manifest({ files: { "prompts/leak.md": entry({ gist: "auth.json" }) } }), () => {});
  assert.throws(() => parseManifest(other), badManifest);
  const unencoded = corrupt(manifest({ files: { "z/y": entry({ gist: "z/y".replace("/", "%2f") }) } }), () => {});
  assert.throws(() => parseManifest(unencoded), badManifest);
});

test("more than 300 entries is rejected", () => {
  const files: Record<string, ManifestEntry> = {};
  for (let i = 0; i < 301; i++) files[`f${i}`] = entry({ gist: `f${i}` });
  assert.throws(() => parseManifest(serializeManifest(manifest({ files }))), badManifest);
  delete files.f300;
  assert.doesNotThrow(() => parseManifest(serializeManifest(manifest({ files }))));
});

test("oversized, deep or invisible-character paths are rejected", () => {
  const paths = ["a/".repeat(40) + "x", "x".repeat(300), `${"d/".repeat(10)}${"y".repeat(1100)}`, "a/\u202eb", "a\nb", "a/b\u200d"];
  for (const path of paths) {
    const text = corrupt(manifest(), (r) => {
      r.files = { [path]: { ...r.files["settings.json"], gist: path } };
    });
    assert.throws(() => parseManifest(text), badManifest, JSON.stringify(path.slice(0, 20)));
  }
});

test("parseManifest rejects malformed or hostile crypto parameters", () => {
  const edits: Array<(c: Record<string, any>) => void> = [
    (c) => (c.kdf = "argon2"),
    (c) => (c.N = 2 ** 40),
    (c) => (c.N = 3),
    (c) => (c.N = 2),
    (c) => (c.r = 0),
    (c) => (c.p = 0),
    (c) => (c.salt = "short"),
    (c) => (c.salt = 5),
    (c) => delete c.salt,
  ];
  for (const edit of edits) {
    const text = corrupt(withCrypto(), (r) => edit(r.crypto));
    assert.throws(() => parseManifest(text), badManifest, String(edit));
  }
  for (const value of [null, 5, "x"]) {
    assert.throws(() => parseManifest(corrupt(withCrypto(), (r) => (r.crypto = value))), badManifest);
  }
});

test("a file named __proto__ stays an own key and does not change the prototype", () => {
  const text = '{"schema":1,"revision":0,"updatedAt":"t","host":"h","tool":"x","files":{"__proto__":' +
    JSON.stringify(entry({ gist: "__proto__" })) + "}}";
  const m = parseManifest(text);
  assert.equal(Object.getPrototypeOf(m.files), Object.prototype);
  assert.deepEqual(Object.keys(m.files), ["__proto__"]);
  assert.deepEqual(Object.keys(JSON.parse(serializeManifest(m)).files), ["__proto__"]);
});

test("GistSyncError messages stay short for hostile paths", () => {
  const long = "../" + "x".repeat(5000);
  try {
    parseManifest(corrupt(manifest(), (r) => (r.files = { [long]: r.files["settings.json"] })));
    assert.fail("should throw");
  } catch (err) {
    assert.ok((err as Error).message.length < 300);
  }
});
