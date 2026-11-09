import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { after, test } from "node:test";
import { defaultConfig } from "../src/config.ts";
import { expandHome, isRootCredential, joinRootPath, resolveRoots, ROOT_NAME, ROOT_PREFIX, splitRootPath } from "../src/roots.ts";
import type { RootConfig, SyncConfig } from "../src/types.ts";

const temps: string[] = [];
const canSymlink = process.platform !== "win32";

after(async () => {
  await Promise.all(temps.map((t) => rm(t, { recursive: true, force: true })));
});

// A fake home with an agent dir inside it, all under a realpath'd temp dir (macOS /var is a symlink).
async function sandbox(): Promise<{ base: string; home: string; agentDir: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "gist-sync-roots-")));
  temps.push(base);
  const home = join(base, "home");
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });
  return { base, home, agentDir };
}

const idOf = (st: { dev: number; ino: number }) => `${st.dev}:${st.ino}`;

function root(dir: string, include: string[] = ["**"], exclude: string[] = []): RootConfig {
  return { dir, include, exclude };
}

function withRoots(roots: Record<string, RootConfig>): SyncConfig {
  return { ...defaultConfig(), roots };
}

async function problemsFor(
  roots: Record<string, RootConfig>,
  ctx: { home: string; agentDir: string },
): Promise<{ kept: string[]; problems: [string, string][] }> {
  const res = await resolveRoots(withRoots(roots), ctx);
  return { kept: [...res.roots.keys()], problems: res.problems.map((p) => [p.name, p.message]) };
}

test("splitRootPath and joinRootPath", () => {
  assert.equal(ROOT_PREFIX, "@");
  assert.deepEqual(splitRootPath("@a/b/c"), { name: "a", rel: "b/c" });
  assert.deepEqual(splitRootPath("@local-bin/piwt"), { name: "local-bin", rel: "piwt" });
  for (const p of ["@a", "@a/", "@/x", "a/b", "", "settings.json", "x/@a/b"]) assert.equal(splitRootPath(p), undefined, p);
  assert.equal(joinRootPath("local-bin", "piwt"), "@local-bin/piwt");
  assert.deepEqual(splitRootPath(joinRootPath("a", "b/c")), { name: "a", rel: "b/c" });
});

test("ROOT_NAME accepts short lowercase names only", () => {
  for (const n of ["a", "0", "local-bin", "a-", "x".repeat(32)]) assert.equal(ROOT_NAME.test(n), true, n);
  for (const n of ["", "-a", "Local", "a_b", "a.b", "a/b", "@a", "x".repeat(33), "__proto__", "a\n"]) {
    assert.equal(ROOT_NAME.test(n), false, JSON.stringify(n));
  }
});

test("expandHome expands only ~ and ~/", () => {
  assert.equal(expandHome("~", "/h/u"), "/h/u");
  assert.equal(expandHome("~/", "/h/u"), "/h/u");
  assert.equal(expandHome("~/.local/bin", "/h/u"), join("/h/u", ".local", "bin"));
  for (const d of ["~user", "~user/bin", "/a/~/b", "x~", "", "/abs", "rel/dir", "~~"]) assert.equal(expandHome(d, "/h/u"), d, d);
});

test("resolveRoots keeps valid roots, realpath'd, sorted by name, with copied globs", async () => {
  const { base, home, agentDir } = await sandbox();
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await mkdir(join(base, "elsewhere"), { recursive: true });
  const include = ["piwt"];
  const res = await resolveRoots(
    withRoots({
      zeta: root(join(base, "elsewhere"), ["*.toml"], ["x"]),
      "local-bin": root("~/.local/bin", include),
    }),
    { home, agentDir },
  );
  assert.deepEqual(res.problems, []);
  assert.deepEqual([...res.roots.keys()], ["local-bin", "zeta"]);
  assert.deepEqual(res.roots.get("local-bin"), {
    name: "local-bin",
    dir: join(home, ".local", "bin"),
    include: ["piwt"],
    exclude: [],
    id: idOf(await stat(join(home, ".local", "bin"))),
    credPrefix: ".local/bin",
  });
  assert.deepEqual(res.roots.get("zeta")?.exclude, ["x"]);
  include.push("mutated");
  assert.deepEqual(res.roots.get("local-bin")?.include, ["piwt"]);
});

