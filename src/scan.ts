import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { relPathProblem } from "./codec.ts";
import { isAlwaysExcluded, isCredentialPath } from "./config.ts";
import { matchesAny, matchGlob } from "./globs.ts";
import type { ScannedFile, SkippedFile, SyncConfig } from "./types.ts";

// Stand-in child name to ask "could any file under this dir match?" of a glob list.
const PROBE = "x";

// Missing on Windows, where there is no symlink race to close.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

type EntryKind = "file" | "symlink" | "other";

interface Found {
  path: string;
  kind: EntryKind;
}

interface DirFailure {
  path: string;
  detail: string;
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
  for (const glob of exclude) {
    if (glob === "**") return true;
    if (glob.endsWith("/**") && matchGlob(glob.slice(0, -3), rel)) return true;
  }
  return false;
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
  agentDir: string,
  config: SyncConfig,
): Promise<{ found: Found[]; dirFailures: DirFailure[] }> {
  const found: Found[] = [];
  const dirFailures: DirFailure[] = [];

  async function visit(rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(rel === "" ? agentDir : join(agentDir, ...rel.split("/")), { withFileTypes: true });
    } catch (err) {
      if (rel === "") {
        // A missing agent dir just means nothing to sync yet
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
        if (!isPrunedDir(path, config.exclude)) await visit(path);
      } else if (isAlwaysExcluded(path) || matchesAny(config.exclude, path)) {
        continue;
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

export async function scanAgentDir(
  agentDir: string,
  config: SyncConfig,
  detect: (bytes: Uint8Array, path: string) => string[],
): Promise<{ files: ScannedFile[]; skipped: SkippedFile[] }> {
  const { found, dirFailures } = await walk(agentDir, config);
  const files: ScannedFile[] = [];
  const skipped: SkippedFile[] = [];

  // Only unreadable dirs that could hold synced files are worth a warning
  for (const f of dirFailures) {
    if (couldBeIncluded(f.path, config.include)) {
      skipped.push({ path: f.path, reason: "unreadable", detail: f.detail });
    }
  }

  for (const { path, kind } of found) {
    if (kind === "symlink") {
      if (couldBeIncluded(path, config.include)) skipped.push({ path, reason: "symlink" });
      continue;
    }
    if (!matchesAny(config.include, path)) continue;
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
      read = await readFileCapped(join(agentDir, ...path.split("/")), config.maxFileBytes);
    } catch (err) {
      if (!isNotFound(err)) skipped.push({ path, reason: "unreadable", detail: errMessage(err) });
      continue;
    }
    if ("tooLarge" in read) {
      skipped.push({
        path,
        reason: "too-large",
        detail: `${read.tooLarge} bytes exceeds maxFileBytes ${config.maxFileBytes}`,
      });
      continue;
    }

    files.push({
      path,
      size: read.bytes.length,
      mode: read.mode,
      bytes: read.bytes,
      sensitive: isCredentialPath(path) || detect(read.bytes, path).length > 0,
    });
  }

  files.sort(byPath);
  skipped.sort(byPath);
  return { files, skipped };
}

// Files that are neither included nor excluded: what the user could still choose to sync.
export async function listCandidates(agentDir: string, config: SyncConfig): Promise<string[]> {
  const { found } = await walk(agentDir, config);
  return found
    .filter((f) => f.kind === "file" && !matchesAny(config.include, f.path))
    .map((f) => f.path)
    .sort();
}
