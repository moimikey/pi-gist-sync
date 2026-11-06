# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-05

### Added

- `/gist-sync` command with `init`, `status`, `push`, `pull`, `scan`, `unlink` and `help`.
- Sync of the Pi agent dir (settings, keybindings, MCP and model config, instruction files, extensions, skills, prompts, themes, agents) through one multi-file secret GitHub Gist.
- Three-way planning per path with the last sync as the base, so a change made on only one side is never reverted and a change on both sides is reported as a conflict.
- `--dry-run` on `push` and `pull`, `--force` to resolve conflicts, `--prune` to apply remote deletions locally, `--yes` to skip the approval prompt.
- Timestamped backups under `gist-sync-backups/` of every file a pull overwrites or deletes, including a file that appeared while the approval prompt was open.
- Machine-local `settings.json` keys (`lastChangelogVersion`, `extensionChangelogVersions`, `sessionDir`, `shellPath`, `httpProxy`, `selfUpdateCommand`, `npmCommand`, `defaultProjectTrust`, `deviceId`, `trackingId`) are never pushed and are preserved on pull, also when the file has a BOM.
- Credential files and files flagged by the secret scanner are skipped by default; `credentials: "encrypt"` stores them with AES-256-GCM using a scrypt-derived key (N=2^17) split by HKDF, with the path bound into each ciphertext and digest.
- Signed manifests: with a passphrase, every push signs the whole manifest and a pull verifies it first. A machine that verified a gist once refuses an unsigned or unverifiable manifest, and a manifest older than the last sync is refused unless `--force` is given.
- Approval gate: a pull applies only `keybindings.json`, `themes/**` and display-only `settings.json` keys without asking. Everything else, including `mcp.json`, `models.json`, skills, agents, prompts, instruction files and other settings keys, is listed by tier with a SHA-256 of the content and needs a yes (`--yes` skips it). A caller that passes no confirm handler is refused.
- `init` accepts a gist ID or gist.github.com URL, asks before linking a gist owned by another account (`--yes` skips), and a push to a public gist is refused.
- Unknown flags and extra arguments are rejected before anything runs.
- Secret scanner for token, JWT, URL-password, private-key and `key = value` patterns. It ignores NUL bytes and decodes JSON escapes before matching.
- Pi's own `trust.json`, `oauth.json` and `crashes.json` are never synced, and credential globs match at any depth and in any letter case.
- Path checks on manifest paths (traversal, control and invisible characters, Windows device names, length, depth, entry count) and digest verification of every file to be written before any file is written. Pulled files lose group and world write bits and setuid bits, and credentials are written 0600.
- Binary and whitespace-only files stored as base64, empty files recorded in the manifest only, and `/` in paths encoded so the flat gist namespace works.
- The approval prompt always lists every code-tier change; the instruction and other tiers show their first 8 entries and a count.
- `push` re-reads the gist right before writing and aborts with a conflict error if another push landed meanwhile. A gist has no conditional write, so this narrows the race but cannot close it.
- Optional `checkOnStart` notification on Pi startup when the gist has changes you have not pulled; it never prompts and gives up after 5 s.
- Token lookup from `PI_GIST_SYNC_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then `gh auth token`.
- Zero runtime dependencies.

[Unreleased]: https://github.com/moimikey/pi-gist-sync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/moimikey/pi-gist-sync/releases/tag/v0.1.0
