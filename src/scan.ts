import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { relPathProblem } from "./codec.ts";
import { CASE_INSENSITIVE_FS, isAlwaysExcluded, isExcludedBy, PORTABLE_EXCLUDE } from "./config.ts";
import { matchesAny, matchGlob } from "./globs.ts";
import { isRootCredential, joinRootPath, ROOT_PREFIX, type ResolvedRoot } from "./roots.ts";
import type { ScannedFile, SkippedFile, SyncConfig } from "./types.ts";

// Stand-in child name to ask "could any file under this dir match?" of a glob list.
const PROBE = "x";

// Missing on Windows, where there is no symlink race to close.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

// "reserved": a top-level agent-dir entry starting with ROOT_PREFIX, which the gist uses for roots.
type EntryKind = "file" | "symlink" | "other" | "reserved";

interface Found {
  path: string;
  kind: EntryKind;
}

interface DirFailure {
  path: string;
  detail: string;
}

interface TreeOptions {
  include: readonly string[];
  exclude: readonly string[];
  maxFileBytes: number;
  /** Prepended to every reported path; "" for the agent dir. */
  prefix: string;
  /** Skip top-level names starting with ROOT_PREFIX (agent dir only). */
  reserveRootPrefix: boolean;
  /** Where the tree sits under home, for credential globs that name a dir; "" for the agent dir. */
  credPrefix: string;
}

// Code-unit order, not locale order, so output is identical on every machine.
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function byPath(a: { path: string }, b: { path: string }): number {
  return compareStrings(a.path, b.path);
}

function kindOf(entry: Dirent): EntryKind {
  if (entry.isSymbolicLink()) return "symlink";
  return entry.isFile() ? "file" : "other";
}

// `X/**` excludes every descendant of any dir matching X, so such a dir is never worth entering.
function isPrunedDir(rel: string, exclude: readonly string[]): boolean {
  if (isAlwaysExcluded(rel)) return true;
  const path = CASE_INSENSITIVE_FS ? rel.toLowerCase() : rel;
  for (const raw of exclude) {
    const glob = CASE_INSENSITIVE_FS ? raw.toLowerCase() : raw;
    if (glob === "**") return true;
    if (glob.endsWith("/**") && matchGlob(glob.slice(0, -3), path)) return true;
  }
  return false;
}

/** False only when no file below `dir` can match `glob`; braces may hide a `/`, so they count as a maybe. */
function globReachesBelow(glob: string, dir: string): boolean {
  if (glob.includes("{")) return true;
  const parts = glob.split("/");
  const segs = dir.split("/");
  for (const [i, seg] of segs.entries()) {
    const part = parts[i];
    if (part === undefined) return false;
    if (part.includes("**")) return true;
    // The glob ends at this depth, so it can only name `dir` itself.
    if (i === parts.length - 1) return false;
    if (!matchGlob(part, seg)) return false;
  }
  return true;
}

