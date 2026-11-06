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
- Only edit files you own (table below). Other modules may not exist yet; code against the signatures here, and `ls src/` later to find them landed. Do not create stubs for files you do not own.
- Do not run `git commit` or `git add`.

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
- A file is included when it matches `include` and not `exclude`. Files over `maxFileBytes` -> skipped `too-large` (do not read them). Read errors -> `unreadable`.
- `sensitive` = `isCredentialPath(path)` OR `detect(bytes, path).length > 0`. `detect` takes the path so the sync layer can scan the bytes it will upload (canonical `settings.json`, not the raw file). Scan returns sensitive files in `files`; the sync layer applies the credential policy.
- `DEFAULT_INCLUDE`: `settings.json`, `keybindings.json`, `mcp.json`, `models.json`, `AGENTS.md`, `AGENTS.override.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `extensions/**`, `skills/**`, `prompts/**`, `themes/**`, `agents/**`, plus top-level `*.json` and `*.md` (third-party extension config such as `mcp-adapter.json`).
- `DEFAULT_EXCLUDE`: `**/node_modules/**`, `**/.git/**`, `**/.DS_Store`, `**/*.bak`, `**/*.bak-*`, `**/*.log`, `**/*.jsonl`, `**/*.tmp`, `*-cache.json`, `*-store.json`, `**/__pycache__/**`, `**/.ruff_cache/**`, `sessions/**`, `subagents/**`, `checkpoints/**`, `jobs/**`, `tmp/**`, `npm/**`, `git/**`, `memory-archive/**`. (Include/exclude are user-editable in `gist-sync.json`.)
- `CREDENTIAL_GLOBS`: `**/auth.json`, `**/*-auth.json`, `**/oauth.json`, `**/*credentials*.json`, `**/*token*.json`, `**/.env`, `**/.env.*`. Applied through `isCredentialPath(path)`, which lowercases the path first: extensions keep tokens in nested dirs and macOS ignores case.
- `MACHINE_LOCAL_KEYS` (never pushed, preserved locally on pull): `lastChangelogVersion`, `extensionChangelogVersions`, `sessionDir`, `shellPath`, `httpProxy`, `selfUpdateCommand`, `npmCommand`, `defaultProjectTrust`, `deviceId`, `trackingId`. Rationale: per-machine, or security-sensitive (a remote edit must not widen trust or swap the updater), or an installation identifier.
- Property: `canonicalSettings(mergeMachineLocal(canonicalSettings(x), y)) === canonicalSettings(x)`.
- `SAFE_SETTINGS_KEYS` is the allowlist of display and behavior keys a pull may change without approval (`theme`, `quietStartup`, `compaction`, ...). It never holds a key that runs code, loads paths or redirects traffic (`packages`, `extensions`, `skills`, `prompts`, `themes`, `shellCommandPrefix`, `externalEditor`, `defaultTools`, `codemode`, `defaultProvider`, `defaultModel`, `enabledModels`), and any key not listed needs approval.
- `defaultConfig()`: `credentials: "skip"`, `maxFileBytes: 1048576`, `checkOnStart: false`, include/exclude copies of the defaults, no `gistId`.

### U2 `core-crypto`: `src/codec.ts`, `src/secrets.ts`, `src/crypto.ts`, `src/manifest.ts`

```ts
// codec.ts
export function encodePath(path: string): string; // `%`->`%25`, `/`->`%2F`; a name equal to MANIFEST_FILE gets its first char escaped (`%5F`) so users can never shadow it
export function decodePath(name: string): string;
export function relPathProblem(path: unknown): string | undefined; // the reason a path is unsafe
export function isSafeRelPath(path: string): boolean;
export function assertSafeRelPath(path: string): void; // throws GistSyncError("BAD_MANIFEST") when relPathProblem finds one: absolute, empty, empty/`..`/`.` segment, backslash, NUL, control or invisible (Cc, Cf, U+2028/9) character, colon, drive letter, trailing slash, segment ending in dot or space, Windows device name (CON, NUL, COM1..), over 1024 bytes, a segment over 255 bytes, over 32 segments
export function sha256Hex(bytes: Uint8Array): string;
export function toGistContent(bytes: Uint8Array): { content: string; enc: Encoding } | null; // null for empty; utf8 only if valid UTF-8, no NUL, not whitespace-only; else base64
export function fromGistContent(content: string, enc: Encoding): Uint8Array;

