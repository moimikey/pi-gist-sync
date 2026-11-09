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
| `/gist-sync scan` | Lists files in the agent dir and configured roots that your `include` and `exclude` globs do not match. Root paths use the `@name/rel` form. |
| `/gist-sync roots` | Lists configured roots and whether each one resolves. |
| `/gist-sync roots add <name> <dir> <glob...>` | Adds a root. `<name>` is 1 to 32 of `a-z`, `0-9` and `-`, starting with a letter or digit. `<dir>` must be absolute or start with `~/`. Refused if the name exists, if the dir fails a boundary check, if it would break another root, or if a catch-all glob (first segment `*` or `**`) targets `~/.config`, `~/.ssh`, `~/.aws`, `~/.kube`, `~/.docker` or `~/.gnupg`. Its exclude list starts empty; edit `gist-sync.json` to add excludes. |
| `/gist-sync roots remove <name>` | Removes a root from local config only. It does not change gist contents or local files. |
| `/gist-sync unlink` | Clears the linked gist ID and the sync state. Never touches the gist or your local files. |
| `/gist-sync help` | Shows usage. This is the default; an unknown subcommand shows it too. |

| Flag | Applies to | Effect |
|---|---|---|
| `--dry-run` | push, pull | Prints the plan and writes nothing. |
| `--force` | push, pull | Resolves conflicts. Push: local wins. Pull: remote wins, local copy backed up first. Also accepts a gist manifest older than the last sync. |
| `--prune` | pull | Also deletes local files that were removed remotely since the last sync. |
| `--yes` | init, pull | init: links a gist owned by another account without asking. pull: skips the approval prompt. |

A flag a command does not take (for example `--force` on `status`) or an extra argument is rejected with a warning and nothing runs (`help` ignores flags; `roots` takes none).

## What syncs

The agent dir is `PI_CODING_AGENT_DIR` if set, otherwise `~/.pi/agent`. Paths below are relative to it.

| Group | Globs |
|---|---|
| Settings and config | `settings.json`, `keybindings.json`, `mcp.json`, `models.json`, one-level nested `*/settings.json` (per-extension settings), plus any other top-level `*.json` (for example `mcp-adapter.json`). Only the top-level `settings.json` has machine-local keys stripped or gets the display-key exemption; per-extension `*/settings.json` files sync byte for byte and always need approval. |
| Instructions | `AGENTS.md`, `AGENTS.override.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`, `SYSTEM.md`, `APPEND_SYSTEM.md`, plus any other top-level `*.md` |
| Extensions, skills and more | `extensions/**`, `skills/**`, `prompts/**`, `themes/**`, `agents/**` |
| Agent-dir scripts | `bin/**`. Pi puts `<agentDir>/bin` first on `PATH` for its bash tool and runs `bin/rg` or `bin/fd` when present, so these files are code tier on pull. |

