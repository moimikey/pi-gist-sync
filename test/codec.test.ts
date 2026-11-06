import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertSafeRelPath,
  decodePath,
  encodePath,
  fromGistContent,
  isSafeRelPath,
  relPathProblem,
  sha256Hex,
  toGistContent,
} from "../src/codec.ts";
import { GistSyncError, MANIFEST_FILE } from "../src/types.ts";

const bytes = (...n: number[]): Uint8Array => new Uint8Array(n);
const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

function isBadManifest(err: unknown): boolean {
  return err instanceof GistSyncError && err.code === "BAD_MANIFEST";
}

test("encodePath escapes % and / only", () => {
  assert.equal(encodePath("extensions/foo/index.ts"), "extensions%2Ffoo%2Findex.ts");
  assert.equal(encodePath("100%"), "100%25");
  assert.equal(encodePath("a%2Fb"), "a%252Fb");
  assert.equal(encodePath("settings.json"), "settings.json");
  assert.equal(encodePath(".hidden:odd?name\\x"), ".hidden:odd?name\\x");
});

test("encode/decode round-trips awkward names", () => {
  const names = [
    "%",
    "%2F",
    "%25",
    "%5F",
    "a/b/c",
    "dir/%2F/file",
    "héllo/日本語/🙂.md",
    ".env",
    "_pi-gist-sync.json",
    "_pi-gist-sync.json.bak",
    "_pi-gist-sync/x",
    "%5Fpi-gist-sync.json",
    "x".repeat(300),
  ];
  for (const name of names) assert.equal(decodePath(encodePath(name)), name, name);
});

test("encode/decode round-trips a random sweep and never emits a slash", () => {
  const alphabet = ["%", "/", "2", "F", "5", "_", "a", ".", "é"];
  let seed = 12345;
  const rand = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let i = 0; i < 2000; i++) {
    let s = "";
    for (let j = rand(10); j > 0; j--) s += alphabet[rand(alphabet.length)];
    const enc = encodePath(s);
    assert.ok(!enc.includes("/"), s);
    assert.equal(decodePath(enc), s, s);
  }
});

test("no user path can encode to the manifest file name", () => {
  const enc = encodePath(MANIFEST_FILE);
  assert.notEqual(enc, MANIFEST_FILE);
  assert.equal(enc, "%5Fpi-gist-sync.json");
  assert.equal(decodePath(enc), MANIFEST_FILE);
  // A path that already looks like the escaped form must not collide with the escaped manifest name.
  assert.notEqual(encodePath("%5Fpi-gist-sync.json"), enc);
});

test("decodePath leaves unknown escapes alone", () => {
  assert.equal(decodePath("a%41b"), "a%41b");
  assert.equal(decodePath("%"), "%");
});

test("assertSafeRelPath rejects traversal and non-relative paths", () => {
  const bad = [
    "../x",
    "a/../../b",
    "a/..",
    "..",
    ".",
    "a/./b",
    "/etc/passwd",
    "C:\\x",
    "C:/x",
    "c:x",
    "a\\b",
    "",
    "a/",
    "a//b",
    "a\u0000b",
  ];
  for (const p of bad) {
    assert.throws(() => assertSafeRelPath(p), isBadManifest, JSON.stringify(p));
  }
});

test("assertSafeRelPath accepts ordinary relative paths", () => {
  for (const p of ["settings.json", "extensions/a/index.ts", ".env", "a/..b/c", "a/b...c", "héllo/🙂", "a/console.md", "x".repeat(255)]) {
    assert.doesNotThrow(() => assertSafeRelPath(p), p);
  }
});

test("assertSafeRelPath rejects stream syntax, Windows device names and trailing dots or spaces", () => {
  for (const p of ["extensions/x.ts:stream", "a/c:b", "extensions/CON", "a/nul.txt", "a/COM1", "lpt9.md", "a/b.", "a/b ", "a/b./c"]) {
    assert.throws(() => assertSafeRelPath(p), isBadManifest, p);
  }
});

test("assertSafeRelPath rejects control, bidi, zero-width and tag characters", () => {
  for (const p of ["a\nb", "a\u001bb", "a\u202eb", "a\u200bb", "a\u2066b", "a\u{e0041}b", "a\u2028b", "a\u0085b", "a\u007fb"]) {
    assert.throws(() => assertSafeRelPath(p), isBadManifest, JSON.stringify(p));
  }
});