// secrets.ts
export function detectSecrets(bytes: Uint8Array): string[]; // labels like "github-token", "private-key", "aws-access-key", "slack-token", "openai-key", "jwt", "url-password", "generic-secret-assignment"; [] when clean; never returns the secret itself. NUL bytes are dropped before matching (UTF-16 and NUL-padded text), and JSON text is also matched after decoding its escapes

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
- `push`: `get` remote manifest (if gist is empty/missing manifest and state absent, treat remote as empty). A public gist (`snapshot.public === true`) is refused with `API`, dry run included. A manifest whose revision is below `state.revision` is refused with `BAD_MANIFEST` unless `force`. The manifest signature is verified first (see "Signing"). Plan source=local, target=remote, base=state.files. Conflicts block unless `force` (throws `CONFLICT` listing paths). Deletes propagate: a file removed locally since the last sync is removed from the gist (gist revision history keeps it). Just before writing, `get` the gist again and throw `CONFLICT` (nothing written) if its manifest revision or `updatedAt` differs from the first read: a gist has no conditional write, so this narrows the lost-update race to one round trip but cannot close it. Then one `client.update` call with only changed files + new manifest (revision = remote revision + 1). Then `saveState`. `dryRun` returns the plan lines and writes nothing. Unchanged -> `noop: true`, no API write.
- Signing: when the remote manifest has `crypto`, push needs the passphrase (`NO_PASSPHRASE` otherwise) and re-signs. When it has none, push creates `crypto` params and signs if any local file is sensitive, or if `credentials` is `encrypt` and a passphrase exists. A signed manifest carries `crypto` and `mac = manifestMac(key, gistId, manifestSigningText(manifest))`. Pull and status verify the `mac` when `crypto` is present and a passphrase exists (mismatch -> `BAD_PASSPHRASE`). `SyncState.signed` is set after any verified or signed sync and never cleared: a signed-state machine refuses a manifest with no `crypto`/`mac` (`BAD_MANIFEST`) and a signed one it has no passphrase for (`NO_PASSPHRASE`). With no pin and no passphrase the signature is unchecked and a line says so.
- `pull`: plan source=remote, target=local, base=state. A `delete` plan item (removed remotely since last sync) is applied only with `prune`; otherwise the path is listed in `localOnly`. Local-only files with no base are never deleted. The first pull on a machine that already has a different `settings.json` is a conflict by design: `--force` resolves it and backs the local copy up first. Conflicts block unless `force` (local copy goes to backup first). Every overwritten or deleted file is copied to `<agentDir>/gist-sync-backups/<ISO timestamp with : replaced by ->/<path>` first. Backups cover whatever exists when the writes start, including files created while `confirm` was open. Writes are atomic (temp file fsynced, then rename), `mkdir -p` parents, and the mode is clamped to `(mode & 0o755) | 0o600`, or 0o600 for encrypted entries and credential paths. Path from the manifest is validated (`assertSafeRelPath`) AND the resolved target must stay inside agentDir (symlinked parents are skipped). A target that cannot be inspected or used (a directory in the way, a parent that is a file, any lstat error other than ENOENT) skips that one entry as `unreadable`. A plain entry on a credential path is skipped in every mode. A remote entry over `config.maxFileBytes` is skipped as `too-large`. Verify the digest after decoding (constant-time compare); mismatch -> `BAD_MANIFEST`, nothing from that run is partially trusted (verify ALL before writing ANY). `settings.json` must decode to a valid JSON object (`BAD_MANIFEST` otherwise) and is written via `mergeMachineLocal(remote, local)`. Encrypted entries with no passphrase -> listed in `undecryptable`, skipped, remaining files still apply. Approval gate: `plan.review` lists every applied change except the safe set (`keybindings.json`, `themes/**`, and `settings.json` when `unsafeSettingsChanges` is empty); each item has `action`, a `tier` (`code`: `extensions/**`, `mcp.json`, `models.json`, `settings.json`; `instructions`: `skills/**`, `agents/**`, `prompts/**`, instruction files; `other`), the SHA-256 and size of the bytes to write, and the unsafe `settings.json` keys. When `review` is non-empty `confirm(plan)` is called once; a false answer, or no `confirm` at all, -> `ABORTED` (fail closed). A dry run skips it. `needsReload` true when any `extensions/**`, `skills/**`, `prompts/**`, `themes/**`, `settings.json`, `mcp.json`, or `AGENTS.md`-like file changed. After success `saveState` with remote digests.
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
export function runCommand(args: string, io: CommandIO, deps?: Partial<{ api: SyncApi; env: NodeJS.ProcessEnv; agentDir: string; client: GistClient }>): Promise<void>;
export const SUBCOMMANDS: readonly string[]; // init status push pull scan unlink help
```

Commands: `/gist-sync init [gist-id] [--yes]`, `status`, `push [--force] [--dry-run]`, `pull [--force] [--dry-run] [--prune] [--yes]`, `scan`, `unlink`, `help` (default). Unknown subcommand -> help, level warning. A flag the subcommand does not take, or an extra argument, is rejected with a warning and nothing runs. `command.ts` imports `sync`, `config` and `gist-client` statically (no dynamic `import()`). `runCommand` never throws: it catches `GistSyncError` and unknown errors, calls `notify(message, "error")` (message must not contain the token; strip anything matching a token pattern). It resolves the token via `resolveToken` (ghAuthToken = `io.exec("gh", ["auth","token"])`, trimmed, undefined on non-zero code), builds `SyncEnv` (`hostname` from `os.hostname()`, `version` from package.json read via `import.meta.url`, `now: () => new Date()`), passphrase = `PI_GIST_SYNC_PASSPHRASE` env else (only when config.credentials is `encrypt` and a command needs it) `io.input`. Pull `confirm`: when `plan.review.length > 0` show the changes grouped by tier (the code tier in full, the other tiers capped at 8 entries plus a count), each with its action, settings keys and the first 12 hex characters of its SHA-256, via `io.confirm` (supply `--yes` to skip; with no UI and no `--yes` -> abort with a clear message). Init `confirmForeign`: `--yes` links without asking; with a UI `io.confirm` names the owner; with no UI and no `--yes` it aborts; after a successful pull with `needsReload` ask `io.confirm("Reload Pi?")` and call `io.reload()` (no UI: tell the user to run /reload). Output: `notify(lines.join("\n"), "info")`.

`extensions/index.ts`: thin glue. `export default function (pi: ExtensionAPI)`: `pi.registerCommand("gist-sync", { description, getArgumentCompletions: prefix over SUBCOMMANDS, handler: (args, ctx) => runCommand(args, io(ctx)) })`. `io(ctx)`: map `ctx.ui.notify/confirm/input`, `ctx.hasUI`, `ctx.reload()`, `pi.exec`. If `config.checkOnStart` is true, on `session_start` fire-and-forget (no await, swallow all errors, 5 s timeout) a `status` and notify only when `behind.length > 0`. Never start work from the factory itself. Verify the exact `ExtensionAPI`/`ExtensionCommandContext` signatures in `node_modules/@earendil-works/pi-coding-agent` types and in the Pi extensions docs (`docs/extensions.md` inside the `@earendil-works/pi-coding-agent` package) before coding.

### U6 `repo-meta`: `README.md`, `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `LICENSE`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/ISSUE_TEMPLATE/bug_report.md`

- README (the npm and gallery landing page): one-line pitch, install (`pi install npm:pi-gist-sync`, and `pi install git:github.com/moimikey/pi-gist-sync`), 60-second quickstart (`/gist-sync init`, `push`, then on a second machine `init <gist-id>` + `pull`), command table, "What syncs" table (derive from `DEFAULT_INCLUDE`/`DEFAULT_EXCLUDE`/`CREDENTIAL_GLOBS`/`MACHINE_LOCAL_KEYS` in this spec), "How extensions are synced" (packages travel inside `settings.json`; Pi reinstalls missing packages on next start or `/reload`; local extension source under `extensions/` travels as files), configuration (`gist-sync.json` fields, env vars `PI_GIST_SYNC_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`/`PI_GIST_SYNC_PASSPHRASE`), conflict model (three-way, backups dir), security model (secret gists are unlisted not private; credentials skipped by default; encrypt mode details; pull prompts before extension code changes; path traversal checks), limits (300 files, 1 MiB per file, text via base64), FAQ, comparison note naming `@narumitw/pi-sync` (Git/WebDAV/S3/R2) as the git/S3 alternative; this one is Gist-only and zero-dependency. Keep it scannable: tables over bullets where they fit. No marketing fluff, no em dashes.
- CHANGELOG: Keep a Changelog format, `## [0.1.0] - 2026-11-05` (Pi reads `## [x.y.z]` headings).
- SECURITY: how to report privately (GitHub private vulnerability reporting), threat model summary, supported versions.
- LICENSE: MIT, `Copyright (c) 2026 Michael Hertzberg`.
- ci.yml: on push/PR to main; matrix Node 22 and 24; `npm ci`, `npm run typecheck`, `npm test`; pin actions by commit SHA with the tag in a comment; `npm ci --ignore-scripts`; `permissions: contents: read`.
- release.yml: on tag `v*`; a `check` job with no secrets verifies the tag is on `main` and matches the package.json version, then runs `npm ci --ignore-scripts` and `npm run check`; a `publish` job (`needs: check`, `permissions: contents: read, id-token: write`, no install, no cache) runs `npm publish --provenance --access public --tag latest`, or `--tag next` for a tag containing a hyphen; uses `secrets.NPM_TOKEN`. Actions pinned by SHA.
- Do NOT claim features that are not in this spec. `package.json` `engines.node` matches Pi's own minimum (`>=22.19.0`).

## Phase 2 (after the six units land)

e2e test over the real modules plus the fake HTTP server; loading test inside real Pi (`pi -e . -p` with a temp `PI_CODING_AGENT_DIR`); security review; docs-accuracy review.
