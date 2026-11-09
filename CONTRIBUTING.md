# Contributing

Thanks for helping. These rules keep the project zero-dependency.

## Setup

```bash
git clone https://github.com/moimikey/pi-gist-sync.git
cd pi-gist-sync
npm ci
npm run check   # typecheck + tests
```

Use Node 22.19 or newer, which is also Pi's own minimum. The tests run TypeScript through Node's type stripping (`--experimental-strip-types`), and CI runs Node 22 and 24.

| Script | What it does |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Runs `test/**/*.test.ts` with `node:test` |
| `npm run check` | Typecheck, then tests. The release workflow runs this. |

Run one test file:

```bash
node --test --experimental-strip-types test/<file>.test.ts
```

## Rules

| Rule | Why |
|---|---|
| Erasable TypeScript only: no `enum`, `namespace` or constructor parameter properties | Node strips types without a build step, and Pi loads the source with jiti. |
| Relative imports end in `.ts`; use `import type` for types | `.ts` extensions are required by Node's resolver; `import type` by `verbatimModuleSyntax`. |
| Node built-ins only, no runtime dependencies | Fewer things to audit in a tool that handles credentials. `fetch` is global. |
| No dynamic `import()` in `src/` | jiti can hand a second concurrent `import()` of one module an undefined namespace, which broke back-to-back commands in Pi. |
| A security fix ships with a test that fails without it | The approval gate, path rules and signature checks are the product. |
| Tests use `node:test` and `node:assert/strict` | No test framework to install. |
| Tests never touch your real `~/.pi`, home directory or the real GitHub API | Use `fs.mkdtemp` directories for both the agent dir and home, and the fake gist server in `test/helpers/fake-gist-server.ts`. |
| Comments are one short line and explain why | Delete a comment that restates the code. |
| Do not edit `src/types.ts` or the contract in `docs/SPEC.md` casually | Every module codes against them. Change both together and update every consumer. |

## Layout

| Path | Role |
|---|---|
| `src/types.ts` | Shared types and `GistSyncError` |
| `src/globs.ts`, `src/scan.ts`, `src/config.ts`, `src/roots.ts`, `src/settings-merge.ts` | Glob matching, agent dir and root scans, config and state files, root resolution, `settings.json` handling |
| `src/codec.ts`, `src/secrets.ts`, `src/crypto.ts`, `src/manifest.ts` | Path and content encoding, secret detection, encryption, manifest parsing |
| `src/gist-client.ts` | GitHub Gist API client and token resolution |
| `src/plan.ts`, `src/sync.ts` | Three-way planner and the init, status, push and pull flows |
| `src/command.ts`, `extensions/index.ts` | `/gist-sync` command and the Pi extension glue |
| `docs/SPEC.md` | Design contract |

## Trying it in Pi

Point Pi at a throwaway agent dir so your real settings stay untouched:

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" pi -e .
```

## Pull requests

1. Add or update tests for the behavior you change.
2. Run `npm run check`.
3. Add a line under `## [Unreleased]` in `CHANGELOG.md`.
4. Describe what changed and why. Do not paste gist IDs, tokens or file contents into the PR.

Security issues go through private reporting, not a PR or issue. See [SECURITY.md](SECURITY.md).

## Releasing

Maintainers only.

1. Move the `[Unreleased]` entries under a new `## [x.y.z] - YYYY-MM-DD` heading in `CHANGELOG.md`.
2. Set the same `x.y.z` in `package.json`.
3. Update the `[Unreleased]` and `[x.y.z]` links at the bottom of `CHANGELOG.md`.
4. Commit on `main`, tag `vx.y.z` and push the tag.

The release workflow fails if the tag is not on `main` or differs from the `package.json` version. A check job with no secrets runs `npm run check`, then a separate job publishes to npm with provenance. A tag with a hyphen, such as `v0.2.0-rc.1`, publishes to the `next` dist-tag instead of `latest`.
