import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { BACKUP_DIR, CONFIG_FILE, defaultConfig, STATE_FILE } from "../src/config.ts";
import { listCandidates, scanAgentDir } from "../src/scan.ts";
import type { SyncConfig } from "../src/types.ts";

const roots: string[] = [];
const restore: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gist-sync-scan-"));
  roots.push(dir);
  return dir;
}

after(async () => {
  // Unreadable dirs would make rm fail
  for (const p of restore) await chmod(p, 0o755).catch(() => {});
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

async function put(root: string, rel: string, content: string | Uint8Array = "x"): Promise<void> {
  const abs = join(root, ...rel.split("/"));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

const noDetect = (): string[] => [];
const paths = (r: { files: { path: string }[] }): string[] => r.files.map((f) => f.path);

// chmod does not bind root, and Windows has no posix modes or cheap symlinks
const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
const canSymlink = process.platform !== "win32";

test("walks nested dirs and returns sorted posix paths", async () => {
  const dir = await tempDir();
  for (const rel of ["settings.json", "extensions/b/index.ts", "extensions/a/index.ts", "skills/z/SKILL.md", "AGENTS.md"]) {
    await put(dir, rel);
  }
  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), [
    "AGENTS.md",
    "extensions/a/index.ts",
    "extensions/b/index.ts",
    "settings.json",
    "skills/z/SKILL.md",
  ]);
  assert.deepEqual(skipped, []);
});

test("a missing agent dir scans as empty", async () => {
  const dir = await tempDir();
  const res = await scanAgentDir(join(dir, "nope"), defaultConfig(), noDetect);
  assert.deepEqual(res, { files: [], skipped: [] });
  assert.deepEqual(await listCandidates(join(dir, "nope"), defaultConfig()), []);
});

test("returns size, masked mode and plain Uint8Array bytes", async () => {
  const dir = await tempDir();
  await put(dir, "settings.json", "hello");
  await put(dir, "extensions/run.sh", "#!/bin/sh\n");
  if (canChmod) await chmod(join(dir, "extensions", "run.sh"), 0o4755);
  const { files } = await scanAgentDir(dir, defaultConfig(), noDetect);
  const settings = files.find((f) => f.path === "settings.json");
  assert.ok(settings);
  assert.equal(settings.size, 5);
  assert.equal(Buffer.from(settings.bytes).toString("utf8"), "hello");
  assert.equal(Object.getPrototypeOf(settings.bytes), Uint8Array.prototype);
  if (canChmod) {
    // setuid and friends never leak into the recorded mode
    assert.equal(files.find((f) => f.path === "extensions/run.sh")?.mode, 0o755);
  }
});

test("empty files are included with size 0", async () => {
  const dir = await tempDir();
  await put(dir, "extensions/empty.ts", "");
  const { files } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(files.map((f) => [f.path, f.size]), [["extensions/empty.ts", 0]]);
});

test("include and exclude globs decide membership; * never crosses a slash", async () => {
  const dir = await tempDir();
  for (const rel of [
    "mcp-adapter.json",
    "notes.md",
    "random/other.json", // top-level *.json must not reach into subdirs
    "random/other.md",
    "update-cache.json", // excluded
    "thing-store.json", // excluded
    "extensions/debug.log", // excluded
    "extensions/x/.DS_Store", // excluded
    "settings.json.bak-1", // excluded
    "extensions/y/keep.ts",
  ]) {
    await put(dir, rel);
  }
  const { files } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), ["extensions/y/keep.ts", "mcp-adapter.json", "notes.md"]);
});

test("dotfiles are included when a glob matches them", async () => {
  const dir = await tempDir();
  await put(dir, "skills/a/.hidden.md");
  await put(dir, ".top.json");
  await put(dir, ".env");
  const { files } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), [".top.json", "skills/a/.hidden.md"]);
});

test("user include/exclude with braces and **", async () => {
  const dir = await tempDir();
  for (const rel of ["a/x.toml", "a/b/y.toml", "a/b/z.yaml", "c/w.toml", "a/skip/q.toml"]) await put(dir, rel);
  const config: SyncConfig = { ...defaultConfig(), include: ["{a,c}/**/*.{toml,yaml}"], exclude: ["**/skip/**"] };
  const { files } = await scanAgentDir(dir, config, noDetect);
  assert.deepEqual(paths({ files }), ["a/b/y.toml", "a/b/z.yaml", "a/x.toml", "c/w.toml"]);
});

