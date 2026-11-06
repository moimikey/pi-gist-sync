# pi-gist-sync

Sync your Pi agent config (settings, extensions, skills, prompts, themes, instructions) between machines through one multi-file GitHub Gist. Gist-only, zero runtime dependencies.

## Install

```bash
pi install npm:pi-gist-sync
# or straight from GitHub
pi install git:github.com/moimikey/pi-gist-sync
```

Requires Node 22.19 or newer, the same as Pi.

You need a GitHub token with the `gist` scope. The extension finds one in this order:

| Order | Source |
|---|---|
| 1 | `PI_GIST_SYNC_TOKEN` |
| 2 | `GH_TOKEN` |
| 3 | `GITHUB_TOKEN` |
| 4 | `gh auth token` (GitHub CLI) |

## Quickstart

On the first machine, inside Pi:

```text
/gist-sync init
/gist-sync push
```

`init` creates a secret gist and saves its ID as `gistId` in `gist-sync.json`. The ID is the last part of the gist's URL on gist.github.com.

On a second machine, after installing the extension:

```text
/gist-sync init <gist-id>
/gist-sync pull --dry-run
/gist-sync pull
```

If the second machine already has its own `settings.json`, the first pull reports a conflict on purpose. `pull --force` resolves it, and your local copy is backed up first. The first pull also asks you to approve everything except display-only files, because that content can run code or steer the model. See "Approval gate" below.

## Commands

| Command | What it does |
|---|---|
| `/gist-sync init [gist-id] [--yes]` | With no ID, creates a secret gist and links it (relinks if already linked). With a gist ID or gist.github.com URL, links that gist if its manifest is valid or absent. A gist owned by another account needs a confirmation, or `--yes`. |
| `/gist-sync status` | Compares both directions and lists what is ahead, behind or in conflict. Never writes. |
| `/gist-sync push [--force] [--dry-run]` | Uploads local changes in one API update. Local deletions since the last sync are removed from the gist. Refuses a public gist. |
| `/gist-sync pull [--force] [--dry-run] [--prune] [--yes]` | Applies remote changes locally, asking before anything outside the display-only set and backing up every file it overwrites or deletes. |
| `/gist-sync scan` | Lists files in the agent dir that your `include` and `exclude` globs do not match. |
| `/gist-sync unlink` | Clears the linked gist ID and the sync state. Never touches the gist or your local files. |
| `/gist-sync help` | Shows usage. This is the default; an unknown subcommand shows it too. |

| Flag | Applies to | Effect |
|---|---|---|
| `--dry-run` | push, pull | Prints the plan and writes nothing. |
| `--force` | push, pull | Resolves conflicts. Push: local wins. Pull: remote wins, local copy backed up first. Also accepts a gist manifest older than the last sync. |
| `--prune` | pull | Also deletes local files that were removed remotely since the last sync. |
| `--yes` | init, pull | init: links a gist owned by another account without asking. pull: skips the approval prompt. |

A flag a command does not take (for example `--force` on `status`) or an extra argument is rejected with a warning and nothing runs.

## What syncs

The agent dir is `PI_CODING_AGENT_DIR` if set, otherwise `~/.pi/agent`. Paths below are relative to it.

| Group | Globs |
|---|---|
| Settings and config | `settings.json`, `keybindings.json`, `mcp.json`, `models.json`, plus any other top-level `*.json` (for example `mcp-adapter.json`) |
| Instructions | `AGENTS.md`, `AGENTS.override.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`, `SYSTEM.md`, `APPEND_SYSTEM.md`, plus any other top-level `*.md` |
| Extensions, skills and more | `extensions/**`, `skills/**`, `prompts/**`, `themes/**`, `agents/**` |