test("assertSafeRelPath caps path bytes, segment bytes and depth", () => {
  assert.throws(() => assertSafeRelPath("x".repeat(256)), isBadManifest);
  assert.throws(() => assertSafeRelPath("é".repeat(128)), isBadManifest, "segment is measured in bytes");
  assert.throws(() => assertSafeRelPath(Array.from({ length: 5 }, () => "y".repeat(250)).join("/")), isBadManifest);
  assert.doesNotThrow(() => assertSafeRelPath(Array.from({ length: 32 }, () => "d").join("/")));
  assert.throws(() => assertSafeRelPath(Array.from({ length: 33 }, () => "d").join("/")), isBadManifest);
});

test("a very long hostile path is rejected quickly", () => {
  const started = Date.now();
  assert.throws(() => assertSafeRelPath("a/".repeat(500_000) + "a"), isBadManifest);
  assert.ok(Date.now() - started < 500);
});

test("isSafeRelPath mirrors assertSafeRelPath without throwing", () => {
  assert.equal(isSafeRelPath("skills/a/SKILL.md"), true);
  assert.equal(isSafeRelPath("../x"), false);
  assert.equal(relPathProblem("a/./b"), "dot segment");
  assert.equal(relPathProblem("ok/file"), undefined);
});

test("assertSafeRelPath rejects non-strings without throwing a TypeError", () => {
  assert.throws(() => assertSafeRelPath(undefined as unknown as string), isBadManifest);
});

test("sha256Hex matches known vectors", () => {
  assert.equal(sha256Hex(new Uint8Array()), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex(utf8("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("toGistContent returns null for empty input", () => {
  assert.equal(toGistContent(new Uint8Array()), null);
});

test("toGistContent keeps valid text as utf8", () => {
  assert.deepEqual(toGistContent(utf8("hello\n")), { content: "hello\n", enc: "utf8" });
  assert.deepEqual(toGistContent(utf8("héllo 日本語 🙂")), { content: "héllo 日本語 🙂", enc: "utf8" });
});

test("toGistContent stores whitespace-only files as base64", () => {
  for (const ws of [" ", "\n", "\r\n\t ", "\u00a0", "\ufeff", "\u2003", "\u0085"]) {
    const out = toGistContent(utf8(ws));
    assert.equal(out?.enc, "base64", JSON.stringify(ws));
    assert.deepEqual(fromGistContent(out!.content, out!.enc), utf8(ws));
  }
});

test("toGistContent stores NUL-containing and non-UTF-8 bytes as base64", () => {
  for (const b of [bytes(0), bytes(0x61, 0, 0x62), bytes(0xff, 0xfe), bytes(0xc3, 0x28), bytes(0xed, 0xa0, 0x80)]) {
    const out = toGistContent(b);
    assert.equal(out?.enc, "base64");
    assert.deepEqual(fromGistContent(out!.content, out!.enc), b);
  }
});

test("a leading BOM survives the utf8 round trip", () => {
  const b = utf8("\ufeffhello");
  const out = toGistContent(b);
  assert.equal(out?.enc, "utf8");
  assert.deepEqual(fromGistContent(out!.content, out!.enc), b);
});

test("random byte buffers round-trip through toGistContent/fromGistContent", () => {
  let seed = 7;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed & 0xff;
  };
  for (let i = 1; i < 200; i++) {
    const b = new Uint8Array(i);
    for (let j = 0; j < i; j++) b[j] = rand();
    const out = toGistContent(b);
    assert.ok(out);
    assert.deepEqual(fromGistContent(out.content, out.enc), b);
  }
});

test("fromGistContent returns a plain Uint8Array, not a pooled Buffer", () => {
  const out = fromGistContent("abc", "utf8");
  assert.equal(Object.getPrototypeOf(out), Uint8Array.prototype);
  assert.equal(Object.getPrototypeOf(fromGistContent("YWJj", "base64")), Uint8Array.prototype);
});

test("fromGistContent rejects bad base64 and unknown encodings", () => {
  for (const s of ["!!!!", "YWJj\n", "YWJ", "YW=j", "YWJj===="]) {
    assert.throws(() => fromGistContent(s, "base64"), isBadManifest, s);
  }
  assert.throws(() => fromGistContent("abc", "rot13" as never), isBadManifest);
});