test("config, state, backups, .git and node_modules are excluded even when the user config would include them", async () => {
  const dir = await tempDir();
  for (const rel of [
    CONFIG_FILE,
    STATE_FILE,
    `${BACKUP_DIR}/2026-01-01T00-00-00.000Z/settings.json`,
    ".git/config",
    "node_modules/pkg/index.js",
    "extensions/e/node_modules/dep/index.js",
    "extensions/e/.git/HEAD",
    "settings.json",
  ]) {
    await put(dir, rel);
  }
  const config: SyncConfig = { ...defaultConfig(), include: ["**"], exclude: [] };
  const { files, skipped } = await scanAgentDir(dir, config, noDetect);
  assert.deepEqual(paths({ files }), ["settings.json"]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(await listCandidates(dir, { ...config, include: [] }), ["settings.json"]);
});

test("a nested file named like the config file is a normal file", async () => {
  const dir = await tempDir();
  await put(dir, `skills/${CONFIG_FILE}`);
  const { files } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), [`skills/${CONFIG_FILE}`]);
});

test("symlinks are skipped, never followed", { skip: !canSymlink }, async () => {
  const dir = await tempDir();
  const outside = await tempDir();
  await put(outside, "secret.md", "outside the agent dir");
  await put(outside, "tree/inner.md", "inner");
  await put(dir, "real.json");
  await symlink(join(outside, "secret.md"), join(dir, "linked.md"));
  await symlink(join(dir, "real.json"), join(dir, "settings.json"));
  await symlink(join(outside, "tree"), join(dir, "skills"));
  await mkdir(join(dir, "extensions"));
  await symlink(join(outside, "secret.md"), join(dir, "extensions", "evil.ts"));
  await symlink(join(dir, "nowhere"), join(dir, "dangling.json"));

  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), ["real.json"]);
  assert.deepEqual(
    skipped.map((s) => [s.path, s.reason]),
    [
      ["dangling.json", "symlink"],
      ["extensions/evil.ts", "symlink"],
      ["linked.md", "symlink"],
      ["settings.json", "symlink"],
      ["skills", "symlink"],
    ],
  );
  assert.equal((await listCandidates(dir, { ...defaultConfig(), include: [] })).includes("linked.md"), false);
});

test("a symlink that could never be synced is not reported", { skip: !canSymlink }, async () => {
  const dir = await tempDir();
  const outside = await tempDir();
  await symlink(outside, join(dir, "random-dir"));
  await symlink(join(outside, "x"), join(dir, "sessions"));
  await symlink(join(outside, "x"), join(dir, "update-cache.json"));
  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(files, []);
  assert.deepEqual(skipped, []);
});

test("excluded directories are not descended into", { skip: !canChmod }, async () => {
  const dir = await tempDir();
  const unreadable = [
    "sessions",
    "extensions/e/node_modules",
    "extensions/e/.git",
    "git",
    "npm",
    BACKUP_DIR,
    ".git",
    "node_modules",
    "custom-excluded",
  ];
  for (const d of unreadable) {
    await mkdir(join(dir, ...d.split("/")), { recursive: true });
    await put(dir, `${d}/f.json`);
  }
  await put(dir, "settings.json");
  for (const d of unreadable) {
    await chmod(join(dir, ...d.split("/")), 0o000);
    restore.push(join(dir, ...d.split("/")));
  }

  const config: SyncConfig = { ...defaultConfig(), exclude: [...defaultConfig().exclude, "custom-excluded/**"] };
  // Entering any of these would fail with EACCES and surface as an unreadable skip
  const res = await scanAgentDir(dir, config, noDetect);
  assert.deepEqual(paths(res), ["settings.json"]);
  assert.deepEqual(res.skipped, []);
  assert.deepEqual(await listCandidates(dir, config), []);
});

test("a non-excluded unreadable directory is reported, proving the check above is real", { skip: !canChmod }, async () => {
  const dir = await tempDir();
  await put(dir, "skills/private/a.md");
  await put(dir, "skills/ok/b.md");
  await put(dir, "elsewhere/c.txt");
  const blocked = [join(dir, "skills", "private"), join(dir, "elsewhere")];
  for (const p of blocked) {
    await chmod(p, 0o000);
    restore.push(p);
  }
  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), ["skills/ok/b.md"]);
  // `elsewhere` cannot hold synced files, so it is not worth a warning
  assert.deepEqual(skipped.map((s) => [s.path, s.reason]), [["skills/private", "unreadable"]]);
});