function couldBeIncluded(rel: string, include: readonly string[]): boolean {
  return matchesAny(include, rel) || matchesAny(include, `${rel}/${PROBE}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function walk(
  baseDir: string,
  exclude: readonly string[],
  reserveRootPrefix: boolean,
  /** When set, dirs no include glob can reach are not entered, so a narrow root never walks a huge tree. */
  include?: readonly string[],
): Promise<{ found: Found[]; dirFailures: DirFailure[] }> {
  const found: Found[] = [];
  const dirFailures: DirFailure[] = [];

  async function visit(rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(rel === "" ? baseDir : join(baseDir, ...rel.split("/")), { withFileTypes: true });
    } catch (err) {
      if (rel === "") {
        // A missing base dir just means nothing to sync yet
        if (isNotFound(err)) return;
        throw err;
      }
      if (!isNotFound(err)) dirFailures.push({ path: rel, detail: errMessage(err) });
      return;
    }
    entries.sort((a, b) => compareStrings(a.name, b.name));

    for (const entry of entries) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (isPrunedDir(path, exclude)) continue;
        if (include && !include.some((g) => globReachesBelow(g, path))) continue;
        if (reserveRootPrefix && rel === "" && entry.name.startsWith(ROOT_PREFIX)) {
          found.push({ path, kind: "reserved" });
        } else {
          await visit(path);
        }
      } else if (isAlwaysExcluded(path) || isExcludedBy(exclude, path)) {
        continue;
      } else if (reserveRootPrefix && rel === "" && entry.name.startsWith(ROOT_PREFIX)) {
        found.push({ path, kind: "reserved" });
      } else {
        found.push({ path, kind: kindOf(entry) });
      }
    }
  }

  await visit("");
  return { found, dirFailures };
}

async function readFileCapped(
  abs: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; mode: number } | { tooLarge: number }> {
  // lstat first: it needs no read permission and lets an oversized file be rejected unopened
  const pre = await lstat(abs);
  if (pre.size > maxBytes) return { tooLarge: pre.size };

  const fh = await open(abs, constants.O_RDONLY | O_NOFOLLOW);
  try {
    // Re-check on the handle: the file may have been swapped or grown since lstat
    const st = await fh.stat();
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.size > maxBytes) return { tooLarge: st.size };
    const buf = await fh.readFile();
    if (buf.length > maxBytes) return { tooLarge: buf.length };
    return { bytes: new Uint8Array(buf), mode: st.mode & 0o777 };
  } finally {
    await fh.close();
  }
}

// Native executables are per-platform builds, so syncing them across machines would install the wrong binary.
const MACHO_MAGICS: ReadonlySet<number> = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);
// CAFEBABE is also a Java class; its next word is a class version (45+), a fat Mach-O's is a small arch count.
const MAX_FAT_ARCHS = 30;

/** ELF, Mach-O (thin or fat) or PE by magic bytes; a PE needs `PE\0\0` at e_lfanew so an "MZ..." text file is not one. */
export function isNativeBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, false);
  if (magic === 0x7f454c46 || MACHO_MAGICS.has(magic)) return true;
  if (magic === 0xcafebabe) return bytes.length >= 8 && view.getUint32(4, false) < MAX_FAT_ARCHS;
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a || bytes.length < 0x40) return false;
  const peOffset = view.getUint32(0x3c, true);
  if (peOffset + 4 > bytes.length) return false;
  return view.getUint32(peOffset, false) === 0x50450000;
}

async function scanTree(
  baseDir: string,
  opts: TreeOptions,
  detect: (bytes: Uint8Array, path: string) => string[],
): Promise<{ files: ScannedFile[]; skipped: SkippedFile[] }> {
  const { found, dirFailures } = await walk(baseDir, opts.exclude, opts.reserveRootPrefix, opts.include);
  const files: ScannedFile[] = [];
  const skipped: SkippedFile[] = [];
  const out = (rel: string): string => opts.prefix + rel;

  // Only unreadable dirs that could hold synced files are worth a warning
  for (const f of dirFailures) {
    if (couldBeIncluded(f.path, opts.include)) {
      skipped.push({ path: out(f.path), reason: "unreadable", detail: f.detail });
    }
  }

  for (const { path: rel, kind } of found) {
    const path = out(rel);
    if (kind === "symlink") {
      if (couldBeIncluded(rel, opts.include)) skipped.push({ path, reason: "symlink" });
      continue;
    }
    if (kind === "reserved") {
      if (couldBeIncluded(rel, opts.include)) {
        skipped.push({ path, reason: "unreadable", detail: `the "${ROOT_PREFIX}" prefix is reserved for roots` });
      }
      continue;
    }
    if (!matchesAny(opts.include, rel)) continue;
    if (kind === "other") {
      skipped.push({ path, reason: "unreadable", detail: "not a regular file" });
      continue;
    }
    // An unsafe name would make the manifest unparseable on every machine that pulls it
    const problem = relPathProblem(path);
    if (problem !== undefined) {
      skipped.push({ path, reason: "unreadable", detail: `unsupported file name: ${problem}` });
      continue;
    }

    let read;
    try {
      read = await readFileCapped(join(baseDir, ...rel.split("/")), opts.maxFileBytes);
    } catch (err) {
      if (!isNotFound(err)) skipped.push({ path, reason: "unreadable", detail: errMessage(err) });
      continue;
    }
    if ("tooLarge" in read) {
      skipped.push({
        path,
        reason: "too-large",
        detail: `${read.tooLarge} bytes exceeds maxFileBytes ${opts.maxFileBytes}`,
      });
      continue;
    }
    if (isNativeBinary(read.bytes)) {
      skipped.push({ path, reason: "native-binary" });
      continue;
    }

    files.push({
      path,
      size: read.bytes.length,
      mode: read.mode,
      bytes: read.bytes,
      sensitive: isRootCredential(opts, rel) || detect(read.bytes, rel).length > 0,
    });
  }

  files.sort(byPath);
  skipped.sort(byPath);
  return { files, skipped };
}

export async function scanAgentDir(
  agentDir: string,
  config: SyncConfig,
  detect: (bytes: Uint8Array, path: string) => string[],
): Promise<{ files: ScannedFile[]; skipped: SkippedFile[] }> {
  return scanTree(
    agentDir,
    { include: config.include, exclude: config.exclude, maxFileBytes: config.maxFileBytes, prefix: "", reserveRootPrefix: true, credPrefix: "" },
    detect,
  );
}

function rootExclude(root: ResolvedRoot): string[] {
  return [...PORTABLE_EXCLUDE, ...root.exclude];
}

/** Scans a resolved root; every reported path is `@name/rel`, while `detect` gets the root-relative path. */
export async function scanRoot(
  root: ResolvedRoot,
  config: SyncConfig,
  detect: (bytes: Uint8Array, path: string) => string[],
): Promise<{ files: ScannedFile[]; skipped: SkippedFile[] }> {
  return scanTree(
    root.dir,
    {
      include: root.include,
      exclude: rootExclude(root),
      maxFileBytes: config.maxFileBytes,
      prefix: joinRootPath(root.name, ""),
      reserveRootPrefix: false,
      credPrefix: root.credPrefix,
    },
    detect,
  );
}

// Files that are neither included nor excluded: what the user could still choose to sync.
export async function listCandidates(agentDir: string, config: SyncConfig): Promise<string[]> {
  const { found } = await walk(agentDir, config.exclude, true);
  return found
    .filter((f) => f.kind === "file" && !matchesAny(config.include, f.path))
    .map((f) => f.path)
    .sort();
}

// Config is unused today; kept so roots and the agent dir share one call shape.
export async function listRootCandidates(root: ResolvedRoot, _config: SyncConfig): Promise<string[]> {
  const { found } = await walk(root.dir, rootExclude(root), false);
  return found
    .filter((f) => f.kind === "file" && !matchesAny(root.include, f.path))
    .map((f) => joinRootPath(root.name, f.path))
    .sort();
}
