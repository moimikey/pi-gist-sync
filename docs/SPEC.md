# pi-gist-sync: design spec (build contract)

Pi extension that syncs the Pi agent dir (settings, extensions, skills, prompts, themes, instructions) through ONE multi-file GitHub Gist. Zero runtime dependencies. Shipped as TypeScript (Pi loads it with jiti; no build step). Package name `pi-gist-sync`, command `/gist-sync`.

Contract types live in `src/types.ts`. Read it first. Change it only together with this spec and every consumer.

## Hard rules for all code

- Erasable TS only (tsconfig `erasableSyntaxOnly`): no `enum`, `namespace`, constructor parameter properties. Relative imports MUST end in `.ts`. `import type` for types.
- Node built-ins only (`node:fs/promises`, `node:path`, `node:crypto`, `node:os`, `node:http` in tests). No new dependencies. `fetch` is global.
- No dynamic `import()` in `src/`: jiti can hand a second concurrent `import()` of one module an undefined namespace.
- Tests: `node:test` + `node:assert/strict`, files `test/<module>.test.ts`. Run one with `node --test --experimental-strip-types test/<file>.test.ts`; all with `npm test`. Typecheck: `npm run typecheck`.
- Comments explain WHY, one short line. No ticket IDs. No comment that restates the code. No em dashes.
- Never touch the real `~/.pi`. Tests use `fs.mkdtemp` dirs and the fake gist server. Never call the real GitHub API.

## Why Gist is awkward (verified live against api.github.com)

| Fact | Consequence |
|---|---|
| File names containing `/` are rejected (422) | `encodePath`: `%` -> `%25`, `/` -> `%2F`. Gist is flat. |
| Empty or whitespace-only content is rejected | Empty file: manifest entry with `gist: null`. Whitespace-only file: store as base64. |
| `%`, `\`, `:`, `?`, unicode, dotfiles, 300-char names are accepted | Percent codec is enough. |
| Max 300 files per gist; file >1 MiB returns `truncated: true` | `TOO_MANY_FILES`; client fetches `raw_url` for truncated files. |
| Secret gists are unlisted, NOT private | Credentials skipped by default; optional AES-256-GCM encryption. |
| Text only | Non-UTF-8 or NUL-containing bytes -> `enc: "base64"`. |

## Modules, owners, signatures

### U1 `core-fs`: `src/globs.ts`, `src/scan.ts`, `src/config.ts`, `src/settings-merge.ts`

```ts
// globs.ts: own tiny matcher; supports **, *, ?, {a,b}; posix paths; `*` does not cross `/`; `**/` matches zero or more dirs.
export function matchGlob(glob: string, path: string): boolean;
export function matchesAny(globs: readonly string[], path: string): boolean;

// config.ts
export const CONFIG_FILE = "gist-sync.json";
export const STATE_FILE = "gist-sync.state.json";
export const BACKUP_DIR = "gist-sync-backups";
export const DEFAULT_INCLUDE: readonly string[];
export const DEFAULT_EXCLUDE: readonly string[];
export const CREDENTIAL_GLOBS: readonly string[];
export function isCredentialPath(path: string): boolean; // case-insensitive CREDENTIAL_GLOBS match
export function isAlwaysExcluded(path: string): boolean; // see the always-excluded list below
export function resolveAgentDir(env?: NodeJS.ProcessEnv): string; // PI_CODING_AGENT_DIR (expand leading ~) else ~/.pi/agent
export function defaultConfig(): SyncConfig;
export function loadConfig(agentDir: string): Promise<SyncConfig>; // missing file -> defaultConfig(); merges over defaults; invalid types fall back per-field
export function saveConfig(agentDir: string, cfg: SyncConfig): Promise<void>;
export function loadState(agentDir: string): Promise<SyncState | undefined>;
export function saveState(agentDir: string, st: SyncState): Promise<void>;
export function clearState(agentDir: string): Promise<void>;
// All writes: temp file in same dir + rename, mode 0o600.

// scan.ts
export function scanAgentDir(
  agentDir: string,
  config: SyncConfig,
  detect: (bytes: Uint8Array, path: string) => string[], // injected secret scanner; non-empty result marks sensitive
): Promise<{ files: ScannedFile[]; skipped: SkippedFile[] }>;
export function listCandidates(agentDir: string, config: SyncConfig): Promise<string[]>;

