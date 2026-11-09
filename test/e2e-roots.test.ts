import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { encodePath, sha256Hex, toGistContent } from "../src/codec.ts";
import type { CommandIO } from "../src/command.ts";
import { runCommand } from "../src/command.ts";
import { createGistClient } from "../src/gist-client.ts";
import { sync } from "../src/sync.ts";
import { MANIFEST_FILE } from "../src/types.ts";
import type { Manifest, ManifestEntry, SyncEnv } from "../src/types.ts";
import type { FakeGistServer } from "./helpers/fake-gist-server.ts";
import { FAKE_TOKEN, startFakeGist } from "./helpers/fake-gist-server.ts";

// Roots end to end: real sync, real command layer and real HTTP client against the
// fake gist server, with a temp agent dir AND a temp home per machine.

const dirs: string[] = [];
const servers: FakeGistServer[] = [];

after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function fresh(): Promise<FakeGistServer> {
  const fake = await startFakeGist();
  servers.push(fake);
  return fake;
}

async function tempDir(label: string): Promise<string> {
  // realpath: macOS tmpdir is behind /var -> /private/var, and resolveRoots reports real paths.
  const dir = await realpath(await mkdtemp(join(tmpdir(), `gist-sync-roots-${label}-`)));
  dirs.push(dir);
  return dir;
}

interface Prompt {
  title: string;
  message: string;
}

interface Machine {
  agentDir: string;
  home: string;
  prompts: Prompt[];
  run(args: string, opts?: { confirm?: boolean }): Promise<string>;
  env(): SyncEnv;
}

async function machine(fake: FakeGistServer, name: string, config?: Record<string, unknown>): Promise<Machine> {
  const agentDir = await tempDir(`${name}-agent`);
  const home = await tempDir(`${name}-home`);
  if (config) await writeFile(join(agentDir, "gist-sync.json"), JSON.stringify(config));
  const client = createGistClient({ token: FAKE_TOKEN, baseUrl: fake.baseUrl, maxRetries: 0 });
  const notes: { message: string; level: string }[] = [];
  const m: Machine = {
    agentDir,
    home,
    prompts: [],
    async run(args, opts = {}) {
      const start = notes.length;
      const io: CommandIO = {
        hasUI: true,
        notify: (message, level) => void notes.push({ message, level }),
        confirm: async (title, message) => {
          m.prompts.push({ title, message });
          return opts.confirm ?? true;
        },
        input: async () => undefined,
        reload: async () => {},
        exec: async () => ({ stdout: "", code: 1 }),
      };
      await runCommand(args, io, { agentDir, home, client, env: {} });
      return notes
        .slice(start)
        .map((n) => `${n.level}: ${n.message}`)
        .join("\n");
    },
    env: () => ({ agentDir, home, client, hostname: `host-${name}`, version: "0.0.0-e2e", now: () => new Date() }),
  };
  return m;
}

async function put(full: string, content: string | Uint8Array, mode = 0o644): Promise<void> {
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  await chmod(full, mode);
}

const modeOf = async (full: string) => (await stat(full)).mode & 0o777;
const textOf = (full: string) => readFile(full, "utf8");

async function missing(full: string): Promise<boolean> {
  try {
    await stat(full);
    return false;
  } catch {
    return true;
  }
}

/** Every entry under `dir`, symlinks listed rather than followed. */
async function tree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(`${rel}/`, ...(await tree(dir, rel)));
    else out.push(entry.isSymbolicLink() ? `${rel}@` : rel);
  }
  return out.sort();
}

function lastGistId(fake: FakeGistServer): string {
  const id = [...fake.gists.keys()].at(-1);
  assert.ok(id, "a gist exists");
  return id;
}

function manifestOf(fake: FakeGistServer, id: string): Manifest {
  return JSON.parse(fake.gists.get(id)?.files[MANIFEST_FILE] ?? "{}") as Manifest;
}

