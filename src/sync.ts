import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { assertSafeRelPath, encodePath, fromGistContent, sha256Hex, toGistContent } from "./codec.ts";
import {
  BACKUP_DIR,
  clearState,
  isAlwaysExcluded,
  isCredentialPath,
  loadConfig,
  loadState,
  saveConfig,
  saveState,
} from "./config.ts";
import { decryptBytes, deriveKey, digestsEqual, encryptBytes, hmacDigest, manifestMac, newCryptoParams } from "./crypto.ts";
import type { CryptoParams } from "./crypto.ts";
import { matchesAny } from "./globs.ts";
import { manifestSigningText, parseManifest, serializeManifest } from "./manifest.ts";
import { planSync } from "./plan.ts";
import { listCandidates, scanAgentDir } from "./scan.ts";
import { detectSecrets } from "./secrets.ts";
import { canonicalSettings, mergeMachineLocal, parseSettings, unsafeSettingsChanges } from "./settings-merge.ts";
import {
  GistSyncError,
  MANIFEST_FILE,
  type GistSnapshot,
  type InitResult,
  type Manifest,
  type ManifestEntry,
  type PlanAction,
  type PlanItem,
  type PullPlan,
  type PullReview,
  type PullResult,
  type PushResult,
  type ReviewTier,
  type SideEntry,
  type SkippedFile,
  type StatusResult,
  type SyncApi,
  type SyncConfig,
  type SyncEnv,
  type SyncState,
} from "./types.ts";

const DESCRIPTION = "pi-gist-sync: Pi agent settings";
const SETTINGS_FILE = "settings.json";
// Ids end up in a URL path, so anything beyond this alphabet is refused up front.
const GIST_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_LISTED = 20;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const INSTRUCTION_FILES = new Set(["agents.md", "agents.override.md", "claude.md", "system.md", "append_system.md"]);
// The only paths a pull applies without asking: display-only files. Everything else can run code or steer the model.
const SAFE_FILE = "keybindings.json";
const SAFE_DIR = "themes/";

type Digests = Record<string, string>;
type Sides = Record<string, SideEntry>;

// Own-property read so a path named "__proto__" never resolves through the prototype.
function own<T>(rec: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

function byText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function bad(message: string): GistSyncError {
  return new GistSyncError("BAD_MANIFEST", message);
}

// ---- scope policy: which paths this machine may push, delete or write ------

function isSyncable(config: SyncConfig, path: string): boolean {
  return !isAlwaysExcluded(path) && matchesAny(config.include, path) && !matchesAny(config.exclude, path);
}

function guardedBy(skipped: readonly SkippedFile[], path: string): SkippedFile | undefined {
  return skipped.find((s) => path === s.path || path.startsWith(`${s.path}/`));
}

interface Scope {
  config: SyncConfig;
  /** Local files the scan could not read or policy withheld; remote copies of them are left alone. */
  skipped: readonly SkippedFile[];
  /** Remote paths refused for other reasons (symlink, undecryptable, plain credential). */
  refused: Set<string>;
}

// Out-of-scope paths are never pushed, deleted or overwritten, whatever the other side says.
function outOfScope(scope: Scope, path: string): boolean {
  return !isSyncable(scope.config, path) || guardedBy(scope.skipped, path) !== undefined || scope.refused.has(path);
}

function affectsReload(path: string): boolean {
  const lower = path.toLowerCase();
  if (["extensions/", "skills/", "prompts/", "themes/"].some((dir) => lower.startsWith(dir))) return true;
  return lower === SETTINGS_FILE || lower === "mcp.json" || INSTRUCTION_FILES.has(lower);
}

// ---- local side -------------------------------------------------------------

interface LocalFile {
  path: string;
  mode: number;
  /** Canonical bytes: what is compared, uploaded and digested. */
  bytes: Uint8Array;
  /** Must be encrypted before upload (only set in encrypt mode). */
  sensitive: boolean;
}

function canonicalBytes(path: string, bytes: Uint8Array): Uint8Array {
  if (path !== SETTINGS_FILE) return bytes;
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return bytes;
  }
  const canon = canonicalSettings(text);
  return canon === text ? bytes : new Uint8Array(Buffer.from(canon, "utf8"));
}

async function scanLocal(
  env: SyncEnv,
  config: SyncConfig,
): Promise<{ files: Map<string, LocalFile>; skipped: SkippedFile[] }> {
  // The scanner sees the bytes that would be uploaded, so a stripped machine-local key never flags the file.
  const scan = await scanAgentDir(env.agentDir, config, (bytes, path) => detectSecrets(canonicalBytes(path, bytes)));
  const files = new Map<string, LocalFile>();
  const skipped: SkippedFile[] = [...scan.skipped];
  for (const f of scan.files) {
    if (f.path === SETTINGS_FILE && !isValidSettings(f.bytes)) {
      // Unparseable settings would upload machine-local keys unstripped, so they stay local.
      skipped.push({ path: f.path, reason: "unreadable", detail: "settings.json is not a valid JSON object" });
      continue;
    }
    if (f.sensitive && config.credentials === "skip") {
      skipped.push({ path: f.path, reason: isCredentialPath(f.path) ? "credential" : "secret-detected" });
      continue;
    }
    files.set(f.path, { path: f.path, mode: f.mode & 0o777, bytes: canonicalBytes(f.path, f.bytes), sensitive: f.sensitive });
  }
  skipped.sort((a, b) => byText(a.path, b.path));
  return { files, skipped };
}