// settings-merge.ts
export const MACHINE_LOCAL_KEYS: readonly string[];
export const SAFE_SETTINGS_KEYS: readonly string[];
export function parseSettings(text: string | undefined): Record<string, unknown> | undefined; // BOM-tolerant; undefined unless a JSON object
export function canonicalSettings(text: string): string; // strip machine-local keys, JSON.stringify(obj,null,2)+"\n"; a leading BOM is ignored; invalid JSON -> text unchanged, so callers must reject it first
export function mergeMachineLocal(remoteText: string, localText: string | undefined): string; // remote + local's machine-local keys
export function changedSettingsKeys(beforeText: string | undefined, afterText: string): string[]; // differing top-level keys, machine-local ones aside
export function unsafeSettingsChanges(beforeText: string | undefined, afterText: string): string[]; // changedSettingsKeys minus SAFE_SETTINGS_KEYS
```

Details:

- Walk the agent dir without following symlinks. Symlinks are skipped (`reason: "symlink"`). Prune excluded directories early (do not descend into `node_modules`, `sessions`, ...). Paths are POSIX relative. Sorted output.
- Always excluded regardless of config, in both directions, matched case-insensitively (`isAlwaysExcluded` in `config.ts`): `CONFIG_FILE`, `STATE_FILE`, `BACKUP_DIR/**`, `**/.git/**`, `**/node_modules/**`, and Pi's own per-machine files at the top level: `trust.json` (its entries name absolute project paths and widen trust), `oauth.json`, `crashes.json`.
- A file whose path fails `relPathProblem` (see U2) is skipped with `reason: "unreadable"` and `detail: "unsupported file name: ..."`, because the manifest could not carry it.
- A file is included when it matches `include` and not `exclude`. On darwin and win32 (`CASE_INSENSITIVE_FS`) every exclude list (`config.exclude`, `PORTABLE_EXCLUDE`, a root's `exclude`) is matched through `isExcludedBy`, which lowercases both glob and path, so a case variant cannot slip past an exclude; include stays case-sensitive. A directory no include glob can reach is not walked. Files over `maxFileBytes` -> skipped `too-large` (do not read them). Read errors -> `unreadable`.
- `sensitive` = `isCredentialPath(path)` OR `detect(bytes, path).length > 0`; for a root file, `isRootCredential(root, rel)` replaces `isCredentialPath`. `detect` takes the path so the sync layer can scan the bytes it will upload (canonical `settings.json`, not the raw file). Scan returns sensitive files in `files`; the sync layer applies the credential policy.
- `DEFAULT_INCLUDE`: `settings.json`, `keybindings.json`, `mcp.json`, `models.json`, `AGENTS.md`, `AGENTS.override.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `extensions/**`, `skills/**`, `prompts/**`, `themes/**`, `agents/**`, `bin/**`, plus top-level `*.json` and `*.md` (third-party extension config such as `mcp-adapter.json`) and `*/settings.json`. Source of truth: `src/config.ts`.
- `DEFAULT_EXCLUDE`: `**/node_modules/**`, `**/.git/**`, `**/.DS_Store`, `**/*.bak`, `**/*.bak-*`, `**/*.log`, `**/*.jsonl`, `**/*.tmp`, `*-cache.json`, `*-store.json`, `**/__pycache__/**`, `**/.ruff_cache/**`, `sessions/**`, `subagents/**`, `checkpoints/**`, `jobs/**`, `tmp/**`, `npm/**`, `git/**`, `memory-archive/**`, plus the roots-feature additions listed under "Default list changes" below. Source of truth: `src/config.ts`. (Include/exclude are user-editable in `gist-sync.json`.)
- `CREDENTIAL_GLOBS`: `**/auth.json`, `**/*-auth.json`, `**/oauth.json`, `**/*credentials*.json`, `**/*token*.json`, `**/.env`, `**/.env.*`, `**/.netrc`, `**/_netrc`, `**/.pgpass`, `**/.npmrc`, `**/.pypirc`, `**/.git-credentials`, `**/{.,}docker/config.json`, `**/{.,}kube/config`, `**/*.{pem,key,p12,pfx}`, `**/id_{rsa,dsa,ecdsa,ed25519}*`, `**/gh/hosts.yml`. Applied through `isCredentialPath(path)`, which lowercases the path first: extensions keep tokens in nested dirs and macOS ignores case.
- `MACHINE_LOCAL_KEYS` (never pushed, preserved locally on pull): `lastChangelogVersion`, `extensionChangelogVersions`, `sessionDir`, `shellPath`, `httpProxy`, `selfUpdateCommand`, `npmCommand`, `defaultProjectTrust`, `deviceId`, `trackingId`. Rationale: per-machine, or security-sensitive (a remote edit must not widen trust or swap the updater), or an installation identifier.
- Property: `canonicalSettings(mergeMachineLocal(canonicalSettings(x), y)) === canonicalSettings(x)`.
- `SAFE_SETTINGS_KEYS` is the allowlist of display and behavior keys a pull may change without approval (`theme`, `quietStartup`, `compaction`, ...). It never holds a key that runs code, loads paths or redirects traffic (`packages`, `extensions`, `skills`, `prompts`, `themes`, `shellCommandPrefix`, `externalEditor`, `defaultTools`, `codemode`, `defaultProvider`, `defaultModel`, `enabledModels`), and any key not listed needs approval.
- `defaultConfig()`: `roots: {}`, `credentials: "skip"`, `maxFileBytes: 1048576`, `checkOnStart: false`, include/exclude copies of the defaults, no `gistId`.

### U2 `core-crypto`: `src/codec.ts`, `src/secrets.ts`, `src/crypto.ts`, `src/manifest.ts`

```ts
// codec.ts
export function encodePath(path: string): string; // `%`->`%25`, `/`->`%2F`; a name equal to MANIFEST_FILE gets its first char escaped (`%5F`) so users can never shadow it
export function decodePath(name: string): string;
export function relPathProblem(path: unknown): string | undefined; // the reason a path is unsafe
export function isSafeRelPath(path: string): boolean;
export function assertSafeRelPath(path: string): void; // throws GistSyncError("BAD_MANIFEST") when relPathProblem finds one: absolute, empty, empty/`..`/`.` segment, backslash, NUL, control or invisible (Cc, Cf, U+2028/9) character, a non-ASCII space (Zs other than U+0020) or blank filler (U+115F, U+1160, U+3164, U+FFA0, U+2800), colon, drive letter, trailing slash, segment ending in dot or space, Windows device name (CON, NUL, COM1..), over 1024 bytes, a segment over 255 bytes, over 32 segments
export function sha256Hex(bytes: Uint8Array): string;
export function toGistContent(bytes: Uint8Array): { content: string; enc: Encoding } | null; // null for empty; utf8 only if valid UTF-8, no NUL, not whitespace-only; else base64
export function fromGistContent(content: string, enc: Encoding): Uint8Array;

