import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  BACKUP_DIR,
  CASE_INSENSITIVE_FS,
  clearState,
  CONFIG_FILE,
  CREDENTIAL_GLOBS,
  defaultConfig,
  DEFAULT_EXCLUDE,
  DEFAULT_INCLUDE,
  isAlwaysExcluded,
  isCredentialPath,
  isExcludedBy,
  loadConfig,
  loadState,
  PORTABLE_EXCLUDE,
  resolveAgentDir,
  saveConfig,
  saveState,
  STATE_FILE,
} from "../src/config.ts";
import type { SyncState } from "../src/types.ts";

const roots: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gist-sync-config-"));
  roots.push(dir);
  return dir;
}

after(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

const posix = process.platform !== "win32";

test("constants match the spec", () => {
  assert.equal(CONFIG_FILE, "gist-sync.json");
  assert.equal(STATE_FILE, "gist-sync.state.json");
  assert.equal(BACKUP_DIR, "gist-sync-backups");
  assert.ok(DEFAULT_INCLUDE.includes("settings.json"));
  assert.ok(DEFAULT_INCLUDE.includes("extensions/**"));
  assert.ok(DEFAULT_EXCLUDE.includes("sessions/**"));
  assert.ok(CREDENTIAL_GLOBS.includes("**/auth.json"));
});

test("isCredentialPath matches at any depth and in any letter case", () => {
  for (const p of [
    "auth.json", "Auth.json", "agents/a/auth.json", "github-auth.json", "oauth.json", "OAuth.JSON", "extensions/gmail/credentials.json",
    "extensions/x/token.json", "my-credentials-v2.json", "api-token.json", ".env", ".ENV", "extensions/x/.env.local", "a/b/.Env.Production",
  ]) {
    assert.equal(isCredentialPath(p), true, p);
  }
  for (const p of ["settings.json", "skills/a/SKILL.md", "extensions/x/index.ts", "auth.md", "tokenizer.ts", "environment.json"]) {
    assert.equal(isCredentialPath(p), false, p);
  }
});

test("isAlwaysExcluded covers Pi's per-machine files, sync files, .git and node_modules in any case", () => {
  for (const p of [
    "trust.json", "Trust.JSON", "oauth.json", "crashes.json", "gist-sync.json", "GIST-SYNC.STATE.JSON", "gist-sync-backups/x/y.md",
    ".git/config", "extensions/x/.GIT/HEAD", "node_modules/a/b.js", "extensions/x/Node_Modules/y.js",
  ]) {
    assert.equal(isAlwaysExcluded(p), true, p);
  }
  // Only the top-level names are Pi's own files; a nested one is ordinary content.
  for (const p of ["extensions/trust.json", "settings.json", "skills/a/SKILL.md", "gist-sync.json.bak-x"]) {
    assert.equal(isAlwaysExcluded(p), false, p);
  }
});

test("defaultConfig has the spec defaults and returns fresh copies", () => {
  const a = defaultConfig();
  assert.equal(a.credentials, "skip");
  assert.equal(a.maxFileBytes, 1048576);
  assert.equal(a.checkOnStart, false);
  assert.equal("gistId" in a, false);
  assert.deepEqual(a.roots, {});
  assert.deepEqual(a.include, [...DEFAULT_INCLUDE]);
  assert.deepEqual(a.exclude, [...DEFAULT_EXCLUDE]);

  a.include.push("mutated");
  assert.equal(defaultConfig().include.includes("mutated"), false);
  assert.equal(DEFAULT_INCLUDE.includes("mutated"), false);
});

test("loadConfig returns defaults when the file is missing, including a missing dir", async () => {
  const dir = await tempDir();
  assert.deepEqual(await loadConfig(dir), defaultConfig());
  assert.deepEqual(await loadConfig(join(dir, "nope")), defaultConfig());
});

test("loadConfig merges the file over the defaults", async () => {
  const dir = await tempDir();
  await writeFile(
    join(dir, CONFIG_FILE),
    JSON.stringify({ gistId: "abc123", credentials: "encrypt", include: ["only.json"], maxFileBytes: 2048 }),
  );
  const cfg = await loadConfig(dir);
  assert.equal(cfg.gistId, "abc123");
  assert.equal(cfg.credentials, "encrypt");
  assert.deepEqual(cfg.include, ["only.json"]);
  assert.equal(cfg.maxFileBytes, 2048);
  // untouched fields keep their defaults
  assert.deepEqual(cfg.exclude, [...DEFAULT_EXCLUDE]);
  assert.equal(cfg.checkOnStart, false);
});

test("loadConfig falls back per field on invalid types", async () => {
  const dir = await tempDir();
  await writeFile(
    join(dir, CONFIG_FILE),
    JSON.stringify({
      gistId: 42,
      include: "settings.json",
      exclude: ["ok/**", 7],
      credentials: "plaintext",
      maxFileBytes: "big",
      checkOnStart: "yes",
    }),
  );
  assert.deepEqual(await loadConfig(dir), defaultConfig());

  await writeFile(
    join(dir, CONFIG_FILE),
    JSON.stringify({ gistId: "g", maxFileBytes: -1, checkOnStart: true, exclude: ["a"] }),
  );
  const cfg = await loadConfig(dir);
  assert.equal(cfg.gistId, "g");
  assert.equal(cfg.maxFileBytes, 1048576);
  assert.equal(cfg.checkOnStart, true);
  assert.deepEqual(cfg.exclude, ["a"]);
});

test("loadConfig ignores unknown fields and survives garbage files", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ surprise: 1, gistId: "g" }));
  const cfg = await loadConfig(dir);
  assert.equal(cfg.gistId, "g");
  assert.equal("surprise" in cfg, false);

  for (const garbage of ["{not json", "[]", "null", "17", ""]) {
    await writeFile(join(dir, CONFIG_FILE), garbage);
    assert.deepEqual(await loadConfig(dir), defaultConfig(), garbage);
  }
});