| Not synced | Globs |
|---|---|
| Always, regardless of config, in both directions | `gist-sync.json`, `gist-sync.state.json`, `gist-sync-backups/**`, `**/.git/**`, `**/node_modules/**`, plus Pi's own per-machine files `trust.json`, `oauth.json` and `crashes.json` (matched case-insensitively) |
| Excluded by default | `**/node_modules/**`, `**/.git/**`, `**/.DS_Store`, `**/*.bak`, `**/*.bak-*`, `**/*.log`, `**/*.jsonl`, `**/*.tmp`, `*-cache.json`, `*-store.json`, `**/__pycache__/**`, `**/.ruff_cache/**`, `sessions/**`, `subagents/**`, `checkpoints/**`, `jobs/**`, `tmp/**`, `npm/**`, `git/**`, `memory-archive/**` |
| Credentials, skipped by default (any depth, any letter case) | `**/auth.json`, `**/*-auth.json`, `**/oauth.json`, `**/*credentials*.json`, `**/*token*.json`, `**/.env`, `**/.env.*` |
| Symlinks | Skipped, never followed |
| Unsupported file names | A name with a control or invisible character, a `:`, a trailing dot or space, a Windows device name such as `CON`, more than 32 levels, or over 1024 bytes in total or 255 in one part is skipped on push and rejected on pull |
| Unparseable `settings.json` | Never uploaded (reported as unreadable), because its machine-local keys could not be stripped |
| Machine-local `settings.json` keys | `lastChangelogVersion`, `extensionChangelogVersions`, `sessionDir`, `shellPath`, `httpProxy`, `selfUpdateCommand`, `npmCommand`, `defaultProjectTrust`, `deviceId`, `trackingId` |

The machine-local keys are never pushed and your local values are kept when a pull rewrites `settings.json`. They are per-machine or security-sensitive: a remote edit cannot widen trust or swap the updater.

## How extensions are synced

| Kind | How it travels |
|---|---|
| Installed packages | The package list lives in `settings.json` (`packages` and `extensions`), so it syncs with that file. Pi reinstalls missing packages on its next start or on `/reload`. The `npm/` and `git/` directories are excluded by default, so installed package copies stay out of the gist. |
| Local extension source | Files under `extensions/` sync as ordinary files. |

## Approval gate

Pi does not ask before it runs code or follows instructions, so a pull applies only a short allowlist without asking:

| Applied without asking | Everything else asks first |
|---|---|
| `keybindings.json`, `themes/**`, and `settings.json` changes limited to display and behavior keys (`theme`, `quietStartup`, `compaction` and similar; the list is `SAFE_SETTINGS_KEYS` in `src/settings-merge.ts`) | `extensions/**`; `mcp.json` and `models.json`; `settings.json` keys such as `packages`, `extensions`, `skills`, `shellCommandPrefix`, `externalEditor` or `defaultProvider`, and any key Pi adds later; `skills/**`, `agents/**`, `prompts/**` and instruction files such as `AGENTS.md`; third-party config and any other file. Deletes with `--prune` ask too. |

The prompt groups the changes as code Pi runs, instructions that steer the model, and other files. Each line gives the action, the changed `settings.json` keys and the first 12 characters of the SHA-256 of the bytes that would be written, so an unexpected edit stands out. The code tier is always listed in full; the other two tiers show their first 8 entries and a count. `--yes` skips the prompt. With no UI and no `--yes` the pull aborts. A caller of the library API that passes no `confirm` handler is refused whenever something needs approval. Run `pull --dry-run` first to see the list.

After a pull that changes extensions, skills, prompts, themes, `settings.json`, `mcp.json` or an instruction file, it offers to reload Pi. With no UI it tells you to run `/reload`.

## Configuration

Settings live in `gist-sync.json` in the agent dir. It is machine-local and never synced. Missing or invalid fields fall back to the defaults. `init` and `unlink` write all fields, including the full default `include` and `exclude`, so later changes to the defaults do not reach an existing file.

| Field | Default | Meaning |
|---|---|---|
| `gistId` | none | The linked gist. Set by `init`, cleared by `unlink`. |
| `include` | the globs in "What syncs" | Paths to sync. |
| `exclude` | the default exclusions | Paths to leave out, applied after `include`. |
| `credentials` | `"skip"` | `"skip"` or `"encrypt"`. See the security model. |
| `maxFileBytes` | `1048576` | Files larger than this are skipped with a warning, in both directions. |
| `checkOnStart` | `false` | When `true`, Pi startup (not `/reload` or session switches) checks the linked gist in the background for up to 5 s and notifies only if it has changes you have not pulled. Never prompts. Errors are ignored. |