test("files over maxFileBytes are skipped too-large without being read", { skip: !canChmod }, async () => {
  const dir = await tempDir();
  await put(dir, "extensions/big.bin", Buffer.alloc(11, 1));
  await put(dir, "extensions/edge.bin", Buffer.alloc(10, 1));
  await put(dir, "extensions/small.ts", "ok");
  // Unreadable on top of oversized: only a pre-open size check can report too-large
  await chmod(join(dir, "extensions", "big.bin"), 0o000);
  restore.push(join(dir, "extensions", "big.bin"));

  const seen: number[] = [];
  const config: SyncConfig = { ...defaultConfig(), maxFileBytes: 10 };
  const { files, skipped } = await scanAgentDir(dir, config, (bytes) => {
    seen.push(bytes.length);
    return [];
  });
  assert.deepEqual(paths({ files }), ["extensions/edge.bin", "extensions/small.ts"]);
  assert.deepEqual(skipped.map((s) => [s.path, s.reason]), [["extensions/big.bin", "too-large"]]);
  assert.match(skipped[0]?.detail ?? "", /11/);
  assert.deepEqual(seen.sort((a, b) => a - b), [2, 10]);
});

test("too-large uses the configured limit, default 1 MiB", async () => {
  const dir = await tempDir();
  await put(dir, "extensions/a.bin", Buffer.alloc(1048576, 1));
  await put(dir, "extensions/b.bin", Buffer.alloc(1048577, 1));
  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), ["extensions/a.bin"]);
  assert.deepEqual(skipped.map((s) => [s.path, s.reason]), [["extensions/b.bin", "too-large"]]);
});

test("an unreadable included file is skipped with a detail", { skip: !canChmod }, async () => {
  const dir = await tempDir();
  await put(dir, "settings.json");
  await put(dir, "keybindings.json");
  await chmod(join(dir, "keybindings.json"), 0o000);
  restore.push(join(dir, "keybindings.json"));
  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), ["settings.json"]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.path, "keybindings.json");
  assert.equal(skipped[0]?.reason, "unreadable");
  assert.match(skipped[0]?.detail ?? "", /EACCES/);
});

test("the detector sees only included, in-limit files", async () => {
  const dir = await tempDir();
  await put(dir, "settings.json", "S");
  await put(dir, "sessions/s.json", "SESSION");
  await put(dir, "random/r.json", "RANDOM");
  await put(dir, "extensions/e/node_modules/n.js", "NODE");
  const seen: string[] = [];
  await scanAgentDir(dir, defaultConfig(), (bytes) => {
    seen.push(Buffer.from(bytes).toString("utf8"));
    return [];
  });
  assert.deepEqual(seen, ["S"]);
});

test("sensitive: credential globs and scanner hits, files still returned", async () => {
  const dir = await tempDir();
  await put(dir, "auth.json", "{}");
  await put(dir, "github-token.json", "{}");
  await put(dir, "extensions/x/.env", "A=1");
  await put(dir, "settings.json", "{}");
  await put(dir, "skills/leaky/SKILL.md", "key = TOPSECRET");
  await put(dir, "skills/clean/SKILL.md", "nothing here");

  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), (bytes) =>
    Buffer.from(bytes).toString("utf8").includes("TOPSECRET") ? ["generic-secret-assignment"] : [],
  );
  const flags = Object.fromEntries(files.map((f) => [f.path, f.sensitive]));
  assert.deepEqual(flags, {
    "auth.json": true,
    "extensions/x/.env": true,
    "github-token.json": true,
    "settings.json": false,
    "skills/clean/SKILL.md": false,
    "skills/leaky/SKILL.md": true,
  });
  assert.deepEqual(skipped, []);
});

test("a credential file is sensitive even when the scanner finds nothing", async () => {
  const dir = await tempDir();
  await put(dir, "auth.json", "{}");
  const { files } = await scanAgentDir(dir, defaultConfig(), () => []);
  assert.equal(files[0]?.sensitive, true);
});

