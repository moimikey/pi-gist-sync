import { createHash } from "node:crypto";
import { GistSyncError, MANIFEST_FILE, type Encoding } from "./types.ts";

// ignoreBOM keeps a leading U+FEFF in the string so the round trip stays byte-exact.
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Gist rejects whitespace-only content; the extra code points are blank to some servers but not to JS \s.
const BLANK = /^[\s\u0085\u180e\u200b-\u200d\u2060]*$/;

const BASE64_BODY = /^[A-Za-z0-9+/]*={0,2}$/;

/** Gist file names are flat, so `/` and `%` are escaped. */
export function encodePath(path: string): string {
  const encoded = path.replace(/[%/]/g, (c) => (c === "%" ? "%25" : "%2F"));
  // A user file can never take the manifest's slot in the gist.
  return encoded === MANIFEST_FILE ? `%5F${encoded.slice(1)}` : encoded;
}

const ESCAPES: Record<string, string> = { "%25": "%", "%2F": "/", "%5F": "_" };

export function decodePath(name: string): string {
  // Single pass so `%2525` decodes to `%25`, not `%`.
  return name.replace(/%(?:25|2F|5F)/g, (m) => ESCAPES[m] ?? m);
}

// Bounds keep a hostile manifest from making the path checks, globs or lstat expensive or failing.
export const MAX_PATH_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 255;
export const MAX_PATH_DEPTH = 32;

// Control, invisible format, bidi and line-separator characters can spoof a prompt or hide a name.
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
// Spaces other than U+0020 and blank filler letters make a name look like another one in a prompt.
const LOOKALIKE_BLANK = /[\p{Zs}\u115f\u1160\u3164\uffa0\u2800]/u;
// Windows device names (with or without an extension) and stream or drive syntax.
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** The reason a path cannot be synced, or undefined when it is safe to join to the agent dir. */
export function relPathProblem(path: unknown): string | undefined {
  if (typeof path !== "string") return "not a string";
  if (path === "") return "empty";
  if (path.includes("\u0000")) return "contains NUL";
  if (path.includes("\\")) return "contains a backslash";
  if (path.startsWith("/")) return "absolute";
  if (/^[A-Za-z]:/.test(path)) return "drive letter";
  if (path.endsWith("/")) return "trailing slash";
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) return "path too long";
  if (INVISIBLE.test(path)) return "contains a control or invisible character";
  if (LOOKALIKE_BLANK.test(path.replaceAll(" ", ""))) return "contains a non-ASCII space or blank character";
  const segments = path.split("/");
  if (segments.length > MAX_PATH_DEPTH) return "nested too deeply";
  for (const segment of segments) {
    if (segment === "") return "empty segment";
    if (segment === "." || segment === "..") return "dot segment";
    if (Buffer.byteLength(segment) > MAX_SEGMENT_BYTES) return "file name too long";
    if (segment.includes(":")) return "contains a colon";
    if (/[. ]$/.test(segment)) return "ends with a dot or space";
    if (WINDOWS_RESERVED.test(segment)) return "reserved device name";
  }
  return undefined;
}

export function isSafeRelPath(path: string): boolean {
  return relPathProblem(path) === undefined;
}

/** Rejects anything that could resolve outside the agent dir once joined to it. */
export function assertSafeRelPath(path: string): void {
  const why = relPathProblem(path);
  if (why === undefined) return;
  const shown = typeof path === "string" ? JSON.stringify(path.slice(0, 80)) : typeof path;
  throw new GistSyncError("BAD_MANIFEST", `Unsafe path ${shown}: ${why}`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    return undefined;
  }
}

/** null for empty input, because gists reject empty files. */
export function toGistContent(bytes: Uint8Array): { content: string; enc: Encoding } | null {
  if (bytes.length === 0) return null;
  const text = decodeUtf8(bytes);
  if (text !== undefined && !text.includes("\u0000") && !BLANK.test(text)) {
    return { content: text, enc: "utf8" };
  }
  const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  return { content, enc: "base64" };
}

/** Strict, padded base64 only; undefined when the input is not canonical-looking base64. */
export function parseBase64(text: string): Uint8Array | undefined {
  if (text.length % 4 !== 0 || !BASE64_BODY.test(text)) return undefined;
  return new Uint8Array(Buffer.from(text, "base64"));
}

export function fromGistContent(content: string, enc: Encoding): Uint8Array {
  if (enc === "utf8") return new Uint8Array(Buffer.from(content, "utf8"));
  if (enc === "base64") {
    const bytes = parseBase64(content);
    if (!bytes) throw new GistSyncError("BAD_MANIFEST", "Gist file is not valid base64");
    return bytes;
  }
  throw new GistSyncError("BAD_MANIFEST", "Unknown content encoding");
}
