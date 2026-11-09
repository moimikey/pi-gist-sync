import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { BACKUP_DIR, CONFIG_FILE, defaultConfig, STATE_FILE } from "../src/config.ts";
import type { ResolvedRoot } from "../src/roots.ts";
import { isNativeBinary, listCandidates, listRootCandidates, scanAgentDir, scanRoot } from "../src/scan.ts";
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
    "tools/tool",
    "notes.txt",
    ".hidden",
  ]) {
    await put(dir, rel);
  }
  assert.deepEqual(await listCandidates(dir, defaultConfig()), [
    ".hidden",
    "notes.txt",
    "random/alpha.toml",
    "random/zeta.json",
    "tools/tool",
  ]);
});

test("listCandidates reflects user config", async () => {
  const dir = await tempDir();
  await put(dir, "a/x.toml");
  await put(dir, "b/y.toml");
  const config: SyncConfig = { ...defaultConfig(), include: ["a/**"], exclude: [] };
  assert.deepEqual(await listCandidates(dir, config), ["b/y.toml"]);
});

// ---- roots, native binaries, reserved names --------------------------------

function bytes(...xs: number[]): Uint8Array {
  const out = new Uint8Array(64);
  out.set(xs);
  return out;
}

function pe(lfanew = 0x40): Uint8Array {
  const out = new Uint8Array(0x80);
  out.set([0x4d, 0x5a]);
  new DataView(out.buffer).setUint32(0x3c, lfanew, true);
  if (lfanew + 4 <= out.length) out.set([0x50, 0x45, 0, 0], lfanew);
  return out;
}

test("isNativeBinary recognises ELF, thin and fat Mach-O, and PE", () => {
  const natives: [string, Uint8Array][] = [
    ["elf", bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1)],
    ["macho-32-be", bytes(0xfe, 0xed, 0xfa, 0xce)],
    ["macho-64-be", bytes(0xfe, 0xed, 0xfa, 0xcf)],
    ["macho-32-le", bytes(0xce, 0xfa, 0xed, 0xfe)],
    ["macho-64-le", bytes(0xcf, 0xfa, 0xed, 0xfe)],
    ["fat", bytes(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2)],
    ["fat-le", bytes(0xbe, 0xba, 0xfe, 0xca)],
    ["pe", pe()],
  ];
  for (const [label, b] of natives) assert.equal(isNativeBinary(b), true, label);
});

test("isNativeBinary leaves text that starts with MZ or #! alone", () => {
  const texts = [
    "MZ is how this script starts, and it is long enough to have an e_lfanew field somewhere\n",
    "MZ",
    "#!/bin/sh\necho hi\n",
    "#!/usr/bin/env node\nconsole.log(1)\n",
    "\x7fEL",
    "",
  ];
  for (const t of texts) assert.equal(isNativeBinary(new TextEncoder().encode(t)), false, JSON.stringify(t));
  // MZ header whose e_lfanew points past the end, or at bytes that are not PE\0\0
  assert.equal(isNativeBinary(pe(0x1000)), false);
  const noSig = pe();
  noSig.set([0x50, 0x45, 0x20, 0x20], 0x40);
  assert.equal(isNativeBinary(noSig), false);
});

test("the agent dir scan skips native binaries before the detector sees them", async () => {
  const dir = await tempDir();
  await put(dir, "bin/tool", bytes(0x7f, 0x45, 0x4c, 0x46));
  await put(dir, "bin/tool.exe", pe());
  await put(dir, "bin/script", "#!/bin/sh\necho hi\n");
  await put(dir, "bin/mz-script", "MZ marks the spot, says this plain text file, which is longer than 64 bytes\n");
  // Pi downloads these itself, so they are excluded rather than reported
  await put(dir, "bin/rg", bytes(0x7f, 0x45, 0x4c, 0x46));
  await put(dir, "bin/fd", "x");
  const seen: string[] = [];
  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), (_b, p) => {
    seen.push(p);
    return [];
  });
  assert.deepEqual(paths({ files }), ["bin/mz-script", "bin/script"]);
  assert.deepEqual(skipped.map((s) => [s.path, s.reason]), [
    ["bin/tool", "native-binary"],
    ["bin/tool.exe", "native-binary"],
  ]);
  assert.deepEqual(seen.sort(), ["bin/mz-script", "bin/script"]);
});

test("new default lists: per-extension settings and bin are in, runtime state is out", async () => {
  const dir = await tempDir();
  for (const rel of [
    "mf-plan/settings.json",
    "bin/piwt",
    "memory/notes/a.md",
    "memory/daily/x.md",
    "pi-herdsman/settings.json",
    "ayu/settings.json",
    "extensions/x/last-seen-version.json",
    "changelog-state.json",
    "a/b/settings.json",
  ]) {
    await put(dir, rel);
  }
  const { files } = await scanAgentDir(dir, defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), ["bin/piwt", "mf-plan/settings.json"]);
});