| Not synced | Globs |
|---|---|
| Always, regardless of config, in both directions | `gist-sync.json`, `gist-sync.state.json`, `gist-sync-backups/**`, `**/.git/**`, `**/node_modules/**`, plus Pi's own top-level `trust.json`, `oauth.json` and `crashes.json` (matched case-insensitively). Inside a root the same rules apply to the root-relative path. |
| Excluded by default | `**/node_modules/**`, `**/.git/**`, `**/.DS_Store`, `**/*.bak`, `**/*.bak-*`, `**/*.log`, `**/*.jsonl`, `**/*.tmp`, `*-cache.json`, `*-store.json`, `**/__pycache__/**`, `**/.ruff_cache/**`, `sessions/**`, `subagents/**`, `checkpoints/**`, `jobs/**`, `tmp/**`, `npm/**`, `git/**`, `memory-archive/**`, `**/last-seen-version.json`, `**/changelog-state.json`, `bin/fd`, `bin/rg`, `bin/fd.exe`, `bin/rg.exe`, `ayu/**`, `pi-herdsman/**`, `missions/**`, `pi-warden/**`, `pi-sync/**`, `pi-cache-optimizer-stats.d/**`, `pi-pretty/**`, `memory/recovery/**`, `memory/daily/**` |
| Credentials, skipped by default (any depth, any letter case, agent dir and roots alike) | `**/auth.json`, `**/*-auth.json`, `**/oauth.json`, `**/*credentials*.json`, `**/*token*.json`, `**/.env`, `**/.env.*`, `**/.netrc`, `**/_netrc`, `**/.pgpass`, `**/.npmrc`, `**/.pypirc`, `**/.git-credentials`, `**/{.,}docker/config.json`, `**/{.,}kube/config`, `**/*.{pem,key,p12,pfx}`, `**/id_{rsa,dsa,ecdsa,ed25519}*`, `**/gh/hosts.yml` |
| Native binaries | ELF, Mach-O and PE executables are skipped by magic bytes in the agent dir and every root, on push and on pull (reason `native-binary`). Pi's downloaded `bin/fd`, `bin/rg`, `bin/fd.exe` and `bin/rg.exe` are excluded by the default globs. |
| Symlinks inside scanned directories | Skipped, never followed; a configured root directory itself is resolved to its real path |
| Unsupported file names | A name with a control or invisible character, a `:`, a trailing dot or space, a Windows device name such as `CON`, more than 32 levels, or over 1024 bytes in total or 255 in one part is skipped on push and rejected on pull |
| Unparseable `settings.json` | Never uploaded (reported as unreadable), because its machine-local keys could not be stripped |
| Machine-local `settings.json` keys | `lastChangelogVersion`, `extensionChangelogVersions`, `sessionDir`, `shellPath`, `httpProxy`, `selfUpdateCommand`, `npmCommand`, `defaultProjectTrust`, `deviceId`, `trackingId` |

The machine-local keys are never pushed and your local values are kept when a pull rewrites `settings.json`. They are per-machine or security-sensitive: a remote edit cannot widen trust or swap the updater. `memory/**` is not matched by default; add it to `include` to opt in.