test("resolveRoots with no roots is empty", async () => {
  const { home, agentDir } = await sandbox();
  assert.deepEqual(await resolveRoots(defaultConfig(), { home, agentDir }), { roots: new Map(), problems: [] });
});

test("resolveRoots refuses /, home and any ancestor of home", async () => {
  const { base, home, agentDir } = await sandbox();
  const { kept, problems } = await problemsFor(
    { fsroot: root("/"), tilde: root("~"), home: root(home), parent: root(base), trailing: root(`${home}/`) },
    { home, agentDir },
  );
  assert.deepEqual(kept, []);
  assert.deepEqual(problems.map(([n]) => n), ["fsroot", "home", "parent", "tilde", "trailing"]);
  assert.match(problems[0]?.[1] ?? "", /filesystem root/);
  for (const [, m] of problems.slice(1)) assert.match(m, /home directory/);
});

test("resolveRoots refuses overlap with the agent dir in both directions", async () => {
  const { home, agentDir } = await sandbox();
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  const { kept, problems } = await problemsFor(
    { equal: root(agentDir), inside: root(join(agentDir, "extensions")), outside: root(join(home, ".pi")) },
    { home, agentDir },
  );
  assert.deepEqual(kept, []);
  assert.deepEqual(problems, [
    ["equal", "overlaps the agent dir"],
    ["inside", "overlaps the agent dir"],
    ["outside", "overlaps the agent dir"],
  ]);
});

test("resolveRoots compares against an agent dir that does not exist yet", async () => {
  const { base, home } = await sandbox();
  const agentDir = join(base, "fresh", "agent");
  await mkdir(join(base, "fresh"), { recursive: true });
  const { kept, problems } = await problemsFor({ a: root(join(base, "fresh")) }, { home, agentDir });
  assert.deepEqual(kept, []);
  assert.deepEqual(problems, [["a", "overlaps the agent dir"]]);
});

test("resolveRoots drops the later name when two roots overlap", async () => {
  const { home, agentDir } = await sandbox();
  for (const d of ["x/y", "q/inner", "same"]) await mkdir(join(home, d), { recursive: true });
  const { kept, problems } = await problemsFor(
    {
      a: root(join(home, "x")),
      b: root(join(home, "x", "y")), // nested below a
      c: root(join(home, "q", "inner")),
      d: root(join(home, "q")), // contains c
      e: root(join(home, "same")),
      f: root("~/same"), // equal to e
    },
    { home, agentDir },
  );
  assert.deepEqual(kept, ["a", "c", "e"]);
  assert.deepEqual(problems, [
    ["b", 'overlaps root "a"'],
    ["d", 'overlaps root "c"'],
    ["f", 'overlaps root "e"'],
  ]);
});

test("resolveRoots reports a missing dir, a file and a relative or ~user dir without throwing", async () => {
  const { home, agentDir } = await sandbox();
  await writeFile(join(home, "file"), "x");
  await mkdir(join(home, "ok"));
  const { kept, problems } = await problemsFor(
    {
      missing: root(join(home, "nope")),
      file: root(join(home, "file")),
      rel: root("rel/dir"),
      user: root("~someone/bin"),
      ok: root(join(home, "ok")),
    },
    { home, agentDir },
  );
  assert.deepEqual(kept, ["ok"]);
  assert.deepEqual(problems.map(([n]) => n), ["file", "missing", "rel", "user"]);
  assert.match(problems[0]?.[1] ?? "", /not a directory/);
  assert.match(problems[1]?.[1] ?? "", /does not exist/);
  assert.match(problems[2]?.[1] ?? "", /absolute/);
  assert.match(problems[3]?.[1] ?? "", /absolute/);
});