function isValidSettings(bytes: Uint8Array): boolean {
  try {
    return parseSettings(UTF8.decode(bytes)) !== undefined;
  } catch {
    return false;
  }
}

// ---- remote side -----------------------------------------------------------

interface Remote {
  snapshot: GistSnapshot;
  /** undefined when the gist has no manifest yet, which reads as an empty remote. */
  manifest: Manifest | undefined;
  entries: Record<string, ManifestEntry>;
  revision: number;
}

async function loadLinked(env: SyncEnv): Promise<{ config: SyncConfig; gistId: string; state: SyncState | undefined }> {
  const config = await loadConfig(env.agentDir);
  if (!config.gistId) throw new GistSyncError("NOT_LINKED", "Not linked to a gist. Run /gist-sync init [gist-id] first.");
  const stored = await loadState(env.agentDir);
  // State from another gist is a wrong base, so it is ignored.
  return { config, gistId: config.gistId, state: stored?.gistId === config.gistId ? stored : undefined };
}

async function fetchRemote(env: SyncEnv, gistId: string, state: SyncState | undefined, force: boolean): Promise<Remote> {
  const snapshot = await env.client.get(gistId);
  const text = own(snapshot.files, MANIFEST_FILE);
  if (typeof text !== "string") {
    if (state) throw bad("The gist has no manifest, but this machine has synced with it before. Refusing to continue.");
    return { snapshot, manifest: undefined, entries: {}, revision: 0 };
  }
  const manifest = parseManifest(text);
  // Revisions only grow, so a lower one is a replayed older manifest.
  if (state && manifest.revision < state.revision && !force) {
    throw bad(
      `The gist is at revision ${manifest.revision} but this machine already synced revision ${state.revision}. ` +
        "Refusing an older manifest. Use --force to accept it, or /gist-sync unlink and init to start over.",
    );
  }
  const seen = new Set<string>();
  for (const path of Object.keys(manifest.files)) {
    assertSafeRelPath(path);
    // Two names that differ only in case would hit one file on a case-insensitive disk.
    const lower = path.toLowerCase();
    if (seen.has(lower)) throw bad(`Manifest lists paths that differ only in case: ${path}`);
    seen.add(lower);
  }
  // A path that is also another path's parent would fail halfway through the writes.
  for (const lower of seen) {
    for (let i = lower.indexOf("/"); i !== -1; i = lower.indexOf("/", i + 1)) {
      const parent = lower.slice(0, i);
      if (seen.has(parent)) throw bad(`Manifest lists ${parent} as both a file and a directory.`);
    }
  }
  return { snapshot, manifest, entries: manifest.files, revision: manifest.revision };
}

// A gist has no conditional write, so a concurrent push could be silently overwritten. Re-reading just
// before the write shrinks that window to one round trip; it cannot close it.
async function assertRemoteUnchanged(env: SyncEnv, gistId: string, seen: Remote): Promise<void> {
  const latest = await env.client.get(gistId);
  const text = own(latest.files, MANIFEST_FILE);
  const revision = typeof text === "string" ? parseManifest(text).revision : 0;
  if (revision !== seen.revision || latest.updatedAt !== seen.snapshot.updatedAt) {
    throw new GistSyncError("CONFLICT", "The gist changed while this push was being prepared. Nothing was written. Run /gist-sync status, then push again.");
  }
}

interface Auth {
  /** Derived key, when the manifest is signed and a passphrase was given. */
  key: Uint8Array | undefined;
  /** True when the manifest signature checked out under that key. */
  verified: boolean;
}

// Verifies the manifest signature and enforces the pin: once this machine verified a signed gist, an unsigned one is refused.
async function authenticate(env: SyncEnv, gistId: string, state: SyncState | undefined, remote: Remote): Promise<Auth> {
  const manifest = remote.manifest;
  if (!manifest) return { key: undefined, verified: false };
  const pinned = state?.signed === true;
  if (!manifest.crypto || manifest.mac === undefined) {
    if (pinned) {
      throw bad(
        "The gist manifest is no longer signed, but this machine verified its signature before. " +
          "If you removed the signature on purpose, run /gist-sync unlink and init again.",
      );
    }
    return { key: undefined, verified: false };
  }
  if (!env.passphrase) {
    if (pinned) {
      throw new GistSyncError("NO_PASSPHRASE", "This gist is signed and this machine verified it before. Set PI_GIST_SYNC_PASSPHRASE to continue.");
    }
    return { key: undefined, verified: false };
  }
  const key = await deriveKey(env.passphrase, manifest.crypto);
  if (!digestsEqual(manifestMac(key, gistId, manifestSigningText(manifest)), manifest.mac)) {
    throw new GistSyncError("BAD_PASSPHRASE", "The manifest signature does not match: wrong passphrase, or the manifest was modified.");
  }
  return { key, verified: true };
}

function gistText(snapshot: GistSnapshot, entry: ManifestEntry, path: string): string {
  const text = entry.gist === null ? undefined : own(snapshot.files, entry.gist);
  if (typeof text !== "string") throw bad(`The gist file for ${path} is missing.`);
  return text;
}