On macOS and Windows, where disks ignore letter case, every exclude list (yours, the defaults and a root's) is matched case-insensitively, so `bin/RG` is excluded by `bin/rg`. Include globs stay case-sensitive.

## Roots

Roots let you sync selected files outside the Pi agent dir, such as scripts in `~/.local/bin` or configuration files in `~/.config`. A root name creates a gist namespace like `@local-bin/piwt`; the real directory mapping stays in your local `gist-sync.json`. The gist cannot choose a root directory or create one that does not exist; a pull only creates subdirectories inside an existing root. Credential and secret-scanner rules apply to root files exactly as to agent-dir files. A credential glob that names a directory, such as `**/{.,}kube/config`, also matches a root file by its path under your home, so a root at `~/.kube` that includes `config` still treats it as a credential.

A root has a name, an existing directory (absolute or starting with `~/`; `~user` is not expanded), at least one include glob relative to that directory, and an `exclude` list that may be empty. Portable exclusions for `node_modules`, `.git`, `.DS_Store`, `.bak`/`.bak-*`, `.log`, `.jsonl`, `.tmp`, `__pycache__` and `.ruff_cache` also apply to every root. At the top level of the agent dir, names starting with `@` are reserved for roots and are not synced as ordinary agent-dir files. For example, this local config is equivalent to the two `roots add` commands below:

```json
{
  "roots": {
    "local-bin": {
      "dir": "~/.local/bin",
      "include": ["piwt", "wtw"],
      "exclude": []
    },
    "dot-config": {
      "dir": "~/.config",
      "include": ["my-app/*.conf"],
      "exclude": []
    }
  }
}
```

```text
/gist-sync roots add local-bin ~/.local/bin piwt wtw
/gist-sync roots add dot-config ~/.config my-app/*.conf
/gist-sync push
```

On another machine, first link the gist and check which roots it uses:

```text
/gist-sync init <gist-id>
/gist-sync status
```

If that machine has not configured a root, `status` and `pull` report that its remote files were not applied and show a `/gist-sync roots add <name> <dir> <glob...>` hint. A configured root that fails to resolve prints `Root "<name>" ignored: <reason>` instead. Choose the local directory and include globs, add the root, then check again before pulling:

```text
/gist-sync roots add local-bin ~/.local/bin piwt wtw
/gist-sync status
/gist-sync pull
```

Root directories must already exist. `/`, your home directory, an ancestor of your home, directories overlapping the agent dir, and overlapping roots are refused. These checks compare device and inode numbers as well as paths, so an alias such as a macOS `/System/Volumes/Data/...` firmlink or a bind mount is caught too, and a write is refused if the root dir is no longer the directory that was resolved. Root files are always code tier and always need pull approval; the full list is shown with each absolute destination. If a root is on `PATH`, a pulled script can shadow other commands in every shell, so review the list and destinations before approving. With no passphrase, that prompt is the only authentication for root contents. Native binaries and symlinks inside a root are skipped; the configured root directory itself is resolved to its real path. Each file is subject to the configured size limit. Pointing an existing root name at a different directory makes the next push delete the old `@name/` files from the gist (its revision history keeps them), and `pull --prune` on other machines then offers to delete the matching local files, with approval and backups; use a new root name for a new directory.

## How extensions are synced

| Kind | How it travels |
|---|---|
| Installed packages | The package list lives in `settings.json` (`packages` and `extensions`), so it syncs with that file. Pi reinstalls missing packages on its next start or on `/reload`. The `npm/` and `git/` directories are excluded by default, so installed package copies stay out of the gist. |
| Local extension source | Files under `extensions/` sync as ordinary files. |

## Approval gate

Pi does not ask before it runs code or follows instructions, so a pull applies only a short allowlist without asking:

| Applied without asking | Everything else asks first |
|---|---|
| `keybindings.json` and `themes/**` without an execute bit, and `settings.json` changes limited to display and behavior keys (`theme`, `quietStartup`, `compaction` and similar; the list is `SAFE_SETTINGS_KEYS` in `src/settings-merge.ts`) | `extensions/**`; `mcp.json` and `models.json`; `settings.json` keys such as `packages`, `extensions`, `skills`, `shellCommandPrefix`, `externalEditor` or `defaultProvider`, and any key Pi adds later; `skills/**`, `agents/**`, `prompts/**` and instruction files such as `AGENTS.md`; third-party config and any other file. Deletes with `--prune` ask too. |

The prompt groups the changes as code Pi runs, instructions that steer the model, and other files. Code tier covers `extensions/**`, `mcp.json`, `models.json`, `settings.json`, agent-dir `bin/**`, any file whose mode has an execute bit (an executable `keybindings.json` or `themes/**` file loses its exemption), and every root file. Each line gives the action, the changed `settings.json` keys and the first 12 characters of the SHA-256 of the bytes that would be written, so an unexpected edit stands out. Root files also show their absolute destination, with any non-ASCII character escaped. Every tier is listed in full. `--yes` skips the prompt entirely. With no UI and no `--yes` the pull aborts. A caller of the library API that passes no `confirm` handler is refused whenever something needs approval. Run `pull --dry-run` first to see the full list, with each root file's destination.

After a pull that changes extensions, skills, prompts, themes, `settings.json`, `mcp.json` or an instruction file, it offers to reload Pi. With no UI it tells you to run `/reload`.

## Configuration

Settings live in `gist-sync.json` in the agent dir. It is machine-local and never synced. Missing or invalid fields fall back to the defaults. New configs use the current default `include` and `exclude` lists; an existing config keeps its own lists when defaults change. `init`, `unlink`, `roots add` and `roots remove` write all fields.

| Field | Default | Meaning |
|---|---|---|
| `gistId` | none | The linked gist. Set by `init`, cleared by `unlink`. |
| `roots` | `{}` | Local-only map of root names to `{ dir, include, exclude }`; each `include` must contain at least one glob. See "Roots". |
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

Conflicts stop the command and list the paths. `--force` resolves them. Before a pull overwrites or deletes anything, the old file is copied to `gist-sync-backups/<ISO timestamp, with : replaced by ->/<path>` (a random suffix is added if that dir already exists), including a file that appeared while the approval prompt was open. Root-file backups retain their `@name/rel` path under that directory. Backups are never pruned. A deletion on the remote reaches your machine only with `--prune`; otherwise the file is listed as local-only. Files that exist only locally and were never synced are never deleted. The gist's own revision history also keeps earlier versions.

## Security model

| Topic | Behavior |
|---|---|
| Gist visibility | Always created as a secret gist. Secret means unlisted, not private: anyone with the URL can read it. A push to a public gist is refused. |
| Gist ownership | `init <id>` compares the gist's owner with your token's account. A gist owned by someone else, or one whose owner cannot be checked, needs a confirmation (`--yes` with no UI), because its owner controls the files you pull. |
| Root configuration | Root names and directories exist only in local `gist-sync.json`; the gist cannot add or select a directory. Remote root paths apply only to configured roots. Unknown roots are skipped and reported with a setup hint. |
| Root changes | Every root file is code tier, always approval-gated and shown with its absolute destination. If the root is on `PATH`, a pulled script can shadow other commands in every shell, so review the full list. Agent-dir `bin/` is on Pi's own bash `PATH`, so its files and any executable file are code tier too. Without a passphrase, the prompt is the only authentication for root contents. |
| Root boundaries | Roots must exist and cannot be `/`, your home directory, an ancestor of your home, overlap the agent dir, or overlap another root, compared by device and inode as well as by path. Symlinks inside a root are skipped. `roots add` refuses a catch-all include on `~/.config`, `~/.ssh`, `~/.aws`, `~/.kube`, `~/.docker` and `~/.gnupg`. |
| Credentials | Credential files and files the secret scanner flags are skipped by default and reported as `credential` or `secret-detected`. A plain credential entry in the gist is never applied, in any mode. |
| Secret scanner | Best effort. Flags GitHub, AWS, Slack, OpenAI, Anthropic, Google, Stripe, npm, OpenRouter, Groq and Hugging Face tokens, JWTs, passwords in URLs, PEM private keys, Bearer tokens, base64-encoded PEM keys (kubeconfig), Docker-style `"auth"` user:password fields, `.netrc` passwords and `key = value` assignments. NUL bytes are ignored and JSON escapes are decoded before matching, so UTF-16 text and `\u0067hp_...` are still seen. Placeholders and env references are ignored. |
| Encrypt mode | With `credentials: "encrypt"`, those files are uploaded encrypted with AES-256-GCM and a fresh 12-byte IV per file. The key comes from your passphrase through scrypt (N=2^17, r=8, p=1, random 16-byte salt stored in the manifest) and HKDF splits it into separate encryption and MAC keys. The path is bound into each ciphertext and digest, so an entry cannot be re-pointed at another path. Their manifest digests are HMAC-SHA256 over the path and bytes. |
| Manifest signature | In encrypt mode with a passphrase, every push signs the whole manifest (HMAC-SHA256, bound to the gist ID), and a pull with the passphrase checks it before anything else. Someone who can write to the gist but lacks the passphrase cannot change paths, modes, names or digests. After one verified sync a machine refuses an unsigned manifest, and refuses a signed one it cannot verify. Without a passphrase nothing authenticates the manifest and the approval gate is the control. Pushing to a signed gist needs the passphrase. |
| Rollback | A manifest with a lower revision than this machine last synced is refused. `--force` accepts it. |
| What encryption does not hide | Paths, sizes, modes, the host name and timestamps in the manifest stay readable. A lost passphrase cannot be recovered. |
| Wrong or missing passphrase | A wrong passphrase, tampered ciphertext or a modified signed manifest fails with a bad-passphrase error. With no passphrase on pull, encrypted files are listed as undecryptable and skipped while everything else still applies, unless this machine already verified the gist. |
| Approval gate | See "Approval gate". Everything but display-only changes needs a yes. |
| Remote scope | A pull never writes or deletes a path ruled out by the agent-dir include/exclude rules or a configured root's include/exclude rules, and cannot overwrite credential files. An unconfigured remote root is skipped and reported with a setup hint. Remote files over `maxFileBytes` are skipped. |
| Path safety | Manifest paths that are absolute, contain an empty, `.` or `..` segment, backslashes, NUL bytes, control or invisible characters, a colon, a drive letter, a trailing slash, dot or space, or a Windows device name are rejected, as are paths over 32 levels, 1024 bytes in total or 255 in one part, and manifests with over 300 files. Non-ASCII spaces and blank filler letters (such as U+00A0 and U+3164) are rejected. Paths that differ only in case or Unicode normal form, or are both a file and a directory, are rejected. Agent-dir writes stay inside the agent dir; root writes stay inside their locally configured root. Symlinked parents below either base are skipped. A gist file name must be the path's own encoding. |
| Integrity | A pull verifies the digest of every file it will write before writing any file. One mismatch fails the whole pull with nothing written. An invalid `settings.json` in the gist fails it too. |
| Permissions | Pulled files lose group and world write bits and any setuid or setgid bit, always keep owner read and write, and credentials are written 0600, whatever mode the manifest claims. |
| Token | Sent only to the GitHub API host and `gist.githubusercontent.com`, and kept out of error messages. Downloads over 64 MiB per file are refused. |
| Local files | `gist-sync.json` and `gist-sync.state.json` are written with mode 0600. |

The full threat model and how to report a vulnerability are in [SECURITY.md](SECURITY.md).

## Limits

| Limit | Behavior |
|---|---|
| 300 files per gist | A push that would leave the gist with more than 300 files in total, the manifest included, fails with a too-many-files error before any write. |
| Two machines pushing at once | A gist has no conditional write. A push re-reads the gist right before writing and aborts with a conflict error if another push landed in the meantime, which narrows the race to a single round trip but cannot close it. Do not push from two machines at the same moment. |
| 1 MiB per file (default) | Larger files are skipped with a warning. Raise `maxFileBytes` to change it for agent-dir files and roots. |
| Configured roots | Only files matching a root's include and not its excludes are considered, and directories no include glob can reach are not walked. Native binaries and symlinks inside a root are skipped; the configured root directory itself is resolved to its real path. For `~/.local/bin`, use roots for scripts, not native executables. |
| Text only | A file that is not valid UTF-8, or contains a NUL byte, is stored as base64. |
| No empty files in gists | Empty files are recorded in the manifest only. |
| No whitespace-only files in gists | Stored as base64. |
| No `/` in gist file names | Paths are encoded flat (`/` becomes `%2F`, `%` becomes `%25`) and decoded on pull. A file named `_pi-gist-sync.json` is stored as `%5Fpi-gist-sync.json`. |

## FAQ

**Is my gist private?** No. It is secret, which means unlisted. Do not share the URL, and leave `credentials` on `skip` unless you use a strong passphrase.

**Does it need the GitHub CLI?** No. `gh auth token` is only the last fallback after the environment variables.

**Why did my first pull on a second machine report a conflict?** That machine already had a `settings.json` that differs from the gist, and there is no earlier sync to say which side is right. Run `pull --force`; the old file goes to `gist-sync-backups/` first.

**Why does every pull ask me to approve things?** Pi runs extensions and follows skills and instruction files without asking, so anything outside the display-only set could run code or steer the model. Read the list, check the hashes against the gist on GitHub, then confirm. `--yes` skips the prompt entirely; keep it for unattended runs you trust.

**I deleted a file locally. Will it come back?** Not from a pull: a change made only on your side is never reverted. The next push removes the file from the gist. In the other direction, a file deleted remotely is removed locally only with `pull --prune`.

**How do I get an older version back?** Look in `gist-sync-backups/` for files a pull replaced, or in the gist's revision history on GitHub.

**Does it sync my sessions?** No. `sessions/**` is excluded by default, along with other bulky or per-machine directories.

**Does it run on its own?** Only if you set `checkOnStart` to `true`, and then it only notifies. Pushing and pulling always happen when you run the command.

**How do I stop syncing?** Run `/gist-sync unlink`. The gist and your files stay as they are.

## Compared with @narumitw/pi-sync

[`@narumitw/pi-sync`](https://www.npmjs.com/package/@narumitw/pi-sync) syncs through Git, WebDAV, S3 or R2. Use it if you want one of those backends. pi-gist-sync is Gist-only and has no runtime dependencies, which keeps setup to a single GitHub token.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md). Released under the [MIT license](LICENSE).