// secrets.ts
export function detectSecrets(bytes: Uint8Array): string[]; // labels like "github-token", "private-key" (also base64 `LS0tLS1CRUdJTi`), "basic-auth" (an "auth" field holding base64 user:password), "netrc-password", "aws-access-key", "slack-token", "openai-key", "jwt", "url-password", "generic-secret-assignment"; [] when clean; never returns the secret itself. NUL bytes are dropped before matching (UTF-16 and NUL-padded text), and JSON text is also matched after decoding its escapes

// crypto.ts
export interface CryptoParams { kdf: "scrypt"; N: number; r: number; p: number; salt: string } // salt base64
export function newCryptoParams(): CryptoParams; // N=2**17, r=8, p=1, random 16-byte salt. Accepted on parse: N in {2**17, 2**18}, r=8, p<=2
export function deriveKey(passphrase: string, params: CryptoParams): Promise<Uint8Array>; // 32 bytes
// The scrypt output is a master key; HKDF-SHA256 derives separate AES and HMAC subkeys from it.
export function encryptBytes(key: Uint8Array, bytes: Uint8Array, path: string): string; // JSON envelope {"v":1,"iv","tag","ct"} base64; AES-256-GCM, fresh 12-byte IV, `path` bound as AAD
export function decryptBytes(key: Uint8Array, envelope: string, path: string): Uint8Array; // GistSyncError("BAD_PASSPHRASE") on auth failure (also a different path); "BAD_MANIFEST" on malformed envelope
export function hmacDigest(key: Uint8Array, path: string, bytes: Uint8Array): string; // HMAC-SHA256 hex over `path NUL bytes`
export function manifestMac(key: Uint8Array, gistId: string, canonicalText: string): string; // HMAC-SHA256 hex bound to the gist
export function digestsEqual(a: string, b: string): boolean; // constant-time