async function keyFor(env: SyncEnv, params: CryptoParams): Promise<Uint8Array> {
  if (!env.passphrase) {
    throw new GistSyncError("NO_PASSPHRASE", "A passphrase is required for encrypted files. Set PI_GIST_SYNC_PASSPHRASE.");
  }
  return deriveKey(env.passphrase, params);
}

// ---- shared helpers ---------------------------------------------------------

function forcedAction(path: string, source: Sides, target: Sides): PlanAction {
  if (own(source, path) === undefined) return "delete";
  return own(target, path) === undefined ? "add" : "update";
}

function resolveItems(items: readonly PlanItem[], force: boolean, source: Sides, target: Sides): PlanItem[] {
  return items.map((item) =>
    item.action === "conflict" && force ? { path: item.path, action: forcedAction(item.path, source, target) } : item,
  );
}

function pathsOf(items: readonly PlanItem[], action: PlanAction): string[] {
  return items.filter((i) => i.action === action).map((i) => i.path);
}

/** What both sides agreed on after the operation; the base for the next three-way plan. */
function nextBase(
  base: Digests,
  items: readonly PlanItem[],
  source: Sides,
  target: Sides,
  keep: (path: string) => boolean,
): Digests {
  const out = new Map<string, string>();
  for (const [path, digest] of Object.entries(base)) if (keep(path)) out.set(path, digest);
  for (const { path, action } of items) {
    const s = own(source, path)?.digest;
    const t = own(target, path)?.digest;
    const b = own(base, path);
    if (action === "add" || action === "update") {
      if (s !== undefined) out.set(path, s);
    } else if (action === "unchanged") {
      // Equal sides agree; otherwise keep the old base so a one-sided edit or delete is never reverted.
      if (s !== undefined && s === t) out.set(path, s);
      else if (b !== undefined) out.set(path, b);
    }
  }
  return Object.fromEntries([...out].sort(([a], [b]) => byText(a, b)));
}

async function persistState(
  env: SyncEnv,
  gistId: string,
  previous: SyncState | undefined,
  revision: number,
  files: Digests,
  verified: boolean,
) {
  // The pin only ever tightens: one verified signature keeps unsigned manifests out from then on.
  const signed = verified || previous?.signed === true;
  if (previous && previous.revision === revision && isDeepStrictEqual(previous.files, files) && (previous.signed === true) === signed) {
    return;
  }
  const next: SyncState = { gistId, revision, files, syncedAt: env.now().toISOString() };
  if (signed) next.signed = true;
  await saveState(env.agentDir, next);
}

function listLines(items: readonly PlanItem[]): string[] {
  const changed = items.filter((i) => i.action !== "unchanged");
  const lines = changed.slice(0, MAX_LISTED).map((i) => `  ${i.action} ${i.path}`);
  if (changed.length > MAX_LISTED) lines.push(`  ...and ${changed.length - MAX_LISTED} more`);
  return lines;
}

function pathLine(label: string, paths: readonly string[]): string {
  const shown = paths.slice(0, MAX_LISTED).join(", ");
  return `${label} ${shown}${paths.length > MAX_LISTED ? `, ...and ${paths.length - MAX_LISTED} more` : ""}`;
}

function skippedLines(skipped: readonly SkippedFile[]): string[] {
  const lines = skipped.slice(0, MAX_LISTED / 2).map((s) => `Skipped ${s.path}: ${s.reason}${s.detail ? ` (${s.detail})` : ""}`);
  if (skipped.length > MAX_LISTED / 2) lines.push(`Skipped ${skipped.length - MAX_LISTED / 2} more files.`);
  if (skipped.some((s) => s.reason === "credential" || s.reason === "secret-detected")) {
    lines.push('Credentials are not synced. Set "credentials": "encrypt" in gist-sync.json to sync them encrypted.');
  }
  return lines;
}

function conflictError(paths: readonly string[], hint: string): GistSyncError {
  return new GistSyncError("CONFLICT", `${paths.length} file(s) changed on both sides: ${paths.join(", ")}. ${hint}`);
}

// ---- push -------------------------------------------------------------------

function stage(file: LocalFile, digest: string, key: Uint8Array | undefined): { entry: ManifestEntry; content: string | undefined } {
  const common = { digest, size: file.bytes.length, mode: file.mode };
  if (file.sensitive) {
    if (!key) throw new GistSyncError("NO_PASSPHRASE", "A passphrase is required to encrypt credentials.");
    // The envelope is stored verbatim, so its gist encoding is plain utf8 text.
    return {
      entry: { gist: encodePath(file.path), ...common, enc: "utf8", protection: "encrypted" },
      content: encryptBytes(key, file.bytes, file.path),
    };
  }
  const stored = toGistContent(file.bytes);
  if (!stored) return { entry: { gist: null, ...common, enc: "utf8", protection: "plain" }, content: undefined };
  return { entry: { gist: encodePath(file.path), ...common, enc: stored.enc, protection: "plain" }, content: stored.content };
}