test("saveConfig round-trips and creates the agent dir", async () => {
  const dir = join(await tempDir(), "fresh", "agent");
  const cfg = { ...defaultConfig(), gistId: "g1", credentials: "encrypt" as const, checkOnStart: true };
  await saveConfig(dir, cfg);
  assert.deepEqual(await loadConfig(dir), cfg);
  const text = await readFile(join(dir, CONFIG_FILE), "utf8");
  assert.ok(text.endsWith("}\n"));
});

test("saveConfig omits an unset gistId and stray fields", async () => {
  const dir = await tempDir();
  await saveConfig(dir, { ...defaultConfig(), stray: "x" } as never);
  const parsed = JSON.parse(await readFile(join(dir, CONFIG_FILE), "utf8"));
  assert.equal("gistId" in parsed, false);
  assert.equal("stray" in parsed, false);
});

test("writes are mode 0600 even over an existing looser file", { skip: !posix }, async () => {
  const dir = await tempDir();
  await writeFile(join(dir, CONFIG_FILE), "{}", { mode: 0o644 });
  await saveConfig(dir, defaultConfig());
  assert.equal((await stat(join(dir, CONFIG_FILE))).mode & 0o777, 0o600);

  await saveState(dir, { gistId: "g", revision: 1, files: {}, syncedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal((await stat(join(dir, STATE_FILE))).mode & 0o777, 0o600);
});

test("writes leave no temp files behind", async () => {
  const dir = await tempDir();
  await saveConfig(dir, defaultConfig());
  await saveState(dir, { gistId: "g", revision: 1, files: {}, syncedAt: "t" });
  assert.deepEqual((await readdir(dir)).sort(), [CONFIG_FILE, STATE_FILE]);
});

test("concurrent saves never leave a torn file", async () => {
  const dir = await tempDir();
  const writes = Array.from({ length: 25 }, (_, i) => saveConfig(dir, { ...defaultConfig(), gistId: `g${i}` }));
  await Promise.all(writes);
  const cfg = await loadConfig(dir);
  assert.match(cfg.gistId ?? "", /^g\d+$/);
  assert.deepEqual(await readdir(dir), [CONFIG_FILE]);
});

test("a failed write cleans up its temp file and keeps the target", async () => {
  const dir = await tempDir();
  // A directory squatting on the target name makes rename fail after the temp file exists
  await mkdir(join(dir, CONFIG_FILE));
  await assert.rejects(saveConfig(dir, defaultConfig()));
  assert.deepEqual(await readdir(dir), [CONFIG_FILE]);
  assert.ok((await stat(join(dir, CONFIG_FILE))).isDirectory());
});

const sampleState: SyncState = {
  gistId: "g1",
  revision: 7,
  files: { "settings.json": "aa", "skills/x/SKILL.md": "bb" },
  syncedAt: "2026-11-05T00:00:00.000Z",
};

test("state round-trips; missing state is undefined", async () => {
  const dir = await tempDir();
  assert.equal(await loadState(dir), undefined);
  await saveState(dir, sampleState);
  assert.deepEqual(await loadState(dir), sampleState);
});

test("state keeps the signed pin only when it is exactly true", async () => {
  const dir = await tempDir();
  await saveState(dir, { ...sampleState, signed: true });
  assert.equal((await loadState(dir))?.signed, true);
  await saveState(dir, sampleState);
  assert.equal("signed" in ((await loadState(dir)) ?? {}), false);
  await writeFile(join(dir, STATE_FILE), JSON.stringify({ ...sampleState, signed: "yes" }));
  assert.equal("signed" in ((await loadState(dir)) ?? {}), false);
});

test("loadState rejects malformed state as undefined", async () => {
  const dir = await tempDir();
  const bad = [
    "{oops",
    "[]",
    JSON.stringify({ ...sampleState, gistId: "" }),
    JSON.stringify({ ...sampleState, revision: 1.5 }),
    JSON.stringify({ ...sampleState, revision: "7" }),
    JSON.stringify({ ...sampleState, files: { a: 1 } }),
    JSON.stringify({ ...sampleState, files: [] }),
    JSON.stringify({ ...sampleState, syncedAt: 5 }),
  ];
  for (const text of bad) {
    await writeFile(join(dir, STATE_FILE), text);
    assert.equal(await loadState(dir), undefined, text);
  }
});

test("loadState keeps a __proto__ path as plain data", async () => {
  const dir = await tempDir();
  await writeFile(
    join(dir, STATE_FILE),
    '{"gistId":"g","revision":1,"syncedAt":"t","files":{"__proto__":"aa","ok":"bb"}}',
  );
  const st = await loadState(dir);
  assert.ok(st);
  assert.equal(Object.getPrototypeOf(st.files), Object.prototype);
  assert.deepEqual(Object.keys(st.files).sort(), ["__proto__", "ok"]);
});

test("clearState removes the state and tolerates a missing file", async () => {
  const dir = await tempDir();
  await clearState(dir);
  await saveState(dir, sampleState);
  await clearState(dir);
  assert.equal(await loadState(dir), undefined);
  assert.deepEqual(await readdir(dir), []);
});

test("resolveAgentDir defaults to ~/.pi/agent under the given home", () => {
  assert.equal(resolveAgentDir({ HOME: "/h/user" }), join("/h/user", ".pi", "agent"));
  assert.equal(resolveAgentDir({ HOME: "/h/user", PI_CODING_AGENT_DIR: "" }), join("/h/user", ".pi", "agent"));
});

test("resolveAgentDir honours PI_CODING_AGENT_DIR", () => {
  assert.equal(resolveAgentDir({ HOME: "/h", PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
});

test("resolveAgentDir expands a leading ~ in PI_CODING_AGENT_DIR", () => {
  assert.equal(resolveAgentDir({ HOME: "/h/user", PI_CODING_AGENT_DIR: "~" }), "/h/user");
  assert.equal(resolveAgentDir({ HOME: "/h/user", PI_CODING_AGENT_DIR: "~/work/agent" }), join("/h/user", "work", "agent"));
});

test("resolveAgentDir leaves a non-leading or user-form ~ alone", () => {
  assert.equal(resolveAgentDir({ HOME: "/h", PI_CODING_AGENT_DIR: "/a/~/b" }), "/a/~/b");
  assert.equal(resolveAgentDir({ HOME: "/h", PI_CODING_AGENT_DIR: "~other/x" }), "~other/x");
});

// ---- roots and the new defaults --------------------------------------------

test("PORTABLE_EXCLUDE is the non agent-dir part of DEFAULT_EXCLUDE", () => {
  assert.deepEqual([...PORTABLE_EXCLUDE], [
    "**/node_modules/**",
    "**/.git/**",
    "**/.DS_Store",
    "**/*.bak",
    "**/*.bak-*",
    "**/*.log",
    "**/*.jsonl",
    "**/*.tmp",
    "**/__pycache__/**",
    "**/.ruff_cache/**",
  ]);
  for (const g of PORTABLE_EXCLUDE) assert.ok(DEFAULT_EXCLUDE.includes(g), g);
  assert.ok(Object.isFrozen(PORTABLE_EXCLUDE));
  // Nothing tied to the agent dir layout leaks into the per-root list
  for (const g of ["sessions/**", "*-cache.json", "bin/rg", "memory/daily/**"]) assert.equal(PORTABLE_EXCLUDE.includes(g), false, g);
});

test("default lists carry the roots-era additions", () => {
  for (const g of ["bin/**", "*/settings.json"]) assert.ok(DEFAULT_INCLUDE.includes(g), g);
  for (const g of [
    "bin/fd", "bin/rg", "bin/fd.exe", "bin/rg.exe", "**/last-seen-version.json", "**/changelog-state.json",
    "ayu/**", "pi-herdsman/**", "missions/**", "pi-warden/**", "pi-sync/**", "pi-cache-optimizer-stats.d/**",
    "pi-pretty/**", "memory/recovery/**", "memory/daily/**",
  ]) {
    assert.ok(DEFAULT_EXCLUDE.includes(g), g);
  }
  // memory stays opt-in
  assert.equal(DEFAULT_INCLUDE.some((g) => g.startsWith("memory")), false);
});

test("an existing config keeps its own lists rather than the new defaults", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ include: ["settings.json"], exclude: ["sessions/**"] }));
  const cfg = await loadConfig(dir);
  assert.deepEqual(cfg.include, ["settings.json"]);
  assert.deepEqual(cfg.exclude, ["sessions/**"]);
  assert.deepEqual(cfg.roots, {});
});

test("roots round-trip through saveConfig and loadConfig", async () => {
  const dir = await tempDir();
  const cfg = {
    ...defaultConfig(),
    gistId: "g",
    roots: {
      "local-bin": { dir: "~/.local/bin", include: ["piwt", "wtw"], exclude: [] },
      cfg: { dir: "/abs/config", include: ["**/*.toml"], exclude: ["secret/**"] },
    },
  };
  await saveConfig(dir, cfg);
  assert.deepEqual(await loadConfig(dir), cfg);
});

test("saveConfig always writes roots and strips stray root fields", async () => {
  const dir = await tempDir();
  await saveConfig(dir, defaultConfig());
  assert.deepEqual(JSON.parse(await readFile(join(dir, CONFIG_FILE), "utf8")).roots, {});

  const stray = { dir: "/d", include: ["a"], exclude: [], extra: 1 } as never;
  await saveConfig(dir, { ...defaultConfig(), roots: { r: stray } });
  assert.deepEqual(JSON.parse(await readFile(join(dir, CONFIG_FILE), "utf8")).roots, { r: { dir: "/d", include: ["a"], exclude: [] } });
});

test("loadConfig drops malformed root entries one by one", async () => {
  const dir = await tempDir();
  await writeFile(
    join(dir, CONFIG_FILE),
    JSON.stringify({
      roots: {
        good: { dir: "/d", include: ["a"], exclude: ["b"] },
        noexclude: { dir: "/d2", include: ["a"] },
        empty: { dir: "/d3", include: [], exclude: [] },
        str: "/d",
        arr: ["/d"],
        nulled: null,
        baddir: { dir: 5, include: ["a"], exclude: [] },
        noinclude: { dir: "/d" },
        badinclude: { dir: "/d", include: "a", exclude: [] },
        mixedinclude: { dir: "/d", include: ["a", 1], exclude: [] },
        badexclude: { dir: "/d", include: ["a"], exclude: [null] },
      },
    }),
  );
  const cfg = await loadConfig(dir);
  // Empty include is kept so resolveRoots can name the problem; a missing exclude means none
  assert.deepEqual(cfg.roots, {
    good: { dir: "/d", include: ["a"], exclude: ["b"] },
    noexclude: { dir: "/d2", include: ["a"], exclude: [] },
    empty: { dir: "/d3", include: [], exclude: [] },
  });

  for (const bad of ["x", 1, null, [], true]) {
    await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ roots: bad }));
    assert.deepEqual((await loadConfig(dir)).roots, {}, JSON.stringify(bad));
  }
});