test("resolveRoots refuses bad names, including __proto__", async () => {
  const { home, agentDir } = await sandbox();
  await mkdir(join(home, "d"));
  const roots: Record<string, RootConfig> = Object.fromEntries(
    ["Local-Bin", "-x", "a_b", "x".repeat(33), "__proto__", ""].map((n) => [n, root(join(home, "d"))]),
  );
  const { kept, problems } = await problemsFor(roots, { home, agentDir });
  assert.deepEqual(kept, []);
  assert.equal(problems.length, 6);
  for (const [, m] of problems) assert.match(m, /invalid name/);
});

test("resolveRoots refuses an empty or malformed include and a malformed entry", async () => {
  const { home, agentDir } = await sandbox();
  await mkdir(join(home, "d"));
  const d = join(home, "d");
  const { kept, problems } = await problemsFor(
    {
      empty: root(d, []),
      notarray: { dir: d, include: "**", exclude: [] } as never,
      badexclude: { dir: d, include: ["a"], exclude: [1] } as never,
      nodir: { include: ["a"], exclude: [] } as never,
      nul: null as never,
    },
    { home, agentDir },
  );
  assert.deepEqual(kept, []);
  assert.deepEqual(problems.map(([n]) => n), ["badexclude", "empty", "nodir", "notarray", "nul"]);
  assert.match(problems[1]?.[1] ?? "", /non-empty list/);
});

test("credPrefix is the root dir relative to home, or its absolute path outside home", async () => {
  const { base, home, agentDir } = await sandbox();
  for (const d of [[".kube"], [".config", "gh"], ["outside", "tools"]]) await mkdir(join(d[0] === "outside" ? base : home, ...d), { recursive: true });
  const res = await resolveRoots(
    withRoots({ kube: root("~/.kube"), gh: root("~/.config/gh"), out: root(join(base, "outside", "tools")) }),
    { home, agentDir },
  );
  assert.deepEqual(res.problems, []);
  assert.equal(res.roots.get("kube")?.credPrefix, ".kube");
  assert.equal(res.roots.get("gh")?.credPrefix, ".config/gh");
  assert.equal(res.roots.get("out")?.credPrefix, join(base, "outside", "tools").slice(1).split(sep).join("/"));
});

test("credPrefix is computed against the realpath of a symlinked home", { skip: !canSymlink }, async () => {
  // The unresolved tmpdir is a symlink on macOS (/var -> /private/var); the link adds one more hop everywhere.
  const raw = await mkdtemp(join(tmpdir(), "gist-sync-roots-raw-"));
  temps.push(raw);
  const real = await realpath(raw);
  await mkdir(join(real, "home", ".kube"), { recursive: true });
  await mkdir(join(real, "home", ".pi", "agent"), { recursive: true });
  await symlink(join(raw, "home"), join(raw, "home-link"));
  const home = join(raw, "home-link");
  const res = await resolveRoots(withRoots({ kube: root("~/.kube") }), { home, agentDir: join(home, ".pi", "agent") });
  assert.deepEqual(res.problems, []);
  assert.equal(res.roots.get("kube")?.dir, join(real, "home", ".kube"));
  assert.equal(res.roots.get("kube")?.credPrefix, ".kube");
});

test("isRootCredential checks the root-relative path and the path under the root's home prefix", () => {
  const at = (credPrefix: string) => ({ name: "r", dir: "/x", include: ["**"], exclude: [], credPrefix });
  assert.equal(isRootCredential(at(".kube"), "config"), true);
  assert.equal(isRootCredential(at(".docker"), "config.json"), true);
  assert.equal(isRootCredential(at(".config/gh"), "hosts.yml"), true);
  assert.equal(isRootCredential(at("bin"), "auth.json"), true);
  assert.equal(isRootCredential(at("bin"), "config"), false);
  assert.equal(isRootCredential(at(".kube"), "cache/x"), false);
  assert.equal(isRootCredential(at(""), "config"), false);
});