// manifest.ts
export function serializeManifest(m: Manifest): string; // stable: keys of `files` sorted, 2-space JSON, trailing newline
export function manifestSigningText(m: Manifest): string; // serializeManifest without `mac`: the text the MAC covers
export function parseManifest(text: string): Manifest; // validates schema===1, at most 300 entries, every path via assertSafeRelPath, entry field types, digest is 64 lowercase hex, `gist` is null or exactly encodePath(path) (so names never alias), mode in 0..0o777, enc/protection enums, crypto present when an entry is encrypted, `mac` (64 hex) present iff `crypto` is; GistSyncError("BAD_MANIFEST") otherwise
```

Notes: tests must prove detectSecrets never echoes secrets, that tampering with `ct`/`tag` fails with BAD_PASSPHRASE, that a ciphertext or digest only verifies under its own path, that path traversal strings (`../x`, `a/../../b`, `/etc/passwd`, `C:\x`) are rejected, and that encode/decode round-trips for `%`, `%2F`, unicode, and leading `_pi-gist-sync`.

### U3 `gist-client`: `src/gist-client.ts`, `test/helpers/fake-gist-server.ts`, `test/gist-client.test.ts`

```ts
export interface GistClientOptions { token: string; baseUrl?: string /* default https://api.github.com */; fetch?: typeof fetch; userAgent?: string; maxRetries?: number /* default 2: GET and PATCH on 5xx and network errors only; a POST is never retried so a create cannot duplicate */; maxRawBytes?: number /* default 64 MiB */ }
export function createGistClient(opts: GistClientOptions): GistClient;
export function resolveToken(
  env: NodeJS.ProcessEnv,
  ghAuthToken: () => Promise<string | undefined>, // injected: runs `gh auth token`
): Promise<string>; // order: PI_GIST_SYNC_TOKEN, GH_TOKEN, GITHUB_TOKEN, ghAuthToken(); none -> GistSyncError("NO_TOKEN") with an actionable message mentioning the `gist` scope
```

Extra surface: `GistSnapshot` carries `owner` (login) and `public` when the API reports them; `GistClient.viewer()` returns the token's login (`GET /user`), or undefined on 403/404. `maxRawBytes` caps each raw download, checked against `content-length` and while streaming.

Behavior: headers `Authorization: Bearer`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent`. `create` posts `{description, public:false, files:{name:{content}}}`. `update` PATCHes `files` (null deletes). Files with `truncated: true` or missing `content` are fetched from `raw_url` (reuse the same auth header only when the raw URL host is the API host or gist.githubusercontent.com; never send the token elsewhere). Error map: 401 -> AUTH; 403 with `x-ratelimit-remaining: 0` -> RATE_LIMIT (message includes reset time); other 403 -> AUTH (mention the `gist` scope); 404 -> NOT_FOUND; 422 -> API (include GitHub's message); >300 files -> TOO_MANY_FILES before the request. Never include the token in any error message or log.

Fake server (`startFakeGist()` returns `{ baseUrl, close(): Promise<void>, gists: Map<string, FakeGist>, requests: {method,url,headers,body}[], failNext(status, headers?) }`): implements `POST /gists`, `GET /gists/:id`, `PATCH /gists/:id`, raw file endpoint, Bearer check (token `test-token`), 422 for empty/whitespace-only content and names containing `/`, 300-file limit, `truncated` + `raw_url` for content >1 MiB (listing omits content). It is the shared fixture for the e2e test; keep its API stable.

### U4 `orchestrator`: `src/plan.ts`, `src/sync.ts`, `test/plan.test.ts`, `test/sync.test.ts`

```ts
// plan.ts: pure three-way plan, mirrors `git merge` semantics per path.
export function planSync(
  base: Record<string, string> /* path->digest at last sync; {} if never synced */,
  source: Record<string, SideEntry>,
  target: Record<string, SideEntry>,
): Plan;
// Per path, with b=base digest, s=source digest, t=target digest; "absent" is a value (undefined) too:
//   s === t                -> unchanged
//   t === b                -> target untouched since base, source wins: s absent ? delete : t absent ? add : update
//   s === b                -> only the target changed: unchanged (never reverted)
//   otherwise              -> conflict
// First sync (base {}): a file on both sides with different digests is a conflict; a file on one side only is add (source) or unchanged (target-only).
// Return items sorted by path.

// sync.ts
export const sync: SyncApi;
```

`sync` behavior:

- Local side: `scanAgentDir` with `detectSecrets`. Canonical bytes: `settings.json` goes through `canonicalSettings`. The scanner sees the canonical bytes (`detect` gets the path). A `settings.json` that is not a valid JSON object (a leading BOM is fine) is skipped as `unreadable`, never uploaded, because its machine-local keys could not be stripped. Policy: sensitive file under `credentials: "skip"` -> `SkippedFile` (`credential` if `isCredentialPath` else `secret-detected`), never uploaded; under `"encrypt"` -> encrypted (needs `env.passphrase`, else `NO_PASSPHRASE`). Digest: plain -> `sha256Hex(canonical)`; encrypted -> `hmacDigest(key, path, canonical)`.
- `push`: `get` remote manifest (if gist is empty/missing manifest and state absent, treat remote as empty). A public gist (`snapshot.public === true`) is refused with `API`, dry run included. A manifest whose revision is below `state.revision` is refused with `BAD_MANIFEST` unless `force`. The manifest signature is verified first (see "Signing"). Plan source=local, target=remote, base=state.files. Conflicts block unless `force` (throws `CONFLICT` listing paths). Deletes propagate: a file removed locally since the last sync is removed from the gist (gist revision history keeps it). Just before writing, `get` the gist again and throw `CONFLICT` (nothing written) if its manifest revision or `updatedAt` differs from the first read: a gist has no conditional write, so this narrows the lost-update race to one round trip but cannot close it. Before that, a push that would leave the gist with more than 300 files in total (remote entries kept, plus adds, minus deletes, plus the manifest) throws `TOO_MANY_FILES`, dry run included. Then one `client.update` call with only changed files + new manifest (revision = remote revision + 1). Then `saveState`. `dryRun` returns the plan lines and writes nothing (a pull dry run lists every review item with its `dest`). Unchanged -> `noop: true`, no API write.
- Signing: when the remote manifest has `crypto`, push needs the passphrase (`NO_PASSPHRASE` otherwise) and re-signs. When it has none, push creates `crypto` params and signs if any local file is sensitive, or if `credentials` is `encrypt` and a passphrase exists. A signed manifest carries `crypto` and `mac = manifestMac(key, gistId, manifestSigningText(manifest))`. Pull and status verify the `mac` when `crypto` is present and a passphrase exists (mismatch -> `BAD_PASSPHRASE`). `SyncState.signed` is set after any verified or signed sync and never cleared: a signed-state machine refuses a manifest with no `crypto`/`mac` (`BAD_MANIFEST`) and a signed one it has no passphrase for (`NO_PASSPHRASE`). With no pin and no passphrase the signature is unchecked and a line says so.
- `pull`: plan source=remote, target=local, base=state. A `delete` plan item (removed remotely since last sync) is applied only with `prune`; otherwise the path is listed in `localOnly`. Local-only files with no base are never deleted. The first pull on a machine that already has a different `settings.json` is a conflict by design: `--force` resolves it and backs the local copy up first. Conflicts block unless `force` (local copy goes to backup first). Every overwritten or deleted file is copied to `<agentDir>/gist-sync-backups/<ISO timestamp with : replaced by ->/<path>` first; the timestamp dir is created exclusively and gets a random suffix if it already exists, so a backup is never silently dropped. Backups cover whatever exists when the writes start, including files created while `confirm` was open. Writes are atomic (temp file fsynced, then rename), `mkdir -p` parents, and the mode is clamped to `(mode & 0o755) | 0o600`, or 0o600 for encrypted entries and credential paths. Path from the manifest is validated (`assertSafeRelPath`) AND the resolved target must stay inside agentDir (symlinked parents are skipped). A target that cannot be inspected or used (a directory in the way, a parent that is a file, any lstat error other than ENOENT) skips that one entry as `unreadable`. A plain entry on a credential path is skipped in every mode. A remote entry over `config.maxFileBytes` is skipped as `too-large`. A decoded entry that `isNativeBinary` flags is skipped as `native-binary` and its base is not advanced. Manifest paths that are equal after `normalize("NFC").toLowerCase()` are `BAD_MANIFEST`. Verify the digest after decoding (constant-time compare); mismatch -> `BAD_MANIFEST`, nothing from that run is partially trusted (verify ALL before writing ANY). `settings.json` must decode to a valid JSON object (`BAD_MANIFEST` otherwise) and is written via `mergeMachineLocal(remote, local)`. Encrypted entries with no passphrase -> listed in `undecryptable`, skipped, remaining files still apply. Approval gate: `plan.review` lists every applied change except the safe set (`keybindings.json` and `themes/**` when the mode to be written has no execute bit, or for a delete, and `settings.json` when `unsafeSettingsChanges` is empty); each item has `action`, a `tier` (`code`: `extensions/**`, `mcp.json`, `models.json`, `settings.json`, `bin/**` (case-insensitive; Pi puts `<agentDir>/bin` first on its bash PATH), any entry whose mode has an execute bit, and every root path; `instructions`: `skills/**`, `agents/**`, `prompts/**`, instruction files; `other`), the SHA-256 and size of the bytes to write, and the unsafe `settings.json` keys. When `review` is non-empty `confirm(plan)` is called once; a false answer, or no `confirm` at all, -> `ABORTED` (fail closed). A dry run skips it. `needsReload` true when any `extensions/**`, `skills/**`, `prompts/**`, `themes/**`, `settings.json`, `mcp.json`, or `AGENTS.md`-like file changed. After success `saveState` with remote digests.
- `init`: with `gistId` -> `get` it, verify the manifest parses (or the gist is empty), then compare `snapshot.owner` with `client.viewer()` (case-insensitive): a different or unknown owner needs `opts.confirmForeign(owner)` to return true, else `ABORTED`. Save config gistId. Without -> `create` a secret gist containing only an empty-files manifest placeholder, description `pi-gist-sync: Pi agent settings`, save config. No state until the first push/pull.
- `status`: both-way plan, never writes. `ahead`/`behind`/`conflicts` as path lists. Not linked -> `linked: false` and a hint line.
- `scanCandidates` delegates to `listCandidates`. `unlink` clears config gistId and state (never touches the gist or local files).
- Errors are `GistSyncError`. Lines in `Report.lines` are short, plain, no ANSI.

Tests for sync use a temp agent dir plus an in-memory fake `GistClient` (not the HTTP server); every security rule above has a test that fails without it. Cover: first push, noop push, edit+push, remote edit+pull, both-edited conflict, force, prune, settings machine-local preservation, credential skipped vs encrypted round-trip, path-traversal manifest rejected with nothing written, digest-mismatch rejected, backup created, dry-run writes nothing.

### U5 `command-ui`: `src/command.ts`, `extensions/index.ts`, `test/command.test.ts`

```ts
export interface CommandIO {
  notify(message: string, level: "info" | "warning" | "error"): void;
  confirm(title: string, message: string): Promise<boolean>; // false when no UI
  input(title: string, placeholder?: string): Promise<string | undefined>;
  hasUI: boolean;
  reload(): Promise<void>;
  exec(cmd: string, args: string[]): Promise<{ stdout: string; code: number }>;
}
export function parseArgs(args: string): { sub: string; flags: Set<string>; rest: string[] };
export function runCommand(args: string, io: CommandIO, deps?: Partial<{ api: SyncApi; env: NodeJS.ProcessEnv; agentDir: string; client: GistClient; home: string }>): Promise<void>;
export const SUBCOMMANDS: readonly string[]; // init status push pull scan roots unlink help
```

Commands: `/gist-sync init [gist-id] [--yes]`, `status`, `push [--force] [--dry-run]`, `pull [--force] [--dry-run] [--prune] [--yes]`, `scan`, `roots [add <name> <dir> <glob...> | remove <name>]`, `unlink`, `help` (default). Unknown subcommand -> help, level warning. A flag the subcommand does not take, or an extra argument, is rejected with a warning and nothing runs. `command.ts` imports `sync`, `config` and `gist-client` statically (no dynamic `import()`). `runCommand` never throws: it catches `GistSyncError` and unknown errors, calls `notify(message, "error")` (message must not contain the token; strip anything matching a token pattern). It resolves the token via `resolveToken` (ghAuthToken = `io.exec("gh", ["auth","token"])`, trimmed, undefined on non-zero code), builds `SyncEnv` (`hostname` from `os.hostname()`, `version` from package.json read via `import.meta.url`, `now: () => new Date()`), passphrase = `PI_GIST_SYNC_PASSPHRASE` env else (only when config.credentials is `encrypt` and a command needs it) `io.input`. Pull `confirm`: when `plan.review.length > 0` show the changes grouped by tier (every tier in full; a gist caps the list at 300), each with its action, settings keys and the first 12 hex characters of its SHA-256, via `io.confirm` (supply `--yes` to skip; with no UI and no `--yes` -> abort with a clear message). Init `confirmForeign`: `--yes` links without asking; with a UI `io.confirm` names the owner; with no UI and no `--yes` it aborts; after a successful pull with `needsReload` ask `io.confirm("Reload Pi?")` and call `io.reload()` (no UI: tell the user to run /reload). Output: `notify(lines.join("\n"), "info")`.

`extensions/index.ts`: thin glue. `export default function (pi: ExtensionAPI)`: `pi.registerCommand("gist-sync", { description, getArgumentCompletions, handler: (args, ctx) => runCommand(args, io(ctx)) })`. Completions are nested: subcommands, then `roots add|remove`, then (async, from the config) root names after `roots remove`. `io(ctx)`: map `ctx.ui.notify/confirm/input`, `ctx.hasUI`, `ctx.reload()`, `pi.exec`. If `config.checkOnStart` is true, on `session_start` with `reason === "startup"` only, fire-and-forget (no await, swallow all errors, 5 s timeout) a `status` and notify only when `behind.length > 0`. Never start work from the factory itself. Verify the exact `ExtensionAPI`/`ExtensionCommandContext` signatures in `node_modules/@earendil-works/pi-coding-agent` types and in the Pi extensions docs (`docs/extensions.md` inside the `@earendil-works/pi-coding-agent` package) before coding.

### U6 `repo-meta`: `README.md`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/ISSUE_TEMPLATE/bug_report.md`

- README (the npm and gallery landing page): one-line pitch, install (`pi install npm:pi-gist-sync`, and `pi install git:github.com/moimikey/pi-gist-sync`), 60-second quickstart (`/gist-sync init`, `push`, then on a second machine `init <gist-id>` + `pull`), command table, "What syncs" table (derive from `DEFAULT_INCLUDE`/`DEFAULT_EXCLUDE`/`CREDENTIAL_GLOBS`/`MACHINE_LOCAL_KEYS` in this spec), "How extensions are synced" (packages travel inside `settings.json`; Pi reinstalls missing packages on next start or `/reload`; local extension source under `extensions/` travels as files), configuration (`gist-sync.json` fields, env vars `PI_GIST_SYNC_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`/`PI_GIST_SYNC_PASSPHRASE`), conflict model (three-way, backups dir), security model (secret gists are unlisted not private; credentials skipped by default; encrypt mode details; pull prompts before extension code changes; path traversal checks), limits (300 files, 1 MiB per file, text via base64), FAQ, comparison note naming `@narumitw/pi-sync` (Git/WebDAV/S3/R2) as the git/S3 alternative; this one is Gist-only and zero-dependency. Keep it scannable: tables over bullets where they fit. No marketing fluff, no em dashes.
- CHANGELOG: Keep a Changelog format, `## [0.1.0] - 2026-11-05` (Pi reads `## [x.y.z]` headings).
- SECURITY: how to report privately (GitHub private vulnerability reporting), threat model summary, supported versions.
- LICENSE: MIT, `Copyright (c) 2026 Michael Hertzberg`.
- ci.yml: on push/PR to main; matrix Node 22 and 24; `npm ci`, `npm run typecheck`, `npm test`; pin actions by commit SHA with the tag in a comment; `npm ci --ignore-scripts`; `permissions: contents: read`.
- release.yml: on tag `v*`; a `check` job with no secrets verifies the tag is on `main` and matches the package.json version, then runs `npm ci --ignore-scripts` and `npm run check`; a `publish` job (`needs: check`, `permissions: contents: read, id-token: write`, no install, no cache) runs `npm publish --provenance --access public --tag latest`, or `--tag next` for a tag containing a hyphen; uses `secrets.NPM_TOKEN`. Actions pinned by SHA.
- Do NOT claim features that are not in this spec. `package.json` `engines.node` matches Pi's own minimum (`>=22.19.0`).

## Verification

e2e tests over the real modules plus the fake HTTP server (`test/e2e.test.ts`, `test/e2e-roots.test.ts`); a loading check inside real Pi with a temp `HOME` and `PI_CODING_AGENT_DIR`; security and docs-accuracy reviews.

## Roots: syncing directories outside the agent dir

Contract for the second feature (types are already in `src/types.ts`: `RootConfig`, `SyncConfig.roots`, `SkipReason "native-binary"`, `SyncEnv.home`, `PullReview.dest`). The hard rules above apply, and tests never touch the real `~` either.

### Model

| Fact | Rule |
|---|---|
| A root maps a name to a local dir: `roots: { "local-bin": { dir: "~/.local/bin", include: ["piwt", "wtw"], exclude: [] } }` | Gist path of a file is `@<name>/<rel>`, e.g. `@local-bin/piwt`. Gist file name is `encodePath` of that, as for any path. |
| Roots exist ONLY in the local `gist-sync.json` | The gist can never create, change or select a root or a directory. A remote path under an unconfigured root is skipped and reported, never an error. |
| Root name | `ROOT_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/`. Anything else is a problem and the root is dropped. |
| `@` is reserved at the top level of the agent dir | A local agent-dir entry whose top-level name starts with `@` is never synced (skipped, reason `unreadable`, detail says the prefix is reserved). Remote agent-dir-style paths cannot start with `@` unless they are root paths. |
| Everything under a root is code tier | Always `tier: "code"`, listed in full in the approval prompt, never auto-applied, never truncated. `PullReview.dest` carries the absolute destination; the prompt shows any non-ASCII character in a root path or destination as a `\u{..}` escape. |
| Reload | `needsReload` for a root path follows `affectsReload(rel)` on the part after `@name/`. |

### U1 `roots-core`: `src/roots.ts` (new), `src/config.ts`, `src/scan.ts`, `test/roots.test.ts`, `test/config.test.ts`, `test/scan.test.ts`

```ts
// roots.ts
export const ROOT_PREFIX = "@";
export const ROOT_NAME: RegExp;
export interface ResolvedRoot { name: string; dir: string /* absolute, realpath'd */; include: readonly string[]; exclude: readonly string[]; id?: string /* dev:ino at resolve time */; credPrefix: string }
export function isRootCredential(root: Pick<ResolvedRoot, "credPrefix">, rel: string): boolean; // isCredentialPath(rel) OR isCredentialPath(credPrefix + "/" + rel)
export interface RootProblem { name: string; message: string }
export function splitRootPath(gistPath: string): { name: string; rel: string } | undefined; // "@a/b/c" -> {name:"a", rel:"b/c"}; undefined for non-root paths and for "@a" or "@a/" (no rel)
export function joinRootPath(name: string, rel: string): string;
export function expandHome(dir: string, home: string): string; // "~" and "~/x" only; "~user" is NOT expanded
export function resolveRoots(config: SyncConfig, ctx: { agentDir: string; home: string }): Promise<{ roots: Map<string, ResolvedRoot>; problems: RootProblem[] }>;
```

`resolveRoots` rules (a failing root is dropped with a `problem`, never throws, never blocks the other roots): valid name; `dir` absolute after `expandHome`; `include` non-empty array of strings; dir exists and is a directory (`realpath` it, ENOENT is a problem not a crash); refuse realpath equal to `/`, to `home`, or to an ancestor of `home`; refuse overlap with the agent dir in either direction (equal, root inside agentDir, agentDir inside root); refuse overlap between two roots (equal, nested either way; the later name in sort order is dropped). Every containment check runs on realpath strings AND on identity: A holds B when A's `dev:ino` is B's or one of B's ancestors', or when A joined with a tail of B's path (walked with `lstat`, no symlinks) has B's `dev:ino`. That catches aliases such as macOS `/System/Volumes/Data/...` firmlinks and bind mounts. A resolved root records its `dev:ino` as `id`, and as `credPrefix` its realpath relative to `realpath(home)` with POSIX separators (`.kube`, `.config/gh`), or outside home its absolute path without the leading separator; credential globs such as `**/{.,}kube/config` name the dir, so a root at `~/.kube` that includes `config` must still match. Output order is stable (sorted by name).

`config.ts`: `SyncConfig.roots` default `{}`. `loadConfig` validates `roots` per entry (non-record, non-string `dir`, non-string-array `include`/`exclude` -> that entry dropped; build with `Object.fromEntries` so a `__proto__` name is an own key that fails `ROOT_NAME` and is dropped). `saveConfig` always writes `roots`. New `PORTABLE_EXCLUDE` (the part of `DEFAULT_EXCLUDE` that is not agent-dir specific: `**/node_modules/**`, `**/.git/**`, `**/.DS_Store`, `**/*.bak`, `**/*.bak-*`, `**/*.log`, `**/*.jsonl`, `**/*.tmp`, `**/__pycache__/**`, `**/.ruff_cache/**`) always applies to every root on top of its own `exclude`. `isAlwaysExcluded` applies to the root-relative path as well.

Default list changes (agent dir; these are new-link defaults, an existing `gist-sync.json` keeps its own lists):
- `DEFAULT_INCLUDE` adds `bin/**` and `*/settings.json` (per-extension settings such as `mf-plan/settings.json`).
- `DEFAULT_EXCLUDE` adds `bin/fd`, `bin/rg`, `bin/fd.exe`, `bin/rg.exe` (Pi downloads them), `**/last-seen-version.json`, `**/changelog-state.json` (per-machine state), and runtime dirs `ayu/**`, `pi-herdsman/**`, `missions/**`, `pi-warden/**`, `pi-sync/**`, `pi-cache-optimizer-stats.d/**`, `pi-pretty/**`, `memory/recovery/**`, `memory/daily/**`.
- `memory/**` stays unmatched by default (opt-in).

`scan.ts`: new `export async function scanRoot(root: ResolvedRoot, config: SyncConfig, detect: (bytes: Uint8Array, path: string) => string[]): Promise<{ files: ScannedFile[]; skipped: SkippedFile[] }>` that reuses the existing walk and read logic with `include = root.include`, `exclude = [...PORTABLE_EXCLUDE, ...root.exclude]`, `maxFileBytes = config.maxFileBytes`, and returns every `path` (in `files` and `skipped`) as `@name/rel`. `detect` receives the root-relative path. `scanAgentDir` must skip top-level `@*` names. Both scans skip native executables with `reason: "native-binary"` (check magic bytes: ELF `7F 45 4C 46`; Mach-O thin `FEEDFACE`, `FEEDFACF`, `CEFAEDFE`, `CFFAEDFE` and fat `BEBAFECA`, `CAFEBABF`, `BFBAFECA`, and `CAFEBABE` only when the next big-endian word is below 30, since a Java class has its version (45+) there; PE: `MZ` with a valid `PE\0\0` at `e_lfanew`) before the sensitivity check, and never mark a text script that merely starts with those letters. Symlinks inside a root are skipped exactly as in the agent dir. `listCandidates` stays agent-dir only; add `listRootCandidates(root, config): Promise<string[]>` returning `@name/rel` paths.

### U2 `roots-sync`: `src/sync.ts`, `test/sync.test.ts`

Integrates roots into push, pull, status, scanCandidates and unlink using the U1 API.
- Resolve roots once per command: `resolveRoots(config, { agentDir: env.agentDir, home: env.home ?? homedir() })`. Put `roots` and `agentDir` in the `Scope`/`View` so every path decision can see them. Root `problems` become report lines (`Root "x" ignored: <message>`) in push, pull and status; a problem root contributes no files and its remote entries are skipped (never deleted, never pushed).
- `scanLocal`: also `scanRoot` each resolved root and merge into the same `files`/`skipped` maps (paths are already `@name/rel`). Credential and secret policy is identical to agent-dir files, evaluated with `isRootCredential(root, rel)` (the root-relative path, and the same path under `credPrefix`); the plain-credential refusal and the 0600 pin on pull use it too. `canonicalBytes` must only special-case the agent-dir `settings.json`, never `@x/settings.json`.
- `isSyncable`/`outOfScope`: a root path is syncable iff its root is configured and resolved, `assertSafeRelPath(rel)` passes, `rel` matches the root include, and not the root exclude, `PORTABLE_EXCLUDE` or `isAlwaysExcluded(rel)`. A path starting with `@` whose root is not configured is out of scope with a `SkippedFile { reason: "excluded", detail: 'root "<name>" is not configured' }`. In `status` and `pull` output add ONE hint line per such root: `N file(s) under root "<name>" were not applied. Configure it locally with: /gist-sync roots add <name> <dir> <glob...>`. A non-root path that starts with `@` is out of scope (never writable).
- `resolveTarget`: becomes root-aware. For a root path the base dir must still have the `id` it had when resolved (a swapped parent such as `~/.local` is refused), and no component (base included) may have the `dev:ino` of the agent dir or one of its ancestors. The base dir is the resolved root dir and the confinement check, per-component `lstat` symlink refusal and "a directory is in the way" logic run against that base with `rel`. For agent-dir paths nothing changes. `assertSafeRelPath` runs on the full path and on `rel`. `writeAtomic`, `backup` and the delete step must use it, so root files get the same atomic write, mode clamp, fsync, backup and symlink protections. Backups of root files go to `gist-sync-backups/<stamp>/@name/rel` inside the agent dir.
- `tierOf`: any root path is `"code"`. `reviewFor` never exempts a root path, and exempts `keybindings.json` or `themes/**` only when the mode to be written has no execute bit (`(mode & 0o111) === 0`) or the action is a delete; an executable one goes through `tierOf`, which makes it `"code"`. `PullReview.dest` is the absolute destination for root paths. `affectsReload` for root paths applies to `rel`.
- `unlink` must keep `roots` (it re-saves the config with an explicit field list). `init` keeps them via `{ ...config, gistId }`.
- `scanCandidates` returns agent-dir candidates plus `listRootCandidates` for each resolved root, all as gist-style paths.
- Never read a root dir from the manifest, never create a root dir that does not exist (a missing root dir is a problem line, not `mkdir -p` of an arbitrary path; subdirectories below an existing root dir are created as needed).

Tests (temp dirs for `agentDir` AND `home`, pass `env.home`): push and pull round trip of root files with exec bit preserved and group/world write dropped; hostile manifest paths `@local-bin/../x`, `@local-bin/a/../../x`, `@local-bin` alone, `@Local-Bin/x`, `@unknown/x`, agent-dir path `@local-bin/x` with no configured root: nothing written outside the root, nothing at all written when any entry is bad; unconfigured root yields the hint line and the file is not written; symlink inside the root dir and a symlinked subdirectory are refused; root dir that is a symlink to a real dir works; root overlapping the agent dir or equal to home is dropped with a problem line; approval gate: root files are tier `code`, always in `plan.review`, `dest` set, never silently applied, `--yes`-less pull with no confirm refuses; backup path under `@name/`; credential-looking file in a root is skipped under `credentials: "skip"`; native binary in a root is skipped; `@weird` top-level local agent-dir entry is not pushed; `unlink` preserves roots; a stale `.bak-*` file in a root is excluded; status reports root files ahead/behind.

### U3 `roots-command`: `src/command.ts`, `extensions/index.ts`, `test/command.test.ts`

- New subcommand `roots` (add to `SUBCOMMANDS`, help text, completions): `/gist-sync roots` lists each root (name, dir, include globs, and `ok` or `ignored: <problem>`; every field passes through `oneLine` so a hand-edited newline cannot forge a line); `/gist-sync roots add <name> <dir> <glob>...` requires a valid name, a dir, and AT LEAST ONE include glob (refuse `add` with none; there is no "sync everything" default), validates by running `resolveRoots` on the would-be config and refusing to save when the new root has a problem or knocks out a root that resolved before, refuses a catch-all include (first segment `*` or `**`) when the dir is `~/.config`, `~/.ssh`, `~/.aws`, `~/.kube`, `~/.docker` or `~/.gnupg`, preserves every other config field, saves with `saveConfig`, and prints `Root "<name>" added: <dir> (<n> include glob(s)). Everything under a root needs approval on pull.`; `/gist-sync roots remove <name>` removes it from the config only (never touches the gist or files). Unknown or missing arguments print usage with level warning and change nothing.
- `baseEnv` must pass `home` (default `os.homedir()`; add an injectable `deps.home` for tests) into `SyncEnv`.
- `describeReview`/`reviewLine`: for an entry with `dest`, print `<action> <path> -> <dest>` instead of the bare path (sanitized like other remote-controlled text). Code tier remains untruncated.
- `scan` output already lists whatever `sync.scanCandidates` returns; keep it working and make sure root candidates are shown.
- All existing behavior, redaction and flag validation stay. Roots subcommands need no token and no gist link.

### U4 `roots-docs`: `README.md`, `SECURITY.md`, `CHANGELOG.md`, `CONTRIBUTING.md` (only if it needs a mention)

Document the feature accurately against this spec: a "Roots" section (what, why, config shape, `roots add` flow, second-machine flow including that the receiving machine must configure the root first and `status` tells it how, examples for `~/.local/bin` scripts and `~/.config` files), the updated "What syncs" table (new defaults above), Limits (native binaries are skipped, 1 MiB per file, no sync of symlinks, scripts only), Security model and SECURITY.md threat rows (roots are local-only and the gist cannot pick a directory; root files are always approval-gated code tier and shown with their destination; a root on `PATH` means a pulled script can shadow other commands in every shell, so review the list; without a passphrase the prompt is the only authentication; overlap and `/`, `$HOME` refusals), CHANGELOG under `## [Unreleased]` `### Added`. Keep it scannable, tables over bullets, no marketing, no em dashes. Do not claim anything the spec does not say.
