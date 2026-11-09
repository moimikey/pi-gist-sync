// Shared contract. Every module codes against these types; do not change a
// signature without updating docs/SPEC.md and every consumer.
// Erasable TS only: no enums, namespaces or constructor parameter properties.

export type ErrorCode =
  | "NO_TOKEN"
  | "AUTH"
  | "NOT_FOUND"
  | "RATE_LIMIT"
  | "API"
  | "TOO_MANY_FILES"
  | "NOT_LINKED"
  | "BAD_MANIFEST"
  | "NO_PASSPHRASE"
  | "BAD_PASSPHRASE"
  | "CONFLICT"
  | "ABORTED"
  | "SECRET_BLOCKED";

export class GistSyncError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GistSyncError";
    this.code = code;
  }
}

// ---- config / state (machine-local, never synced) -------------------------

export type CredentialMode = "skip" | "encrypt";

/** A directory outside the agent dir that is synced under the gist namespace `@name/`. Local config only, never read from the gist. */
export interface RootConfig {
  /** Absolute, or starting with `~` or `~/` (expanded against the home dir). */
  dir: string;
  /** Globs relative to `dir`. Required and non-empty: a root syncs nothing by default. */
  include: string[];
  /** Globs relative to `dir`, applied after include. */
  exclude: string[];
}

export interface SyncConfig {
  gistId?: string;
  /** Extra directories to sync, keyed by root name (see ROOT_NAME in roots.ts). Default: none. */
  roots: Record<string, RootConfig>;
  /** Globs relative to the agent dir. Defaults: DEFAULT_INCLUDE in config.ts. */
  include: string[];
  /** Globs relative to the agent dir. Applied after include. */
  exclude: string[];
  /** What to do with credential files and files flagged by the secret scanner. */
  credentials: CredentialMode;
  /** Files larger than this are skipped with a warning. Default 1 MiB. */
  maxFileBytes: number;
  /** Notify on session start when the remote is newer. Default false. */
  checkOnStart: boolean;
}

/** Last successful sync; the base for three-way planning. */
export interface SyncState {
  gistId: string;
  revision: number;
  /** path -> digest (see Manifest) at last sync. */
  files: Record<string, string>;
  syncedAt: string;
  /** Set once a passphrase-signed manifest verified here; a later unsigned manifest is then refused. */
  signed?: boolean;
}

// ---- manifest (stored in the gist as MANIFEST_FILE) -----------------------

export const MANIFEST_FILE = "_pi-gist-sync.json";
export type Encoding = "utf8" | "base64";
export type Protection = "plain" | "encrypted";

export interface ManifestEntry {
  /** Gist file name, or null for an empty file (gists reject empty content). */
  gist: string | null;
  /** plain: sha256 hex of bytes. encrypted: HMAC-SHA256 hex of bytes keyed by the derived key. */
  digest: string;
  size: number;
  /** POSIX permission bits, e.g. 0o600. */
  mode: number;
  /** How the (decrypted) bytes are stored in the gist file. */
  enc: Encoding;
  protection: Protection;
}

export interface Manifest {
  schema: 1;
  revision: number;
  updatedAt: string;
  host: string;
  tool: string;
  files: Record<string, ManifestEntry>;
  /** Present when any entry is encrypted, or when the pusher signed the manifest. */
  crypto?: { kdf: "scrypt"; N: number; r: number; p: number; salt: string };
  /** HMAC-SHA256 hex over the rest of the manifest under a passphrase-derived key. Present iff `crypto` is. */
  mac?: string;
}

// ---- local scan ------------------------------------------------------------

export type SkipReason =
  | "excluded"
  | "too-large"
  | "credential"
  | "secret-detected"
  | "symlink"
  | "native-binary"
  | "unreadable";

export interface ScannedFile {
  /** POSIX path relative to the agent dir. */
  path: string;
  size: number;
  mode: number;
  bytes: Uint8Array;
  /** True for the built-in credential files or when the secret scanner flagged the content. */
  sensitive: boolean;
}

export interface SkippedFile {
  path: string;
  reason: SkipReason;
  detail?: string;
}

// ---- gist client -----------------------------------------------------------

export interface GistSnapshot {
  id: string;
  htmlUrl: string;
  updatedAt: string;
  /** filename -> full content (truncated files already fetched via raw_url). */
  files: Record<string, string>;
  /** Login of the gist owner, when the API reports one. */
  owner?: string;
  /** True for a public gist; a push to one is refused. */
  public?: boolean;
}