test("top-level @ names in the agent dir are reserved and never scanned", async () => {
  const dir = await tempDir();
  await put(dir, "@weird.json", "{}");
  await put(dir, "@local-bin/settings.json", "{}");
  await put(dir, "@junk.txt");
  await put(dir, "skills/@ok/SKILL.md");
  const seen: string[] = [];
  const { files, skipped } = await scanAgentDir(dir, defaultConfig(), (_b, p) => {
    seen.push(p);
    return [];
  });
  assert.deepEqual(paths({ files }), ["skills/@ok/SKILL.md"]);
  // `@junk.txt` and the `@local-bin` dir could never match the defaults, so they are not worth a warning
  assert.deepEqual(skipped.map((s) => [s.path, s.reason]), [["@weird.json", "unreadable"]]);
  assert.match(skipped[0]?.detail ?? "", /reserved/);
  assert.deepEqual(seen, ["skills/@ok/SKILL.md"]);
  // An `include: **` config still cannot reach inside, and candidates never list them
  const all = await scanAgentDir(dir, { ...defaultConfig(), include: ["**"], exclude: [] }, noDetect);
  assert.deepEqual(paths(all), ["skills/@ok/SKILL.md"]);
  assert.deepEqual(all.skipped.map((s) => s.path), ["@junk.txt", "@local-bin", "@weird.json"]);
  assert.equal((await listCandidates(dir, { ...defaultConfig(), include: [] })).some((p) => p.startsWith("@")), false);
});

function rootAt(dir: string, include: string[] = ["**"], exclude: string[] = []): ResolvedRoot {
  return { name: "local-bin", dir, include, exclude, credPrefix: ".local/bin" };
}

test("scanRoot treats a file as a credential by its path under home, not only inside the root", async () => {
  const dir = await tempDir();
  await put(dir, "config", "apiVersion: v1\n");
  const scan = async (credPrefix: string) =>
    (await scanRoot({ name: "r", dir, include: ["config"], exclude: [], credPrefix }, defaultConfig(), noDetect)).files.map((f) => f.sensitive);
  assert.deepEqual(await scan(".kube"), [true]);
  assert.deepEqual(await scan("bin"), [false]);
});

test("scanRoot prefixes every path with @name/ and hands detect the root-relative path", async () => {
  const dir = await tempDir();
  await put(dir, "piwt", "#!/bin/sh\n");
  await put(dir, "sub/wtw", "#!/bin/sh\n");
  await put(dir, "big", Buffer.alloc(11, 0x61));
  await put(dir, "other.txt");
  if (canChmod) await chmod(join(dir, "piwt"), 0o755);
  const seen: string[] = [];
  const config = { ...defaultConfig(), maxFileBytes: 10 };
  const { files, skipped } = await scanRoot(rootAt(dir, ["piwt", "sub/*", "big"]), config, (_b, p) => {
    seen.push(p);
    return [];
  });
  assert.deepEqual(paths({ files }), ["@local-bin/piwt", "@local-bin/sub/wtw"]);
  assert.deepEqual(skipped.map((s) => [s.path, s.reason]), [["@local-bin/big", "too-large"]]);
  assert.deepEqual(seen.sort(), ["piwt", "sub/wtw"]);
  if (canChmod) assert.equal(files[0]?.mode, 0o755);
});

test("scanRoot applies PORTABLE_EXCLUDE, the root exclude and the always-excluded names", async () => {
  const dir = await tempDir();
  for (const rel of [
    "piwt",
    "piwt.bak-2026",
    "piwt.bak",
    "debug.log",
    ".DS_Store",
    "node_modules/x/index.js",
    ".git/config",
    "__pycache__/a.pyc",
    "gist-sync.json",
    "trust.json",
    "skip-me",
  ]) {
    await put(dir, rel);
  }
  const { files, skipped } = await scanRoot(rootAt(dir, ["**"], ["skip-*"]), defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), ["@local-bin/piwt"]);
  assert.deepEqual(skipped, []);
});

test("scanRoot skips symlinks and native binaries, and flags credentials by root-relative path", { skip: !canSymlink }, async () => {
  const dir = await tempDir();
  const outside = await tempDir();
  await put(outside, "secret", "outside");
  await put(outside, "tree/inner", "inner");
  await put(dir, "real", "#!/bin/sh\n");
  await put(dir, ".env", "A=1");
  await put(dir, "rg", bytes(0xcf, 0xfa, 0xed, 0xfe));
  await symlink(join(outside, "secret"), join(dir, "link"));
  await symlink(join(outside, "tree"), join(dir, "linked-dir"));
  const { files, skipped } = await scanRoot(rootAt(dir), defaultConfig(), noDetect);
  assert.deepEqual(files.map((f) => [f.path, f.sensitive]), [
    ["@local-bin/.env", true],
    ["@local-bin/real", false],
  ]);
  assert.deepEqual(skipped.map((s) => [s.path, s.reason]), [
    ["@local-bin/link", "symlink"],
    ["@local-bin/linked-dir", "symlink"],
    ["@local-bin/rg", "native-binary"],
  ]);
});

