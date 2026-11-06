import { assertSafeRelPath, encodePath } from "./codec.ts";
import { assertCryptoParams } from "./crypto.ts";
import { GistSyncError, MANIFEST_FILE, type Manifest, type ManifestEntry } from "./types.ts";

function bad(why: string): never {
  throw new GistSyncError("BAD_MANIFEST", `Invalid manifest: ${why}`);
}

// defineProperty so a file literally named `__proto__` stays an own key instead of swapping the prototype.
function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

// A gist holds at most 300 files, so a longer manifest is hostile or corrupt.
const MAX_ENTRIES = 300;
const HEX_DIGEST = /^[0-9a-f]{64}$/;

function entryToJson(e: ManifestEntry): ManifestEntry {
  return { gist: e.gist, digest: e.digest, size: e.size, mode: e.mode, enc: e.enc, protection: e.protection };
}

/** Stable output: fixed key order and sorted `files`, so identical state gives identical text. */
export function serializeManifest(m: Manifest): string {
  const files: Record<string, ManifestEntry> = {};
  for (const path of Object.keys(m.files).sort()) {
    setOwn(files, path, entryToJson(m.files[path] as ManifestEntry));
  }
  const out: Record<string, unknown> = {
    schema: m.schema,
    revision: m.revision,
    updatedAt: m.updatedAt,
    host: m.host,
    tool: m.tool,
    files,
  };
  if (m.crypto) {
    out.crypto = { kdf: m.crypto.kdf, N: m.crypto.N, r: m.crypto.r, p: m.crypto.p, salt: m.crypto.salt };
  }
  if (m.mac !== undefined) out.mac = m.mac;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The text the manifest MAC covers: the canonical form without the `mac` field itself. */
export function manifestSigningText(m: Manifest): string {
  const { mac: _mac, ...rest } = m;
  return serializeManifest(rest);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function parseEntry(path: string, raw: unknown): ManifestEntry {
  if (!isRecord(raw)) bad(`entry for ${JSON.stringify(path)} is not an object`);
  const e = raw as Record<string, unknown>;
  const where = `entry for ${JSON.stringify(path)}`;
  const { gist, digest, size, mode, enc, protection } = e;
  // The gist name must be the path's own encoding, so entries cannot alias each other's gist files.
  if (gist !== null && (typeof gist !== "string" || gist === MANIFEST_FILE || gist !== encodePath(path))) {
    bad(`${where} has a bad gist file name`);
  }
  if (typeof digest !== "string" || !HEX_DIGEST.test(digest)) bad(`${where} has a bad digest`);
  if (!isCount(size)) bad(`${where} has a bad size`);
  if (gist === null && size !== 0) bad(`${where} has no gist file but a non-zero size`);
  if (!isCount(mode) || mode > 0o777) bad(`${where} has a bad mode`);
  if (enc !== "utf8" && enc !== "base64") bad(`${where} has a bad encoding`);
  if (protection !== "plain" && protection !== "encrypted") bad(`${where} has a bad protection`);
  return { gist, digest, size, mode, enc, protection } as ManifestEntry;
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("not JSON");
  }
  if (!isRecord(raw)) return bad("not an object");
  if (raw.schema !== 1) bad("unsupported schema");
  if (!isCount(raw.revision)) bad("bad revision");
  if (typeof raw.updatedAt !== "string" || typeof raw.host !== "string" || typeof raw.tool !== "string") {
    bad("bad updatedAt, host or tool");
  }
  if (!isRecord(raw.files)) return bad("files is not an object");
  if (Object.keys(raw.files).length > MAX_ENTRIES) bad(`more than ${MAX_ENTRIES} files`);

  const files: Record<string, ManifestEntry> = {};
  let anyEncrypted = false;
  for (const [path, entry] of Object.entries(raw.files)) {
    assertSafeRelPath(path);
    const parsed = parseEntry(path, entry);
    if (parsed.protection === "encrypted") anyEncrypted = true;
    setOwn(files, path, parsed);
  }

  const manifest: Manifest = {
    schema: 1,
    revision: raw.revision as number,
    updatedAt: raw.updatedAt as string,
    host: raw.host as string,
    tool: raw.tool as string,
    files,
  };
  if (raw.crypto !== undefined) {
    assertCryptoParams(raw.crypto);
    const { kdf, N, r, p, salt } = raw.crypto;
    manifest.crypto = { kdf, N, r, p, salt };
  }
  if (raw.mac !== undefined) {
    if (typeof raw.mac !== "string" || !HEX_DIGEST.test(raw.mac)) bad("bad mac");
    manifest.mac = raw.mac as string;
  }
  if (anyEncrypted && !manifest.crypto) bad("encrypted entries without crypto parameters");
  // A signed manifest needs its key parameters and the parameters are only useful with a signature.
  if (manifest.crypto && manifest.mac === undefined) bad("crypto parameters without a mac");
  if (manifest.mac !== undefined && !manifest.crypto) bad("mac without crypto parameters");
  return manifest;
}