/** Writes a hand-built manifest straight into the server, as a hostile gist owner could. */
function plant(fake: FakeGistServer, id: string, extra: Record<string, string>): void {
  const gist = fake.gists.get(id);
  assert.ok(gist);
  const manifest = manifestOf(fake, id);
  for (const [path, text] of Object.entries(extra)) {
    const bytes = new Uint8Array(Buffer.from(text, "utf8"));
    const enc = toGistContent(bytes);
    assert.ok(enc);
    const entry: ManifestEntry = { gist: encodePath(path), digest: sha256Hex(bytes), size: bytes.length, mode: 0o755, enc: enc.enc, protection: "plain" };
    manifest.files[path] = entry;
    gist.files[encodePath(path)] = enc.content;
  }
  manifest.revision += 1;
  manifest.updatedAt = new Date().toISOString();
  gist.files[MANIFEST_FILE] = `${JSON.stringify(manifest, null, 2)}\n`;
  gist.updatedAt = manifest.updatedAt;
}

const PIWT = "#!/bin/sh\necho piwt from a\n";
const WTW = "#!/usr/bin/env bash\necho wtw\n";
const TOML = '[worktree]\npath = "~/wt"\n';

describe("roots: two machines over HTTP", () => {
  it("syncs root files only where each machine configured them, approval-gated, and nothing escapes", async () => {
    const fake = await fresh();
    // A configures roots before init, so init must keep them.
    const a = await machine(fake, "a");
    const binA = join(a.home, ".local/bin");
    const cfgA = join(a.home, ".config");
    await writeFile(
      join(a.agentDir, "gist-sync.json"),
      JSON.stringify({
        roots: {
          "local-bin": { dir: `${a.home}/.local/bin`, include: ["piwt", "wtw"] },
          cfg: { dir: `${a.home}/.config`, include: ["worktrunk/config.toml"] },
        },
      }),
    );
    await put(join(binA, "piwt"), PIWT, 0o755);
    await put(join(binA, "wtw"), WTW, 0o777);
    await put(join(binA, "not-included"), "#!/bin/sh\n", 0o755);
    await put(join(cfgA, "worktrunk/config.toml"), TOML, 0o644);
    await put(join(cfgA, "other/app.toml"), "x = 1\n");

    assert.doesNotMatch(await a.run("init"), /^error/m);
    const id = lastGistId(fake);
    const pushA = await a.run("push");
    assert.doesNotMatch(pushA, /^(error|warning)/m, pushA);

    const manifest = manifestOf(fake, id);
    assert.deepEqual(Object.keys(manifest.files).sort(), ["@cfg/worktrunk/config.toml", "@local-bin/piwt", "@local-bin/wtw"]);
    assert.equal(manifest.files["@local-bin/piwt"]?.mode, 0o755, "exec bit recorded");
    const gist = fake.gists.get(id);
    assert.ok(gist);
    assert.equal(gist.files["@local-bin%2Fpiwt"], PIWT);
    assert.ok(Object.keys(gist.files).every((n) => !n.includes("/")), "gist stays flat");
    const wireA = fake.requests.map((r) => r.body).join("\n");
    assert.ok(!wireA.includes("not-included") && !wireA.includes("app.toml"), "files outside the include globs stay local");
    assert.ok(!wireA.includes(a.home), "absolute root dirs never reach the gist");

    // ---- B links without roots: nothing written, one hint per root ----
    const b = await machine(fake, "b");
    const binB = join(b.home, ".local/bin");
    const cfgB = join(b.home, ".config");
    await mkdir(binB, { recursive: true });
    await mkdir(cfgB, { recursive: true });
    assert.doesNotMatch(await b.run(`init ${id}`), /^error/m);
    const homeBefore = await tree(b.home);

    const bare = await b.run("pull");
    assert.doesNotMatch(bare, /^error/m, bare);
    assert.match(bare, /2 file\(s\) under root "local-bin" were not applied\. Configure it locally with: \/gist-sync roots add local-bin <dir> <glob\.\.\.>/);
    assert.match(bare, /1 file\(s\) under root "cfg" were not applied\. Configure it locally with: \/gist-sync roots add cfg <dir> <glob\.\.\.>/);
    assert.deepEqual(await tree(b.home), homeBefore, "nothing written under B's home");
    assert.ok((await tree(b.agentDir)).every((p) => !p.startsWith("@") && !p.includes("piwt")), "nothing written in B's agent dir");
    assert.equal(b.prompts.length, 0, "nothing to approve");
    const statusBare = await b.run("status");
    assert.match(statusBare, /roots add local-bin/, "status carries the hint too");

    // ---- B adds its own roots and pulls ----
    const addBin = await b.run(`roots add local-bin ${binB} piwt wtw sub/*`);
    assert.match(addBin, /^info: Root "local-bin" added: .* \(3 include glob\(s\)\)\. Everything under a root needs approval on pull\./, addBin);
    const addCfg = await b.run("roots add cfg ~/.config worktrunk/config.toml");
    assert.match(addCfg, /^info: Root "cfg" added/, addCfg);
    const listed = await b.run("roots");
    assert.match(listed, /local-bin/);
    assert.match(listed, /cfg/);
    assert.doesNotMatch(listed, /ignored|does not exist|overlaps/);

    const pulled = await b.run("pull");
    assert.doesNotMatch(pulled, /^error/m, pulled);
    const prompt = b.prompts.find((p) => p.title === "Apply changes from the gist?");
    assert.ok(prompt, "pull asked for approval");
    assert.match(prompt.message, /Code and settings Pi runs \(3\)/);
    assert.doesNotMatch(prompt.message, /Instructions|Other files/, "every root file is code tier");
    assert.ok(prompt.message.includes(`add @local-bin/piwt -> ${join(binB, "piwt")}`), prompt.message);
    assert.ok(prompt.message.includes(`add @local-bin/wtw -> ${join(binB, "wtw")}`), prompt.message);
    assert.ok(prompt.message.includes(`add @cfg/worktrunk/config.toml -> ${join(cfgB, "worktrunk/config.toml")}`), prompt.message);

    assert.equal(await textOf(join(binB, "piwt")), PIWT);
    assert.equal(await modeOf(join(binB, "piwt")), 0o755, "exec bit preserved");
    assert.equal(await textOf(join(binB, "wtw")), WTW);
    assert.equal(await modeOf(join(binB, "wtw")), 0o755, "group and world write dropped");
    assert.equal(await textOf(join(cfgB, "worktrunk/config.toml")), TOML);
    assert.deepEqual(
      await tree(b.home),
      [...homeBefore, ".config/worktrunk/", ".config/worktrunk/config.toml", ".local/bin/piwt", ".local/bin/wtw"].sort(),
      "only the root files were written under B's home",
    );
    assert.ok((await tree(b.agentDir)).every((p) => !p.startsWith("@")), "root files never land in the agent dir");
    const settled = await sync.status(b.env());
    assert.deepEqual([settled.ahead, settled.behind, settled.conflicts], [[], [], []]);

    // ---- B edits and pushes, A pulls with approval and a backup ----
    const PIWT_B = "#!/bin/sh\necho piwt from b\n";
    await writeFile(join(binB, "piwt"), PIWT_B);
    const pushB = await b.run("push");
    assert.doesNotMatch(pushB, /^error/m, pushB);
    assert.equal(fake.gists.get(id)?.files["@local-bin%2Fpiwt"], PIWT_B);

    const pullA = await a.run("pull");
    assert.doesNotMatch(pullA, /^error/m, pullA);
    const promptA = a.prompts.find((p) => p.title === "Apply changes from the gist?");
    assert.ok(promptA?.message.includes(`update @local-bin/piwt -> ${join(binA, "piwt")}`), promptA?.message);
    assert.equal(await textOf(join(binA, "piwt")), PIWT_B);
    assert.equal(await modeOf(join(binA, "piwt")), 0o755);
    const backups = await readdir(join(a.agentDir, "gist-sync-backups"));
    assert.equal(backups.length, 1);
    assert.equal(await textOf(join(a.agentDir, "gist-sync-backups", backups[0] as string, "@local-bin/piwt")), PIWT);

    // ---- a declined approval writes nothing ----
    await writeFile(join(binA, "wtw"), "#!/bin/sh\necho declined\n");
    assert.doesNotMatch(await a.run("push"), /^error/m);
    const declined = await b.run("pull", { confirm: false });
    assert.match(declined, /^error: .*cancelled/im, declined);
    assert.equal(await textOf(join(binB, "wtw")), WTW, "declined pull left the root file alone");
    assert.match(await b.run("pull"), /Pulled 1 file/);

    // ---- hostile gist, part 1: a `..` path rejects the whole manifest ----
    const outsideB = await tempDir("b-outside");
    const homeSnap = await tree(b.home);
    const agentSnap = await tree(b.agentDir);
    plant(fake, id, { "@local-bin/../escape": "#!/bin/sh\necho pwned\n", "@local-bin/piwt": "#!/bin/sh\necho hijack\n" });
    const traversal = await b.run("pull --yes");
    assert.match(traversal, /^error: Unsafe path "@local-bin\/\.\.\/escape"/m, traversal);
    assert.equal(await textOf(join(binB, "piwt")), PIWT_B, "no entry of a bad manifest is applied");
    assert.ok(await missing(join(b.home, ".local/escape")), "nothing escaped the root");
    assert.deepEqual(await tree(b.home), homeSnap);
    assert.deepEqual(await tree(b.agentDir), agentSnap);

    // ---- hostile gist, part 2: unconfigured root and a symlinked subdir in the root ----
    const gistNow = fake.gists.get(id);
    assert.ok(gistNow);
    const restored = manifestOf(fake, id);
    delete restored.files["@local-bin/../escape"];
    delete gistNow.files[encodePath("@local-bin/../escape")];
    gistNow.files["@local-bin%2Fpiwt"] = PIWT_B;
    restored.files["@local-bin/piwt"] = { ...(restored.files["@local-bin/piwt"] as ManifestEntry), digest: sha256Hex(Buffer.from(PIWT_B)), size: Buffer.byteLength(PIWT_B) };
    gistNow.files[MANIFEST_FILE] = `${JSON.stringify(restored, null, 2)}\n`;
    await symlink(outsideB, join(binB, "sub"));
    const homeSnap2 = await tree(b.home);
    plant(fake, id, { "@evil/x": "#!/bin/sh\necho evil\n", "@local-bin/sub/pwn": "#!/bin/sh\necho through symlink\n" });
    const hostile = await b.run("pull --yes");
    assert.doesNotMatch(hostile, /^error/m, hostile);
    assert.match(hostile, /1 file\(s\) under root "evil" were not applied/);
    assert.match(hostile, /Skipped @evil\/x: excluded \(root "evil" is not configured\)/);
    assert.match(hostile, /Skipped @local-bin\/sub\/pwn: symlink/);
    assert.deepEqual(await readdir(outsideB), [], "nothing written through the symlinked subdir");
    assert.deepEqual(await tree(b.home), homeSnap2, "nothing new under B's home");
    assert.ok((await tree(b.agentDir)).every((p) => !p.includes("evil") && !p.includes("pwn")), "nothing landed in the agent dir");
    assert.equal(await textOf(join(binB, "piwt")), PIWT_B);
  });

  it("never uploads a credential-looking file or a native binary from a root", async () => {
    const fake = await fresh();
    const a = await machine(fake, "creds");
    const tools = join(a.home, "tools");
    const SECRET = "E2E-ROOT-SECRET-7c1d";
    const MACHO = new Uint8Array([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56]);
    const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x61, 0x62, 0x63, 0x64]);
    await put(join(tools, ".env"), `API_KEY=${SECRET}\n`, 0o600);
    await put(join(tools, "gh-token.json"), JSON.stringify({ t: SECRET }), 0o600);
    await put(join(tools, "fd-mac"), MACHO, 0o755);
    await put(join(tools, "rg-linux"), ELF, 0o755);
    await put(join(tools, "ok.sh"), "#!/bin/sh\necho ok\n", 0o755);
    await writeFile(
      join(a.agentDir, "gist-sync.json"),
      JSON.stringify({ roots: { tools: { dir: "~/tools", include: [".env", "gh-token.json", "fd-mac", "rg-linux", "ok.sh"] } } }),
    );
    await a.run("init");
    const id = lastGistId(fake);
    const pushed = await sync.push(a.env(), {});
    assert.deepEqual(pushed.added, ["@tools/ok.sh"]);
    assert.deepEqual(
      pushed.skipped.map((s) => [s.path, s.reason]),
      [
        ["@tools/.env", "credential"],
        ["@tools/fd-mac", "native-binary"],
        ["@tools/gh-token.json", "credential"],
        ["@tools/rg-linux", "native-binary"],
      ],
    );

    const gist = fake.gists.get(id);
    assert.ok(gist);
    const wire = [...fake.requests.flatMap((r) => [r.url, r.body]), ...Object.entries(gist.files).flat()].join("\n");
    assert.ok(!wire.includes(SECRET), "credential value never reached the server");
    for (const name of [".env", "gh-token", "fd-mac", "rg-linux"]) {
      assert.ok(!wire.includes(name), `${name} never reached the server`);
    }
    for (const bin of [MACHO, ELF]) {
      assert.ok(!wire.includes(Buffer.from(bin).toString("base64")), "binary bytes never reached the server");
    }
  });
});