export interface GistClient {
  /** Always creates a secret (unlisted) gist. */
  create(description: string, files: Record<string, string>): Promise<GistSnapshot>;
  get(id: string): Promise<GistSnapshot>;
  /** `null` deletes the file. One PATCH request. */
  update(id: string, changes: Record<string, string | null>): Promise<GistSnapshot>;
  /** Login of the token's account, or undefined when the API will not say. */
  viewer(): Promise<string | undefined>;
}

// ---- planner ---------------------------------------------------------------

/** One side of a comparison, keyed by path. */
export interface SideEntry {
  digest: string;
  size: number;
  mode: number;
}

export type PlanAction =
  | "add" // absent on target, present on source
  | "update" // differs, target unchanged since base
  | "delete" // present on target, removed on source
  | "conflict" // both sides changed since base
  | "unchanged";

export interface PlanItem {
  path: string;
  action: PlanAction;
}

export interface Plan {
  items: PlanItem[];
}

// ---- sync orchestration (public API consumed by the command layer) ---------

export interface SyncEnv {
  agentDir: string;
  /** Home dir used to expand `~` in root dirs. Defaults to os.homedir(); tests pass a temp dir. */
  home?: string;
  client: GistClient;
  /** For encrypt mode; undefined means "no passphrase available". */
  passphrase?: string;
  hostname: string;
  /** Package version, recorded in the manifest. */
  version: string;
  now: () => Date;
}

export interface Report {
  /** Human-readable, one line each; the command layer prints them verbatim. */
  lines: string[];
  skipped: SkippedFile[];
}

export interface PushResult extends Report {
  gistUrl: string;
  revision: number;
  added: string[];
  updated: string[];
  deleted: string[];
  /** True when nothing needed to change. */
  noop: boolean;
}

/** Why a pulled path needs approval: code Pi runs, content that steers the model, or anything else unvetted. */
export type ReviewTier = "code" | "instructions" | "other";

export interface PullReview {
  path: string;
  action: "add" | "update" | "delete";
  tier: ReviewTier;
  /** sha256 hex of the bytes that will be written; absent for a delete. */
  sha256?: string;
  size?: number;
  /** For settings.json: the changed keys that are not on the safe list. */
  keys?: string[];
  /** For a path under a root: the absolute file that will be written or deleted, so the prompt shows where it lands. */
  dest?: string;
}

export interface PullPlan {
  gistUrl: string;
  remoteRevision: number;
  add: string[];
  update: string[];
  /** Files removed remotely since the last sync and kept locally; pull deletes them only with `prune`. */
  localOnly: string[];
  conflicts: string[];
  /** Every change that is not on the safe list (keybindings, themes, display-only settings). */
  review: PullReview[];
  /** Encrypted remote entries that cannot be decrypted without a passphrase. */
  undecryptable: string[];
}

export interface PullResult extends Report {
  applied: string[];
  backupDir?: string;
  /** True when extensions, skills, prompts, themes, settings.json, mcp.json or AGENTS-like files changed, so the caller should offer /reload. */
  needsReload: boolean;
}

export interface StatusResult extends Report {
  linked: boolean;
  gistUrl?: string;
  localRevision?: number;
  remoteRevision?: number;
  /** Local changes not yet pushed / remote changes not yet pulled. */
  ahead: string[];
  behind: string[];
  conflicts: string[];
}

export interface InitResult {
  gistId: string;
  gistUrl: string;
  created: boolean;
}

export interface SyncApi {
  /** `confirmForeign` runs when the gist belongs to another account; without it that link is refused. */
  init(env: SyncEnv, opts: { gistId?: string; confirmForeign?: (owner: string | undefined) => Promise<boolean> }): Promise<InitResult>;
  status(env: SyncEnv): Promise<StatusResult>;
  push(env: SyncEnv, opts: { force?: boolean; dryRun?: boolean }): Promise<PushResult>;
  /**
   * Computes the plan and calls `confirm` before writing whenever `review` is non-empty.
   * No `confirm`, or a false answer, aborts with ABORTED (fail closed). A dry run needs none.
   */
  pull(
    env: SyncEnv,
    opts: {
      force?: boolean;
      dryRun?: boolean;
      prune?: boolean;
      confirm?: (plan: PullPlan) => Promise<boolean>;
    },
  ): Promise<PullResult>;
  /** Files under the agent dir not matched by include/exclude, relative paths, sorted. */
  scanCandidates(env: SyncEnv): Promise<string[]>;
  unlink(env: SyncEnv): Promise<void>;
}