| Environment variable | Purpose |
|---|---|
| `PI_GIST_SYNC_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN` | GitHub token, checked in that order. |
| `PI_GIST_SYNC_PASSPHRASE` | Passphrase for encrypted credentials and manifest signing. If unset, `credentials` is `"encrypt"` and a UI exists, Pi prompts (typed text is visible). Session-start checks never prompt. With `credentials: "skip"`, set the variable to decrypt remote encrypted files. |
| `PI_CODING_AGENT_DIR` | Agent dir to sync instead of `~/.pi/agent`. A leading `~` is expanded. |

## Conflict model

Each path is planned three ways, like `git merge`, against the digests recorded at your last sync:

| Situation | Result |
|---|---|
| Source and target are identical | Unchanged |
| Target has not changed since the last sync | Source wins: add, update or delete |
| Only the target changed since the last sync | Unchanged. The target's change is never reverted. |
| Both changed, and they differ | Conflict |

On the first sync there is no last-sync record, so a file present on both sides with different content is a conflict.

| Command | Source | Target |
|---|---|---|
| `push` | local | gist |
| `pull` | gist | local |

Conflicts stop the command and list the paths. `--force` resolves them. Before a pull overwrites or deletes anything, the old file is copied to `gist-sync-backups/<ISO timestamp, with : replaced by ->/<path>`, including a file that appeared while the approval prompt was open. Backups are never pruned. A deletion on the remote reaches your machine only with `--prune`; otherwise the file is listed as local-only. Files that exist only locally and were never synced are never deleted. The gist's own revision history also keeps earlier versions.

## Security model

| Topic | Behavior |
|---|---|
| Gist visibility | Always created as a secret gist. Secret means unlisted, not private: anyone with the URL can read it. A push to a public gist is refused. |
| Gist ownership | `init <id>` compares the gist's owner with your token's account. A gist owned by someone else, or one whose owner cannot be checked, needs a confirmation (`--yes` with no UI), because its owner controls the files you pull. |
| Credentials | Credential files and files the secret scanner flags are skipped by default and reported as `credential` or `secret-detected`. A plain credential entry in the gist is never applied, in any mode. |
| Secret scanner | Best effort. Flags GitHub, AWS, Slack, OpenAI, Anthropic, Google, Stripe, npm, OpenRouter, Groq and Hugging Face tokens, JWTs, passwords in URLs, PEM private keys, Bearer tokens and `key = value` assignments. NUL bytes are ignored and JSON escapes are decoded before matching, so UTF-16 text and `\u0067hp_...` are still seen. Placeholders and env references are ignored. |
| Encrypt mode | With `credentials: "encrypt"`, those files are uploaded encrypted with AES-256-GCM and a fresh 12-byte IV per file. The key comes from your passphrase through scrypt (N=2^17, r=8, p=1, random 16-byte salt stored in the manifest) and HKDF splits it into separate encryption and MAC keys. The path is bound into each ciphertext and digest, so an entry cannot be re-pointed at another path. Their manifest digests are HMAC-SHA256 over the path and bytes. |
| Manifest signature | In encrypt mode with a passphrase, every push signs the whole manifest (HMAC-SHA256, bound to the gist ID), and a pull with the passphrase checks it before anything else. Someone who can write to the gist but lacks the passphrase cannot change paths, modes, names or digests. After one verified sync a machine refuses an unsigned manifest, and refuses a signed one it cannot verify. Without a passphrase nothing authenticates the manifest and the approval gate is the control. Pushing to a signed gist needs the passphrase. |
| Rollback | A manifest with a lower revision than this machine last synced is refused. `--force` accepts it. |
| What encryption does not hide | Paths, sizes, modes, the host name and timestamps in the manifest stay readable. A lost passphrase cannot be recovered. |
| Wrong or missing passphrase | A wrong passphrase, tampered ciphertext or a modified signed manifest fails with a bad-passphrase error. With no passphrase on pull, encrypted files are listed as undecryptable and skipped while everything else still applies, unless this machine already verified the gist. |
| Approval gate | See "Approval gate". Everything but display-only changes needs a yes. |
| Remote scope | A pull never writes or deletes a path your include and exclude rules rule out, and cannot overwrite credential files. Remote files over `maxFileBytes` are skipped. |
| Path safety | Manifest paths that are absolute, contain an empty, `.` or `..` segment, backslashes, NUL bytes, control or invisible characters, a colon, a drive letter, a trailing slash, dot or space, or a Windows device name are rejected, as are paths over 32 levels, 1024 bytes in total or 255 in one part, and manifests with over 300 files. Paths that differ only in case, or are both a file and a directory, are rejected. A write must stay inside the agent dir, so symlinked parent directories are skipped. A gist file name must be the path's own encoding. |
| Integrity | A pull verifies the digest of every file it will write before writing any file. One mismatch fails the whole pull with nothing written. An invalid `settings.json` in the gist fails it too. |
| Permissions | Pulled files lose group and world write bits and any setuid or setgid bit, always keep owner read and write, and credentials are written 0600, whatever mode the manifest claims. |
| Token | Sent only to the GitHub API host and `gist.githubusercontent.com`, and kept out of error messages. Downloads over 64 MiB per file are refused. |
| Local files | `gist-sync.json` and `gist-sync.state.json` are written with mode 0600. |