test("a symlinked root dir resolves to its target", { skip: !canSymlink }, async () => {
  const { base, home, agentDir } = await sandbox();
  await mkdir(join(base, "real", "bin"), { recursive: true });
  await mkdir(join(home, ".local"), { recursive: true });
  await symlink(join(base, "real", "bin"), join(home, ".local", "bin"));
  const res = await resolveRoots(withRoots({ "local-bin": root("~/.local/bin") }), { home, agentDir });
  assert.deepEqual(res.problems, []);
  assert.equal(res.roots.get("local-bin")?.dir, join(base, "real", "bin"));
});

test("a symlink cannot smuggle the home or agent dir in as a root", { skip: !canSymlink }, async () => {
  const { base, home, agentDir } = await sandbox();
  await symlink(home, join(base, "to-home"));
  await symlink(agentDir, join(base, "to-agent"));
  await symlink(join(base, "nowhere"), join(base, "dangling"));
  const { kept, problems } = await problemsFor(
    { a: root(join(base, "to-home")), b: root(join(base, "to-agent")), c: root(join(base, "dangling")) },
    { home, agentDir },
  );
  assert.deepEqual(kept, []);
  assert.match(problems[0]?.[1] ?? "", /home directory/);
  assert.equal(problems[1]?.[1], "overlaps the agent dir");
  assert.match(problems[2]?.[1] ?? "", /does not exist/);
});

test("a symlinked home still counts as home", { skip: !canSymlink }, async () => {
  const { base, home, agentDir } = await sandbox();
  await symlink(home, join(base, "home-link"));
  const { problems } = await problemsFor({ a: root(home) }, { home: join(base, "home-link"), agentDir });
  assert.match(problems[0]?.[1] ?? "", /home directory/);
});

test("resolveRoots compares identities, so a firmlink alias of home or the agent dir is refused", { skip: process.platform !== "darwin" }, async () => {
  const { home, agentDir } = await sandbox();
  const alias = (p: string) => join("/System/Volumes/Data", p);
  try {
    await stat(alias(home));
  } catch {
    return; // no data-volume firmlink for this temp dir
  }
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  const { kept, problems } = await problemsFor(
    {
      home: root(alias(home)),
      volume: root("/System/Volumes/Data"),
      agent: root(alias(agentDir)),
      "agent-parent": root(alias(join(home, ".pi"))),
      inside: root(alias(join(home, ".local", "bin"))),
    },
    { home, agentDir },
  );
  assert.deepEqual(kept, ["inside"]);
  assert.deepEqual(problems, [
    ["agent", "overlaps the agent dir"],
    ["agent-parent", "overlaps the agent dir"],
    ["home", "refusing the home directory or a directory that contains it"],
    ["volume", "refusing the home directory or a directory that contains it"],
  ]);
});

test("resolveRoots refuses two roots that alias one dir under different names", { skip: process.platform !== "darwin" }, async () => {
  const { home, agentDir } = await sandbox();
  const bin = join(home, ".local", "bin");
  await mkdir(bin, { recursive: true });
  try {
    await stat(join("/System/Volumes/Data", bin));
  } catch {
    return;
  }
  const { kept, problems } = await problemsFor({ a: root(bin), b: root(join("/System/Volumes/Data", home, ".local")) }, { home, agentDir });
  assert.deepEqual(kept, ["a"]);
  assert.deepEqual(problems, [["b", 'overlaps root "a"']]);
});

test("resolveRoots does not count a symlink inside a root as containing home", { skip: !canSymlink }, async () => {
  const { base, home, agentDir } = await sandbox();
  const tools = join(base, "tools");
  await mkdir(tools);
  // Named like home's last segment so the tail probe would reach home if it followed links.
  await symlink(home, join(tools, "home"));
  const { kept, problems } = await problemsFor({ tools: root(tools) }, { home, agentDir });
  assert.deepEqual([kept, problems], [["tools"], []]);
});