test("scanRoot reports unsupported names with the prefixed path", { skip: process.platform === "win32" }, async () => {
  const dir = await tempDir();
  await put(dir, "a:b");
  await put(dir, "ok");
  const { files, skipped } = await scanRoot(rootAt(dir), defaultConfig(), noDetect);
  assert.deepEqual(paths({ files }), ["@local-bin/ok"]);
  assert.deepEqual(skipped.map((s) => [s.path, s.reason]), [["@local-bin/a:b", "unreadable"]]);
});

test("listRootCandidates lists files the root neither includes nor excludes, as @name/rel", async () => {
  const dir = await tempDir();
  for (const rel of ["piwt", "wtw", "old.bak", "node_modules/x.js", "nested/tool"]) await put(dir, rel);
  assert.deepEqual(await listRootCandidates(rootAt(dir, ["piwt"]), defaultConfig()), [
    "@local-bin/nested/tool",
    "@local-bin/wtw",
  ]);
});

test("isNativeBinary knows 64-bit fat Mach-O and tells a Java class from a fat binary", () => {
  assert.equal(isNativeBinary(bytes(0xca, 0xfe, 0xba, 0xbf, 0, 0, 0, 2)), true, "fat64-be");
  assert.equal(isNativeBinary(bytes(0xbf, 0xba, 0xfe, 0xca, 2, 0, 0, 0)), true, "fat64-le");
  // Java 8 class: CAFEBABE, minor 0, major 52
  assert.equal(isNativeBinary(bytes(0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52)), false, "java class");
  assert.equal(isNativeBinary(new Uint8Array([0xca, 0xfe, 0xba, 0xbe])), false, "too short to tell");
});

test("a narrow root include still finds files in nested dirs it names", async () => {
  const dir = await tempDir();
  for (const rel of ["piwt", "my-app/a.conf", "my-app/deep/b.conf", "other/a.conf", "x/y/z.md", "sub/piwt"]) await put(dir, rel);
  const scanWith = async (include: string[]) => {
    const root: ResolvedRoot = { name: "r", dir, include, exclude: [], credPrefix: "r" };
    return paths(await scanRoot(root, defaultConfig(), noDetect));
  };
  assert.deepEqual(await scanWith(["piwt"]), ["@r/piwt"]);
  assert.deepEqual(await scanWith(["my-app/*.conf"]), ["@r/my-app/a.conf"]);
  assert.deepEqual(await scanWith(["*/*.conf"]), ["@r/my-app/a.conf", "@r/other/a.conf"]);
  assert.deepEqual(await scanWith(["**/piwt"]), ["@r/piwt", "@r/sub/piwt"]);
  assert.deepEqual(await scanWith(["{my-app,x/y}/**"]), ["@r/my-app/a.conf", "@r/my-app/deep/b.conf", "@r/x/y/z.md"]);
  assert.deepEqual(await scanWith(["my-app/**"]), ["@r/my-app/a.conf", "@r/my-app/deep/b.conf"]);
});

test("a root scan never enters a dir its include cannot reach", { skip: !canChmod }, async () => {
  const dir = await tempDir();
  await put(dir, "piwt");
  await put(dir, "big/inner/x");
  // `big` itself matches an include, so a walk that entered it would report it unreadable.
  await chmod(join(dir, "big"), 0o000);
  restore.push(join(dir, "big"));
  const root: ResolvedRoot = { name: "r", dir, include: ["piwt", "big"], exclude: [], credPrefix: "r" };
  const res = await scanRoot(root, defaultConfig(), noDetect);
  assert.deepEqual(paths(res), ["@r/piwt"]);
  assert.deepEqual(res.skipped, []);
});

test("an exclude matches a case variant where the disk ignores case", { skip: !(process.platform === "darwin" || process.platform === "win32") }, async () => {
  const dir = await tempDir();
  for (const rel of ["LS", "PRIVATE/planted", "keep"]) await put(dir, rel);
  const root: ResolvedRoot = { name: "r", dir, include: ["**"], exclude: ["ls", "private/**"], credPrefix: "r" };
  assert.deepEqual(paths(await scanRoot(root, defaultConfig(), noDetect)), ["@r/keep"]);
  const agent = await tempDir();
  await put(agent, "bin/RG");
  await put(agent, "bin/piwt");
  assert.deepEqual(paths(await scanAgentDir(agent, defaultConfig(), noDetect)), ["bin/piwt"]);
});