The full threat model and how to report a vulnerability are in [SECURITY.md](SECURITY.md).

## Limits

| Limit | Behavior |
|---|---|
| 300 files per gist | A push that writes more than 300 files in one update fails with a too-many-files error before the update request. GitHub rejects a gist that would exceed 300 files in total. |
| Two machines pushing at once | A gist has no conditional write. A push re-reads the gist right before writing and aborts with a conflict error if another push landed in the meantime, which narrows the race to a single round trip but cannot close it. Do not push from two machines at the same moment. |
| 1 MiB per file (default) | Larger files are skipped with a warning. Raise `maxFileBytes` to change it. |
| Text only | A file that is not valid UTF-8, or contains a NUL byte, is stored as base64. |
| No empty files in gists | Empty files are recorded in the manifest only. |
| No whitespace-only files in gists | Stored as base64. |
| No `/` in gist file names | Paths are encoded flat (`/` becomes `%2F`, `%` becomes `%25`) and decoded on pull. A file named `_pi-gist-sync.json` is stored as `%5Fpi-gist-sync.json`. |

## FAQ

**Is my gist private?** No. It is secret, which means unlisted. Do not share the URL, and leave `credentials` on `skip` unless you use a strong passphrase.

**Does it need the GitHub CLI?** No. `gh auth token` is only the last fallback after the environment variables.

**Why did my first pull on a second machine report a conflict?** That machine already had a `settings.json` that differs from the gist, and there is no earlier sync to say which side is right. Run `pull --force`; the old file goes to `gist-sync-backups/` first.

**Why does every pull ask me to approve things?** Pi runs extensions and follows skills and instruction files without asking, so anything outside the display-only set could run code or steer the model. Read the list, check the hashes against the gist on GitHub, then confirm. `--yes` skips the prompt for scripts.

**I deleted a file locally. Will it come back?** Not from a pull: a change made only on your side is never reverted. The next push removes the file from the gist. In the other direction, a file deleted remotely is removed locally only with `pull --prune`.

**How do I get an older version back?** Look in `gist-sync-backups/` for files a pull replaced, or in the gist's revision history on GitHub.

**Does it sync my sessions?** No. `sessions/**` is excluded by default, along with other bulky or per-machine directories.

**Does it run on its own?** Only if you set `checkOnStart` to `true`, and then it only notifies. Pushing and pulling always happen when you run the command.

**How do I stop syncing?** Run `/gist-sync unlink`. The gist and your files stay as they are.

## Compared with @narumitw/pi-sync

[`@narumitw/pi-sync`](https://www.npmjs.com/package/@narumitw/pi-sync) syncs through Git, WebDAV, S3 or R2. Use it if you want one of those backends. pi-gist-sync is Gist-only and has no runtime dependencies, which keeps setup to a single GitHub token.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md). Released under the [MIT license](LICENSE).