test("a __proto__ root name stays an own key and never touches the prototype", async () => {
  const dir = await tempDir();
  await writeFile(
    join(dir, CONFIG_FILE),
    '{"roots":{"__proto__":{"dir":"/evil","include":["**"],"exclude":[]},"ok":{"dir":"/d","include":["a"],"exclude":[]}}}',
  );
  const cfg = await loadConfig(dir);
  assert.equal(Object.getPrototypeOf(cfg.roots), Object.prototype);
  assert.deepEqual(Object.keys(cfg.roots).sort(), ["__proto__", "ok"]);
  assert.equal(({} as Record<string, unknown>).dir, undefined);

  // And it survives a save as data too
  await saveConfig(dir, cfg);
  const text = await readFile(join(dir, CONFIG_FILE), "utf8");
  assert.match(text, /"__proto__"/);
  const again = await loadConfig(dir);
  assert.deepEqual(Object.keys(again.roots).sort(), ["__proto__", "ok"]);
  assert.equal(Object.getPrototypeOf(again.roots), Object.prototype);
});

test("isAlwaysExcluded also guards root-relative paths", () => {
  for (const p of ["gist-sync.json", "node_modules/x", "a/.git/HEAD", "trust.json"]) assert.equal(isAlwaysExcluded(p), true, p);
  assert.equal(isAlwaysExcluded("piwt"), false);
});