async function push(env: SyncEnv, opts: { force?: boolean; dryRun?: boolean }): Promise<PushResult> {
  const { config, gistId, state } = await loadLinked(env);
  const remote = await fetchRemote(env, gistId, state, opts.force === true);
  // A public gist is world-readable and listed, so config would be published, not stored.
  if (remote.snapshot.public === true) {
    throw new GistSyncError("API", "That gist is public. Pushing would publish your Pi config; link a secret gist with /gist-sync init instead.");
  }
  const scan = await scanLocal(env, config);
  const scope: Scope = { config, skipped: scan.skipped, refused: new Set() };

  const locals = [...scan.files.values()].filter((f) => !outOfScope(scope, f.path));
  const auth = await authenticate(env, gistId, state, remote);
  let params = remote.manifest?.crypto;
  let key = auth.key;
  if (params) {
    // The manifest signature cannot be refreshed without the key, and an unsigned one would be refused elsewhere.
    if (!key) throw new GistSyncError("NO_PASSPHRASE", "This gist is signed. Set PI_GIST_SYNC_PASSPHRASE to push to it.");
  } else if (locals.some((f) => f.sensitive) || (config.credentials === "encrypt" && env.passphrase !== undefined)) {
    params = newCryptoParams();
    key = await keyFor(env, params);
  }

  const source: Sides = Object.fromEntries(
    locals.map((f) => [
      f.path,
      { digest: f.sensitive ? hmacDigest(key as Uint8Array, f.path, f.bytes) : sha256Hex(f.bytes), size: f.bytes.length, mode: f.mode },
    ]),
  );
  const target: Sides = Object.fromEntries(
    Object.entries(remote.entries)
      .filter(([path]) => !outOfScope(scope, path))
      .map(([path, e]) => [path, { digest: e.digest, size: e.size, mode: e.mode }]),
  );

  const base = state?.files ?? {};
  const plan = planSync(base, source, target);
  const conflicts = pathsOf(plan.items, "conflict");
  const force = opts.force === true;
  if (conflicts.length > 0 && !force && !opts.dryRun) {
    throw conflictError(conflicts, "Pull first, or push with --force to overwrite the gist (its history keeps the old version).");
  }

  const items = resolveItems(plan.items, force, source, target);
  const added = pathsOf(items, "add");
  const updated = pathsOf(items, "update");
  const deleted = pathsOf(items, "delete");
  const changed = added.length + updated.length + deleted.length > 0;
  const gistUrl = remote.snapshot.htmlUrl;

  if (opts.dryRun) {
    const lines = ["Dry run: nothing was written."];
    if (conflicts.length > 0) lines.push(pathLine(force ? "Would overwrite conflicting:" : "Conflicts (use --force):", conflicts));
    lines.push(changed ? "Would push:" : "Nothing to push.", ...listLines(items));
    return {
      lines: [...lines, ...skippedLines(scan.skipped)],
      skipped: scan.skipped,
      gistUrl,
      revision: remote.revision,
      added,
      updated,
      deleted,
      noop: !changed && conflicts.length === 0,
    };
  }

  const keep = (path: string) => outOfScope(scope, path);
  if (!changed) {
    await persistState(env, gistId, state, state?.revision ?? remote.revision, nextBase(base, items, source, target, keep), auth.verified);
    return {
      lines: ["Nothing to push. The gist is up to date.", ...skippedLines(scan.skipped)],
      skipped: scan.skipped,
      gistUrl,
      revision: remote.revision,
      added,
      updated,
      deleted,
      noop: true,
    };
  }

  const entries = new Map(Object.entries(remote.entries));
  const changes = new Map<string, string | null>();
  const byPath = new Map(locals.map((f) => [f.path, f]));
  for (const { path, action } of items) {
    const previous = entries.get(path);
    if (action === "delete") {
      entries.delete(path);
      if (previous?.gist) changes.set(previous.gist, null);
    } else if (action === "add" || action === "update") {
      const file = byPath.get(path);
      const digest = own(source, path)?.digest;
      if (!file || digest === undefined) continue;
      const staged = stage(file, digest, key);
      if (previous?.gist && previous.gist !== staged.entry.gist) changes.set(previous.gist, null);
      if (staged.entry.gist !== null && staged.content !== undefined) changes.set(staged.entry.gist, staged.content);
      entries.set(path, staged.entry);
    }
  }

  const revision = remote.revision + 1;
  const manifest: Manifest = {
    schema: 1,
    revision,
    updatedAt: env.now().toISOString(),
    host: env.hostname,
    tool: `pi-gist-sync@${env.version}`,
    files: Object.fromEntries(entries),
  };
  // A key means the pusher has a passphrase, so the manifest is signed and carries the key parameters.
  if (key && params) {
    manifest.crypto = params;
    manifest.mac = manifestMac(key, gistId, manifestSigningText(manifest));
  }
  changes.set(MANIFEST_FILE, serializeManifest(manifest));
  await assertRemoteUnchanged(env, gistId, remote);
  const result = await env.client.update(gistId, Object.fromEntries(changes));

  await persistState(env, gistId, state, revision, nextBase(base, items, source, target, keep), key !== undefined && params !== undefined);
  return {
    lines: [
      `Pushed ${added.length + updated.length + deleted.length} file(s) to ${result.htmlUrl} (revision ${revision}).`,
      ...listLines(items),
      ...skippedLines(scan.skipped),
    ],
    skipped: scan.skipped,
    gistUrl: result.htmlUrl,
    revision,
    added,
    updated,
    deleted,
    noop: false,
  };
}

// ---- pull and status: shared view of both sides -----------------------------

type Target = { abs: string } | { symlink: true } | { blocked: string };