test("non-regular files are reported, not opened", { skip: process.platform === "win32" }, async () => {
  const dir = await tempDir();
  execFileSync("mkfifo", [join(dir, "settings.json")]);
  execFileSync("mkfifo", [join(dir, "ignored.txt")]);
  await put(dir, "keybindings.json");
  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), ["keybindings.json"]);
  assert.deepEqual(skipped.map((s) => [s.path, s.reason, s.detail]), [
    ["settings.json", "unreadable", "not a regular file"],
  ]);
  // FIFOs are never candidates either
  assert.deepEqual(await listCandidates(dir, { ...defaultConfig(), include: [] }), ["keybindings.json"]);
});

test("file names with a backslash are skipped because the manifest cannot carry them", { skip: process.platform === "win32" }, async () => {
  const dir = await tempDir();
  await put(dir, "extensions/a\\b.ts");
  await put(dir, "extensions/ok.ts");
  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), ["extensions/ok.ts"]);
  assert.deepEqual(skipped.map((s) => [s.path, s.reason]), [["extensions/a\\b.ts", "unreadable"]]);
});

test("file names the manifest would reject are skipped with the reason", { skip: process.platform === "win32" }, async () => {
  const dir = await tempDir();
  for (const rel of ["extensions/a:stream.ts", "extensions/CON", "extensions/trail.", "extensions/line\nbreak.ts", "extensions/ok.ts"]) {
    await put(dir, rel);
  }
  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), ["extensions/ok.ts"]);
  assert.equal(skipped.length, 4);
  for (const s of skipped) {
    assert.equal(s.reason, "unreadable");
    assert.match(s.detail ?? "", /^unsupported file name: /);
  }
});

test("Pi's per-machine files are never scanned, whatever include says", async () => {
  const dir = await tempDir();
  for (const rel of ["trust.json", "Trust.json", "oauth.json", "crashes.json", "settings.json"]) await put(dir, rel);
  const config = { ...defaultConfig(), include: ["**"], exclude: [] };
  const { files, skipped } = await scanAgentDir(dir, config, noDetect);
  assert.deepEqual(paths({ files }), ["settings.json"]);
  assert.deepEqual(skipped, []);
});

test("credential files are sensitive at any depth and in any case", async () => {
  const dir = await tempDir();
  for (const rel of ["extensions/gmail/credentials.json", "extensions/x/token.json", "agents/a/Auth.json", "extensions/x/.ENV", "extensions/x/ok.ts"]) {
    await put(dir, rel);
  }
  const { files } = await scanAgentDir(dir, { ...defaultConfig(), include: ["**"], exclude: [] }, noDetect);
  assert.deepEqual(files.filter((f) => f.sensitive).map((f) => f.path), [
    "agents/a/Auth.json",
    "extensions/gmail/credentials.json",
    "extensions/x/.ENV",
    "extensions/x/token.json",
  ]);
});

test("detect receives each file's path as well as its bytes", async () => {
  const dir = await tempDir();
  await put(dir, "settings.json", "{}");
  await put(dir, "skills/a/SKILL.md", "hi");
  const seen: string[] = [];
  await scanAgentDir(dir, defaultConfig(), (_bytes, path) => {
    seen.push(path);
    return [];
  });
  assert.deepEqual(seen.sort(), ["settings.json", "skills/a/SKILL.md"]);
});

test("listCandidates returns regular files neither included nor excluded, sorted", async () => {
  const dir = await tempDir();
  for (const rel of [
    "settings.json", // included
    "extensions/e.ts", // included
    "sessions/s.json", // excluded
    "update-cache.json", // excluded
    "extensions/e/node_modules/n.js", // always excluded
    CONFIG_FILE,
    "random/zeta.json",
    "random/alpha.toml",
    "bin/tool",
    "notes.txt",
    ".hidden",
  ]) {
    await put(dir, rel);
  }
  assert.deepEqual(await listCandidates(dir, defaultConfig()), [
    ".hidden",
    "bin/tool",
    "notes.txt",
    "random/alpha.toml",
    "random/zeta.json",
  ]);
});

test("listCandidates reflects user config", async () => {
  const dir = await tempDir();
  await put(dir, "a/x.toml");
  await put(dir, "b/y.toml");
  const config: SyncConfig = { ...defaultConfig(), include: ["a/**"], exclude: [] };
  assert.deepEqual(await listCandidates(dir, config), ["b/y.toml"]);
});