test("credential globs cover common stores a root can reach", () => {
  for (const p of [
    ".netrc",
    "_netrc",
    ".pgpass",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    "docker/config.json",
    ".docker/config.json",
    "kube/config",
    ".kube/config",
    "certs/server.pem",
    "certs/server.pem.key",
    "x/client.P12",
    "a.pfx",
    "id_rsa",
    "ssh/id_ed25519.pub",
    "gh/hosts.yml",
  ]) {
    assert.equal(isCredentialPath(p), true, p);
  }
  for (const p of ["keybindings.json", "docker/compose.yml", "kube/notes.md", "bin/piwt", "key.txt"]) assert.equal(isCredentialPath(p), false, p);
});

test("isExcludedBy folds case on both sides when asked, and only then", () => {
  assert.equal(isExcludedBy(["bin/rg", "private/**"], "bin/RG", true), true);
  assert.equal(isExcludedBy(["Private/**"], "PRIVATE/planted", true), true);
  assert.equal(isExcludedBy(["bin/rg"], "bin/RG", false), false);
  assert.equal(isExcludedBy(["bin/rg"], "bin/rg", false), true);
  assert.equal(isExcludedBy(["bin/rg"], "bin/rgx", true), false);
  assert.equal(CASE_INSENSITIVE_FS, process.platform === "darwin" || process.platform === "win32");
});