/** Resolves a manifest path under agentDir, refusing symlinks so a write can never leave it. */
async function resolveTarget(agentDir: string, path: string): Promise<Target> {
  assertSafeRelPath(path);
  const segments = path.split("/");
  let current = agentDir;
  for (const [i, segment] of segments.entries()) {
    current = join(current, segment);
    let st;
    try {
      st = await lstat(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Nothing exists from here down, so there is no symlink left to meet.
      if (code === "ENOENT") break;
      // Any other failure is about this one path; it must not wedge every sync.
      return { blocked: code ?? "cannot be inspected" };
    }
    if (st.isSymbolicLink()) return { symlink: true };
    const last = i === segments.length - 1;
    if (!last && !st.isDirectory()) return { blocked: "a parent is a file" };
    if (last && st.isDirectory()) return { blocked: "a directory is in the way" };
  }
  const abs = join(agentDir, ...segments);
  const rel = relative(agentDir, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw bad(`Path escapes the agent dir: ${path}`);
  return { abs };
}

function usable(target: Target): target is { abs: string } {
  return "abs" in target;
}

interface View {
  scope: Scope;
  key: Uint8Array | undefined;
  /** True when the manifest is signed but no passphrase was available to check it. */
  unverified: boolean;
  verified: boolean;
  undecryptable: string[];
  /** Remote entries left alone because of local policy. */
  skipped: SkippedFile[];
  source: Sides;
  target: Sides;
  targets: Map<string, string>;
}

// Plain sha256 for most files, HMAC when the reference digest was made with the key.
function localDigest(file: LocalFile, refs: readonly (string | undefined)[], key: Uint8Array | undefined): string {
  const plain = sha256Hex(file.bytes);
  if (refs.includes(plain)) return plain;
  if (key) {
    const keyed = hmacDigest(key, file.path, file.bytes);
    if (refs.includes(keyed)) return keyed;
  }
  return plain;
}

async function buildView(
  env: SyncEnv,
  config: SyncConfig,
  gistId: string,
  state: SyncState | undefined,
  remote: Remote,
  scan: { files: Map<string, LocalFile>; skipped: SkippedFile[] },
): Promise<View> {
  const scope: Scope = { config, skipped: scan.skipped, refused: new Set() };
  const skipped: SkippedFile[] = [];
  const live: Array<[string, ManifestEntry]> = [];
  const targets = new Map<string, string>();

  for (const [path, entry] of Object.entries(remote.entries)) {
    if (!isSyncable(config, path)) {
      skipped.push({ path, reason: "excluded" });
      continue;
    }
    const local = guardedBy(scan.skipped, path);
    if (local) {
      skipped.push({ ...local, path });
      continue;
    }
    if (entry.protection === "plain" && isCredentialPath(path)) {
      // Credentials only ever travel encrypted, so a plain one is a planted file, not a sync.
      scope.refused.add(path);
      skipped.push({ path, reason: "credential" });
      continue;
    }
    if (entry.size > config.maxFileBytes) {
      scope.refused.add(path);
      skipped.push({ path, reason: "too-large", detail: `${entry.size} bytes exceeds maxFileBytes ${config.maxFileBytes}` });
      continue;
    }
    const resolved = await resolveTarget(env.agentDir, path);
    if ("symlink" in resolved) {
      scope.refused.add(path);
      skipped.push({ path, reason: "symlink" });
      continue;
    }
    if ("blocked" in resolved) {
      scope.refused.add(path);
      skipped.push({ path, reason: "unreadable", detail: resolved.blocked });
      continue;
    }
    targets.set(path, resolved.abs);
    live.push([path, entry]);
  }
  for (const s of skipped) scope.refused.add(s.path);

  const auth = await authenticate(env, gistId, state, remote);
  const key = auth.key;
  const undecryptable: string[] = [];
  const decodable = live.filter(([path, entry]) => {
    if (entry.protection !== "encrypted" || key) return true;
    undecryptable.push(path);
    scope.refused.add(path);
    return false;
  });

  const source: Sides = Object.fromEntries(
    decodable.map(([path, e]) => [path, { digest: e.digest, size: e.size, mode: e.mode }]),
  );
  const base = state?.files ?? {};
  const target: Sides = Object.fromEntries(
    [...scan.files.values()]
      .filter((f) => !outOfScope(scope, f.path))
      .map((f) => [
        f.path,
        {
          digest: localDigest(f, [own(source, f.path)?.digest, own(base, f.path)], key),
          size: f.bytes.length,
          mode: f.mode,
        },
      ]),
  );
  return {
    scope,
    key,
    unverified: remote.manifest?.crypto !== undefined && !auth.verified,
    verified: auth.verified,
    undecryptable: undecryptable.sort(byText),
    skipped,
    source,
    target,
    targets,
  };
}

/** Decodes one remote entry to bytes and proves it matches its manifest digest and size. */
function decodeEntry(snapshot: GistSnapshot, path: string, entry: ManifestEntry, key: Uint8Array | undefined): Uint8Array {
  let bytes: Uint8Array;
  let digest: string;
  if (entry.protection === "encrypted") {
    if (!key) throw new GistSyncError("NO_PASSPHRASE", `A passphrase is required to decrypt ${path}.`);
    bytes = decryptBytes(key, gistText(snapshot, entry, path), path);
    digest = hmacDigest(key, path, bytes);
  } else {
    bytes = entry.gist === null ? new Uint8Array(0) : fromGistContent(gistText(snapshot, entry, path), entry.enc);
    digest = sha256Hex(bytes);
  }
  if (!digestsEqual(digest, entry.digest) || bytes.length !== entry.size) {
    throw bad(`Digest mismatch for ${path}: the gist content does not match its manifest. Nothing was written.`);
  }
  return bytes;
}

async function readLocalText(abs: string): Promise<string | undefined> {
  try {
    return (await readFile(abs)).toString("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

async function exists(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

// A manifest is not trusted with permissions: drop group and world write plus setuid, setgid and sticky,
// keep owner read and write, and pin credentials to 0600.
function safeMode(mode: number, credential: boolean): number {
  return credential ? 0o600 : ((mode & 0o755) | 0o600) & 0o777;
}

async function writeAtomic(agentDir: string, path: string, bytes: Uint8Array, mode: number): Promise<void> {
  // Re-checked at write time in case a path component was swapped for a symlink since planning.
  const resolved = await resolveTarget(agentDir, path);
  if (!usable(resolved)) throw bad(`Refusing to write ${path}: ${"symlink" in resolved ? "it is behind a symlink" : resolved.blocked}.`);
  const dir = dirname(resolved.abs);
  await mkdir(dir, { recursive: true });
  // Fixed-length name: a 300-char target name plus a suffix would exceed the filesystem limit.
  const tmp = join(dir, `.gist-sync-${randomBytes(6).toString("hex")}.tmp`);
  try {
    // Private until the final mode is applied; fsync so a crash cannot rename an empty file into place.
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(bytes);
      await fh.chmod(mode & 0o777);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, resolved.abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function backup(agentDir: string, root: string, path: string): Promise<boolean> {
  const resolved = await resolveTarget(agentDir, path);
  if (!usable(resolved) || !(await exists(resolved.abs))) return false;
  const dest = join(root, ...path.split("/"));
  await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
  try {
    await copyFile(resolved.abs, dest, constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  return true;
}

interface Ready {
  bytes: Uint8Array;
  mode: number;
}

function tierOf(path: string): ReviewTier {
  const lower = path.toLowerCase();
  if (lower.startsWith("extensions/") || lower === "mcp.json" || lower === "models.json" || lower === SETTINGS_FILE) return "code";
  if (["skills/", "agents/", "prompts/"].some((dir) => lower.startsWith(dir)) || INSTRUCTION_FILES.has(lower)) {
    return "instructions";
  }
  return "other";
}

function reviewAction(path: string, planned: PlanAction | undefined, deletes: readonly string[]): PullReview["action"] {
  if (deletes.includes(path)) return "delete";
  return planned === "add" ? "add" : "update";
}

/** Allowlist: only display-only files and display-only settings keys apply without approval. */
function reviewFor(
  path: string,
  action: PullReview["action"],
  bytes: Uint8Array | undefined,
  settingsKeys: readonly string[],
): PullReview | undefined {
  if (path === SAFE_FILE || path.startsWith(SAFE_DIR)) return undefined;
  if (path === SETTINGS_FILE && action !== "delete" && settingsKeys.length === 0) return undefined;
  const review: PullReview = { path, action, tier: tierOf(path) };
  if (bytes) {
    review.sha256 = sha256Hex(bytes);
    review.size = bytes.length;
  }
  if (path === SETTINGS_FILE && settingsKeys.length > 0) review.keys = [...settingsKeys];
  return review;
}

async function pull(
  env: SyncEnv,
  opts: { force?: boolean; dryRun?: boolean; prune?: boolean; confirm?: (plan: PullPlan) => Promise<boolean> },
): Promise<PullResult> {
  const { config, gistId, state } = await loadLinked(env);
  const force = opts.force === true;
  const remote = await fetchRemote(env, gistId, state, force);
  if (!remote.manifest) {
    return { lines: ["The gist has no synced files yet. Run /gist-sync push first."], skipped: [], applied: [], needsReload: false };
  }
  const scan = await scanLocal(env, config);
  const view = await buildView(env, config, gistId, state, remote, scan);
  const base = state?.files ?? {};
  const prune = opts.prune === true;

  const plan = planSync(base, view.source, view.target);
  const conflicts = pathsOf(plan.items, "conflict");
  if (conflicts.length > 0 && !force && !opts.dryRun) {
    throw conflictError(conflicts, "Push first, or pull with --force to overwrite the local copies (they are backed up first).");
  }

  const resolved = resolveItems(plan.items, force, view.source, view.target);
  const pendingDeletes = pathsOf(resolved, "delete");
  // Without --prune a remote delete is only reported, so the sync state must keep its old base.
  const items = resolved.map((i): PlanItem => (i.action === "delete" && !prune ? { path: i.path, action: "unchanged" } : i));
  const writes = items.filter((i) => i.action === "add" || i.action === "update").map((i) => i.path);
  const deletes = prune ? pendingDeletes : [];
  const applied = [...writes, ...deletes].sort(byText);
  const localOnly = prune ? [] : pendingDeletes;
  const actionOf = new Map(items.map((i) => [i.path, i.action]));

  // Verify every entry before touching disk: one bad digest means nothing is written.
  const ready = new Map<string, Ready>();
  const settingsKeys: string[] = [];
  const localSettings = writes.includes(SETTINGS_FILE) ? await readLocalText(join(env.agentDir, SETTINGS_FILE)) : undefined;
  for (const path of writes) {
    const entry = own(remote.entries, path) as ManifestEntry;
    let bytes = decodeEntry(remote.snapshot, path, entry, view.key);
    if (path === SETTINGS_FILE) {
      let remoteText: string;
      try {
        remoteText = UTF8.decode(bytes);
      } catch {
        throw bad("settings.json in the gist is not valid UTF-8. Nothing was written.");
      }
      // Without a parseable object the machine-local keys could not be stripped, so refuse it outright.
      if (parseSettings(remoteText) === undefined) {
        throw bad("settings.json in the gist is not a valid JSON object. Nothing was written.");
      }
      const merged = mergeMachineLocal(remoteText, localSettings);
      settingsKeys.push(...unsafeSettingsChanges(localSettings, merged));
      bytes = new Uint8Array(Buffer.from(merged, "utf8"));
    }
    if (own(view.target, path) === undefined && (await exists(view.targets.get(path) as string))) {
      throw new GistSyncError("CONFLICT", `${path} already exists locally but was not scanned (name clash by case, or created during the pull).`);
    }
    const credential = entry.protection === "encrypted" || isCredentialPath(path);
    ready.set(path, { bytes, mode: safeMode(entry.mode, credential) });
  }

  const review: PullReview[] = [];
  for (const path of applied) {
    const item = reviewFor(path, reviewAction(path, actionOf.get(path), deletes), ready.get(path)?.bytes, path === SETTINGS_FILE ? settingsKeys : []);
    if (item) review.push(item);
  }
  const pullPlan: PullPlan = {
    gistUrl: remote.snapshot.htmlUrl,
    remoteRevision: remote.revision,
    add: pathsOf(plan.items, "add"),
    update: pathsOf(plan.items, "update"),
    localOnly,
    conflicts,
    review,
    undecryptable: view.undecryptable,
  };

  const notes: string[] = [];
  if (localOnly.length > 0) notes.push(pathLine("Removed remotely, kept locally (use --prune to delete):", localOnly));
  if (view.undecryptable.length > 0) {
    notes.push(pathLine("Encrypted, skipped (set PI_GIST_SYNC_PASSPHRASE to decrypt):", view.undecryptable));
  }
  if (view.unverified) notes.push("Manifest signature not checked: set PI_GIST_SYNC_PASSPHRASE to verify it.");
  notes.push(...skippedLines(view.skipped));

  if (opts.dryRun) {
    const lines = ["Dry run: nothing was written."];
    if (conflicts.length > 0) lines.push(pathLine(force ? "Would overwrite conflicting:" : "Conflicts (use --force):", conflicts));
    lines.push(applied.length > 0 ? "Would pull:" : "Nothing to pull.", ...listLines(items.filter((i) => applied.includes(i.path))));
    if (review.length > 0) lines.push(pathLine("Would ask before changing:", review.map((r) => r.path)));
    return { lines: [...lines, ...notes], skipped: view.skipped, applied: [], needsReload: false };
  }

  const keep = (path: string) => outOfScope(view.scope, path);
  const nextFiles = nextBase(base, items, view.source, view.target, keep);

  if (applied.length === 0) {
    await persistState(env, gistId, state, remote.revision, nextFiles, view.verified);
    return { lines: ["Already up to date.", ...notes], skipped: view.skipped, applied: [], needsReload: false };
  }

  if (review.length > 0) {
    // No handler is a refusal, never a free pass: the caller must say who approved.
    if (!opts.confirm) {
      throw new GistSyncError("ABORTED", `${review.length} change(s) need approval and no confirmation handler was given. Nothing was changed.`);
    }
    if (!(await opts.confirm(pullPlan))) throw new GistSyncError("ABORTED", "Pull cancelled. Nothing was changed.");
  }

  // Backups first, so a failure here still leaves every local file untouched.
  const stamp = env.now().toISOString().replaceAll(":", "-");
  const root = join(env.agentDir, BACKUP_DIR, stamp);
  let backedUp = 0;
  // Whatever exists now is saved, including files created while the prompt was open.
  for (const path of applied) {
    if (await backup(env.agentDir, root, path)) backedUp++;
  }

  for (const path of writes) {
    const item = ready.get(path) as Ready;
    await writeAtomic(env.agentDir, path, item.bytes, item.mode);
  }
  for (const path of deletes) {
    const resolvedTarget = await resolveTarget(env.agentDir, path);
    if (!usable(resolvedTarget)) throw bad(`Refusing to delete ${path}: ${"symlink" in resolvedTarget ? "it is behind a symlink" : resolvedTarget.blocked}.`);
    await rm(resolvedTarget.abs, { force: true });
  }

  await persistState(env, gistId, state, remote.revision, nextFiles, view.verified);
  const lines = [
    `Pulled ${applied.length} file(s) from ${remote.snapshot.htmlUrl} (revision ${remote.revision}).`,
    ...listLines(items.filter((i) => applied.includes(i.path))),
  ];
  if (backedUp > 0) lines.push(`Backed up ${backedUp} file(s) to ${BACKUP_DIR}/${stamp}.`);
  lines.push(...notes);
  const result: PullResult = { lines, skipped: view.skipped, applied, needsReload: applied.some(affectsReload) };
  if (backedUp > 0) result.backupDir = root;
  return result;
}

// ---- status, init, scan, unlink --------------------------------------------

async function status(env: SyncEnv): Promise<StatusResult> {
  const config = await loadConfig(env.agentDir);
  if (!config.gistId) {
    return {
      lines: ["Not linked. Run /gist-sync init to create a gist, or /gist-sync init <gist-id> to link one."],
      skipped: [],
      linked: false,
      ahead: [],
      behind: [],
      conflicts: [],
    };
  }
  const { gistId, state } = await loadLinked(env);
  const remote = await fetchRemote(env, gistId, state, false);
  const scan = await scanLocal(env, config);
  const view = await buildView(env, config, gistId, state, remote, scan);
  const base = state?.files ?? {};

  const out = planSync(base, view.target, view.source);
  const inn = planSync(base, view.source, view.target);
  const changed = (items: readonly PlanItem[]) => items.filter((i) => ["add", "update", "delete"].includes(i.action)).map((i) => i.path);
  const ahead = changed(out.items);
  const behind = changed(inn.items);
  const conflicts = pathsOf(out.items, "conflict");

  const lines = [
    `Linked to ${remote.snapshot.htmlUrl}`,
    `Local revision ${state ? state.revision : "none"}, remote revision ${remote.revision}.`,
  ];
  if (ahead.length > 0) lines.push(pathLine(`Ahead (${ahead.length} to push):`, ahead));
  if (behind.length > 0) lines.push(pathLine(`Behind (${behind.length} to pull):`, behind));
  if (conflicts.length > 0) lines.push(pathLine(`Conflicts (${conflicts.length}):`, conflicts));
  if (ahead.length + behind.length + conflicts.length === 0) lines.push("In sync.");
  if (view.undecryptable.length > 0) {
    lines.push(`${view.undecryptable.length} encrypted file(s) not compared: set PI_GIST_SYNC_PASSPHRASE.`);
  }
  if (view.unverified) lines.push("Manifest signature not checked: set PI_GIST_SYNC_PASSPHRASE to verify it.");
  const result: StatusResult = {
    lines,
    skipped: scan.skipped,
    linked: true,
    gistUrl: remote.snapshot.htmlUrl,
    remoteRevision: remote.revision,
    ahead,
    behind,
    conflicts,
  };
  if (state) result.localRevision = state.revision;
  return result;
}

async function init(
  env: SyncEnv,
  opts: { gistId?: string; confirmForeign?: (owner: string | undefined) => Promise<boolean> },
): Promise<InitResult> {
  const config = await loadConfig(env.agentDir);
  const wanted = opts.gistId?.trim();
  let snapshot: GistSnapshot;
  let created = false;
  if (wanted) {
    if (!GIST_ID.test(wanted)) throw new GistSyncError("NOT_FOUND", `"${wanted.slice(0, 40)}" is not a valid gist id.`);
    snapshot = await env.client.get(wanted);
    const text = own(snapshot.files, MANIFEST_FILE);
    // A gist without a manifest is fine (first push adds it); a broken one is not.
    if (typeof text === "string") parseManifest(text);
    await confirmOwner(env, snapshot, opts.confirmForeign);
  } else if (config.gistId) {
    // Already linked: re-running init must not orphan the gist by creating a second one.
    snapshot = await env.client.get(config.gistId);
  } else {
    const placeholder: Manifest = {
      schema: 1,
      revision: 0,
      updatedAt: env.now().toISOString(),
      host: env.hostname,
      tool: `pi-gist-sync@${env.version}`,
      files: {},
    };
    snapshot = await env.client.create(DESCRIPTION, { [MANIFEST_FILE]: serializeManifest(placeholder) });
    created = true;
  }
  const previous = await loadState(env.agentDir);
  if (previous && previous.gistId !== snapshot.id) await clearState(env.agentDir);
  await saveConfig(env.agentDir, { ...config, gistId: snapshot.id });
  return { gistId: snapshot.id, gistUrl: snapshot.htmlUrl, created };
}

// Whoever owns a gist controls the files a pull writes, so another account's gist needs an explicit yes.
async function confirmOwner(
  env: SyncEnv,
  snapshot: GistSnapshot,
  confirmForeign: ((owner: string | undefined) => Promise<boolean>) | undefined,
): Promise<void> {
  const viewer = await env.client.viewer();
  if (viewer !== undefined && snapshot.owner !== undefined && viewer.toLowerCase() === snapshot.owner.toLowerCase()) return;
  if (confirmForeign && (await confirmForeign(snapshot.owner))) return;
  const who = snapshot.owner ?? "an account that could not be identified";
  throw new GistSyncError(
    "ABORTED",
    `That gist belongs to ${who}, not to your token's account. Whoever owns it controls the files you pull, so it was not linked.`,
  );
}

async function scanCandidates(env: SyncEnv): Promise<string[]> {
  return listCandidates(env.agentDir, await loadConfig(env.agentDir));
}

async function unlink(env: SyncEnv): Promise<void> {
  const config = await loadConfig(env.agentDir);
  await saveConfig(env.agentDir, {
    include: config.include,
    exclude: config.exclude,
    credentials: config.credentials,
    maxFileBytes: config.maxFileBytes,
    checkOnStart: config.checkOnStart,
  });
  await clearState(env.agentDir);
}

export const sync: SyncApi = { init, status, push, pull, scanCandidates, unlink };
