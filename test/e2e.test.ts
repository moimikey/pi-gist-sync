import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { CommandIO } from "../src/command.ts";
import { runCommand } from "../src/command.ts";
import { createGistClient } from "../src/gist-client.ts";
import { canonicalSettings } from "../src/settings-merge.ts";
import { sync } from "../src/sync.ts";
import { GistSyncError, MANIFEST_FILE } from "../src/types.ts";
import type { GistClient, PullPlan, PullResult, PushResult, SyncEnv } from "../src/types.ts";
import type { FakeGistServer } from "./helpers/fake-gist-server.ts";
import { FAKE_TOKEN, startFakeGist } from "./helpers/fake-gist-server.ts";

// Real sync + real HTTP client against the fake gist server, driven both through
// the sync API and through the command layer. Unit suites stub one side of each
// seam; this is the only place the seams meet.

const PASSPHRASE = "correct horse battery staple";
const dirs: string[] = [];
let server: FakeGistServer;

before(async () => {
  server = await startFakeGist();
});
after(async () => {
  await server.close();
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

interface Machine {
  agentDir: string;
  notes: { message: string; level: string }[];
  reloads: number;
  run(args: string, opts?: { env?: NodeJS.ProcessEnv; confirm?: boolean }): Promise<string>;
}

async function machine(config?: Record<string, unknown>): Promise<Machine> {
  const agentDir = await mkdtemp(join(tmpdir(), "gist-sync-e2e-"));
  dirs.push(agentDir);
  if (config) await writeFile(join(agentDir, "gist-sync.json"), JSON.stringify(config));
  const m: Machine = {
    agentDir,
    notes: [],
    reloads: 0,
    async run(args, opts = {}) {
      const before = m.notes.length;
      const io: CommandIO = {
        hasUI: true,
        notify: (message, level) => void m.notes.push({ message, level }),
        confirm: async () => opts.confirm ?? true,
        input: async () => undefined,
        reload: async () => void m.reloads++,
        exec: async () => ({ stdout: "", code: 1 }),
      };
      const client = createGistClient({ token: FAKE_TOKEN, baseUrl: server.baseUrl, maxRetries: 0 });
      await runCommand(args, io, { agentDir, client, env: { ...opts.env } });
      return m.notes
        .slice(before)
        .map((n) => `${n.level}: ${n.message}`)
        .join("\n");
    },
  };
  return m;
}

async function put(m: Machine, rel: string, content: string | Uint8Array, mode = 0o644): Promise<void> {
  const full = join(m.agentDir, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, { mode });
}

const read = (m: Machine, rel: string) => readFile(join(m.agentDir, rel), "utf8");

function lastGistId(): string {
  const ids = [...server.gists.keys()];
  const id = ids[ids.length - 1];
  assert.ok(id, "a gist exists");
  return id;
}

// ---- sync API directly: real sync.ts + real HTTP client, two agent dirs ----

const SECRET = "E2E-SECRET-MARKER-9f3a1c";
const AUTH_JSON = JSON.stringify({ anthropic: { type: "oauth", access: SECRET } });
const BINARY = new Uint8Array([0x00, 0xff, 0xfe, 0x01, 0x80, 0x00, 0x0a, 0xc3, 0x28]);
const servers: FakeGistServer[] = [];
let tick = 0;

interface Box {
  agentDir: string;
  client: GistClient;
  env(passphrase?: string): SyncEnv;
}

async function box(fake: FakeGistServer, name: string, config?: Record<string, unknown>): Promise<Box> {
  const agentDir = await mkdtemp(join(tmpdir(), `gist-sync-e2e-${name}-`));
  dirs.push(agentDir);
  if (config) await writeFile(join(agentDir, "gist-sync.json"), JSON.stringify(config));
  const client = createGistClient({ token: FAKE_TOKEN, baseUrl: fake.baseUrl, maxRetries: 0 });
  return {
    agentDir,
    client,
    // A ticking clock keeps each pull's backup dir distinct.
    env: (passphrase) => ({
      agentDir,
      client,
      hostname: `host-${name}`,
      version: "0.0.0-e2e",
      now: () => new Date(Date.UTC(2026, 10, 5, 12, 0, tick++)),
      ...(passphrase === undefined ? {} : { passphrase }),
    }),
  };
}

// These flows are not about the approval gate, so pulls approve by default; a test passes its own to override.
const pull = (env: SyncEnv, opts: Parameters<typeof sync.pull>[1] = {}) => sync.pull(env, { confirm: async () => true, ...opts });

async function fresh(): Promise<FakeGistServer> {
  const fake = await startFakeGist();
  servers.push(fake);
  return fake;
}

async function write(b: Box, rel: string, content: string | Uint8Array, mode = 0o644): Promise<void> {
  const full = join(b.agentDir, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
  await chmod(full, mode);
}

const bytesOf = (b: Box, rel: string) => readFile(join(b.agentDir, rel));
const textOf = async (b: Box, rel: string) => (await bytesOf(b, rel)).toString("utf8");
const modeOf = async (b: Box, rel: string) => (await stat(join(b.agentDir, rel))).mode & 0o777;
const settingsOf = async (b: Box) => JSON.parse(await textOf(b, "settings.json")) as Record<string, unknown>;

async function tree(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await tree(dir, rel)));
    else out.push(rel);
  }
  return out.sort();
}

function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
  return assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof GistSyncError, `expected GistSyncError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (message) assert.match(err.message, message);
    return true;
  });
}

const SYNCED_FILES: Record<string, { content: string | Uint8Array; mode: number }> = {
  "extensions/foo/index.ts": { content: "export default function () {}\n", mode: 0o644 },
  "extensions/foo/run.sh": { content: "#!/bin/sh\necho hi\n", mode: 0o755 },
  "skills/x/SKILL.md": { content: "---\nname: x\n---\n# x\n", mode: 0o600 },
  "skills/x/refs/deep/notes.md": { content: "nested\n", mode: 0o644 },
  "skills/x/100% \u00fcn\u00ef.md": { content: "percent and unicode name\n", mode: 0o644 },
  "skills/x/logo.bin": { content: BINARY, mode: 0o640 },
  "prompts/empty.md": { content: "", mode: 0o644 },
  "prompts/blank.md": { content: "   \n\t\n", mode: 0o644 },
};

interface Pair {
  fake: FakeGistServer;
  a: Box;
  b: Box;
  gistId: string;
  pushA: PushResult;
  blocked: unknown;
  pullB: PullResult;
}

// Machine A pushes a full fixture; machine B (with its own settings.json) links and force-pulls.
async function linkedPair(): Promise<Pair> {
  const fake = await fresh();
  const a = await box(fake, "a");
  const b = await box(fake, "b");
  await write(
    a,
    "settings.json",
    JSON.stringify({
      theme: "dark",
      packages: ["npm:pi-foo@1.0.0"],
      shellPath: "/a/bin/zsh",
      lastChangelogVersion: "0.9.0",
    }),
  );
  for (const [rel, f] of Object.entries(SYNCED_FILES)) await write(a, rel, f.content, f.mode);
  await write(a, "auth.json", AUTH_JSON, 0o600);

  const init = await sync.init(a.env(), {});
  assert.equal(init.created, true);
  const pushA = await sync.push(a.env(), {});

  await write(b, "settings.json", JSON.stringify({ theme: "light", shellPath: "/b/bin/fish", httpProxy: "http://proxy.b:3128" }));
  await sync.init(b.env(), { gistId: init.gistId });
  let blocked: unknown;
  await pull(b.env(), {}).catch((err: unknown) => void (blocked = err));
  const pullB = await pull(b.env(), { force: true });
  return { fake, a, b, gistId: init.gistId, pushA, blocked, pullB };
}

describe("sync API: machine A to machine B over HTTP", () => {
  it("replicates bytes and modes, and never uploads auth.json or machine-local keys", async () => {
    const { fake, a, b, gistId, pushA, blocked, pullB } = await linkedPair();

    assert.equal(pushA.noop, false);
    assert.equal(pushA.revision, 1);
    assert.deepEqual(pushA.skipped.map((s) => [s.path, s.reason]), [["auth.json", "credential"]]);
    assert.deepEqual(
      pushA.added,
      ["settings.json", ...Object.keys(SYNCED_FILES)].sort(),
      "every synced file is added, auth.json is not",
    );

    // B's first pull differs on settings.json, which is a conflict by design.
    assert.ok(blocked instanceof GistSyncError && blocked.code === "CONFLICT", String(blocked));
    assert.match((blocked as GistSyncError).message, /settings\.json/);
    assert.ok(pullB.backupDir, "force pull backs up the overwritten settings.json");
    const backedUp = JSON.parse(await readFile(join(pullB.backupDir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal(backedUp.theme, "light");
    assert.equal(backedUp.shellPath, "/b/bin/fish");

    for (const [rel, f] of Object.entries(SYNCED_FILES)) {
      assert.deepEqual(await bytesOf(b, rel), await bytesOf(a, rel), `${rel} is byte-identical`);
      assert.equal(await modeOf(b, rel), f.mode, `${rel} keeps mode ${f.mode.toString(8)}`);
    }
    assert.equal((await bytesOf(b, "prompts/empty.md")).length, 0);
    assert.equal(await textOf(b, "prompts/blank.md"), "   \n\t\n");
    assert.deepEqual([...(await bytesOf(b, "skills/x/logo.bin"))], [...BINARY]);

    const settings = await settingsOf(b);
    assert.equal(settings.theme, "dark");
    assert.deepEqual(settings.packages, ["npm:pi-foo@1.0.0"]);
    assert.equal(settings.shellPath, "/b/bin/fish", "B keeps its own shellPath");
    assert.equal(settings.httpProxy, "http://proxy.b:3128", "B keeps its own httpProxy");
    assert.equal(settings.lastChangelogVersion, undefined, "A's machine-local value does not leak to B");
    assert.equal(
      canonicalSettings(await textOf(b, "settings.json")),
      canonicalSettings(await textOf(a, "settings.json")),
      "settings agree once machine-local keys are stripped",
    );
    assert.equal(pullB.needsReload, true);
    await assert.rejects(stat(join(b.agentDir, "auth.json")), "auth.json does not exist on B");

    // Nothing sensitive ever crossed the wire.
    const gist = fake.gists.get(gistId);
    assert.ok(gist);
    assert.equal(gist.public, false);
    const manifest = JSON.parse(gist.files[MANIFEST_FILE] ?? "{}") as { files: Record<string, unknown> };
    assert.equal(manifest.files["auth.json"], undefined);
    const wire = [
      ...fake.requests.flatMap((r) => [r.url, r.body]),
      ...Object.entries(gist.files).flat(),
    ].join("\n");
    assert.ok(!wire.includes(SECRET), "credential value never reached the server");
    assert.ok(!wire.includes("auth.json"), "credential path never reached the server");
    for (const local of ["/a/bin/zsh", "0.9.0", "/b/bin/fish", "proxy.b"]) {
      assert.ok(!wire.includes(local), `machine-local value ${local} never reached the server`);
    }
    assert.ok(Object.keys(gist.files).every((n) => !n.includes("/")), "gist stays flat");
    assert.equal(gist.files["prompts%2Fempty.md"], undefined, "empty file has no gist file");
    assert.ok(fake.requests.every((r) => r.headers.authorization === `Bearer ${FAKE_TOKEN}`));

    const status = await sync.status(b.env());
    assert.deepEqual([status.ahead, status.behind, status.conflicts], [[], [], []]);
  });

  it("propagates an edit, an add and a delete from B to A, keeping A's machine-local keys", async () => {
    const { fake, a, b, gistId } = await linkedPair();

    await write(b, "extensions/foo/index.ts", "export default function () { /* b */ }\n");
    await write(b, "skills/x/new.md", "added on b\n", 0o600);
    await rm(join(b.agentDir, "prompts/blank.md"));
    await write(
      b,
      "settings.json",
      JSON.stringify({
        theme: "dark",
        packages: ["npm:pi-foo@1.0.0", "npm:pi-bar@2.0.0"],
        shellPath: "/b/bin/fish",
        lastChangelogVersion: "7.7.7",
      }),
    );
    const pushB = await sync.push(b.env(), {});
    assert.deepEqual(pushB.added, ["skills/x/new.md"]);
    assert.deepEqual(pushB.updated, ["extensions/foo/index.ts", "settings.json"]);
    assert.deepEqual(pushB.deleted, ["prompts/blank.md"]);
    assert.equal(pushB.revision, 2);
    const remoteSettings = fake.gists.get(gistId)?.files["settings.json"] ?? "";
    assert.ok(remoteSettings.includes("pi-bar"));
    assert.ok(!remoteSettings.includes("/b/bin/fish") && !remoteSettings.includes("7.7.7"));

    const patchesBefore = fake.requests.filter((r) => r.method === "PATCH").length;
    assert.equal((await sync.push(b.env(), {})).noop, true, "second push is a noop");
    assert.equal(fake.requests.filter((r) => r.method === "PATCH").length, patchesBefore, "the noop push made no write");

    const status = await sync.status(a.env());
    assert.deepEqual(status.behind, ["extensions/foo/index.ts", "prompts/blank.md", "settings.json", "skills/x/new.md"]);

    let asked: PullPlan | undefined;
    const pullA = await pull(a.env(), {
      confirm: async (plan) => {
        asked = plan;
        return true;
      },
    });
    assert.deepEqual(
      asked?.review.map((r) => r.path),
      ["extensions/foo/index.ts", "settings.json", "skills/x/new.md"],
      "confirm sees code, instruction files and a settings change that touches packages",
    );
    assert.deepEqual(asked?.localOnly, ["prompts/blank.md"]);
    assert.equal(pullA.needsReload, true);
    assert.equal(await textOf(a, "extensions/foo/index.ts"), "export default function () { /* b */ }\n");
    assert.equal(await textOf(a, "skills/x/new.md"), "added on b\n");
    assert.equal(await modeOf(a, "skills/x/new.md"), 0o600);
    assert.equal(await textOf(a, "prompts/blank.md"), "   \n\t\n", "remote delete is kept locally without --prune");
    const settings = await settingsOf(a);
    assert.deepEqual(settings.packages, ["npm:pi-foo@1.0.0", "npm:pi-bar@2.0.0"]);
    assert.equal(settings.shellPath, "/a/bin/zsh");
    assert.equal(settings.lastChangelogVersion, "0.9.0");

    const pruned = await pull(a.env(), { prune: true });
    assert.deepEqual(pruned.applied, ["prompts/blank.md"]);
    await assert.rejects(stat(join(a.agentDir, "prompts/blank.md")));
    assert.ok(pruned.backupDir);
    assert.equal(await readFile(join(pruned.backupDir, "prompts/blank.md"), "utf8"), "   \n\t\n");

    const after = await sync.status(a.env());
    assert.deepEqual([after.ahead, after.behind, after.conflicts], [[], [], []]);
  });

  it("concurrent edits conflict on both push and pull, and pull --force backs up the loser", async () => {
    const { fake, a, b, gistId } = await linkedPair();

    await write(a, "extensions/foo/index.ts", "// edited on a\n");
    await write(a, "skills/x/SKILL.md", "only a edited this\n", 0o600);
    await write(b, "extensions/foo/index.ts", "// edited on b\n");
    await sync.push(a.env(), {});
    const revisionAfterA = (JSON.parse(fake.gists.get(gistId)?.files[MANIFEST_FILE] ?? "{}") as { revision: number }).revision;
    assert.equal(revisionAfterA, 2);

    await rejectsWith(sync.push(b.env(), {}), "CONFLICT", /extensions\/foo\/index\.ts/);
    const manifestAfter = JSON.parse(fake.gists.get(gistId)?.files[MANIFEST_FILE] ?? "{}") as { revision: number };
    assert.equal(manifestAfter.revision, revisionAfterA, "blocked push left the gist alone");
    assert.equal(fake.gists.get(gistId)?.files["extensions%2Ffoo%2Findex.ts"], "// edited on a\n");

    const status = await sync.status(b.env());
    assert.deepEqual(status.conflicts, ["extensions/foo/index.ts"]);
    assert.deepEqual(status.behind, ["skills/x/SKILL.md"], "conflicts are reported separately from behind");

    await rejectsWith(pull(b.env(), {}), "CONFLICT", /extensions\/foo\/index\.ts/);
    assert.equal(await textOf(b, "extensions/foo/index.ts"), "// edited on b\n", "blocked pull wrote nothing");
    assert.equal(await textOf(b, "skills/x/SKILL.md"), "---\nname: x\n---\n# x\n", "blocked pull applied no other file");

    const forced = await pull(b.env(), { force: true });
    assert.ok(forced.backupDir);
    assert.equal(await readFile(join(forced.backupDir, "extensions/foo/index.ts"), "utf8"), "// edited on b\n");
    assert.equal(await textOf(b, "extensions/foo/index.ts"), "// edited on a\n");
    assert.equal(await textOf(b, "skills/x/SKILL.md"), "only a edited this\n");
    assert.equal(await modeOf(b, "skills/x/SKILL.md"), 0o600);
    const settled = await sync.status(b.env());
    assert.deepEqual([settled.ahead, settled.behind, settled.conflicts], [[], [], []], "backups are not scanned as local changes");
    assert.equal((await sync.push(b.env(), {})).noop, true);
  });

  it("push --force overwrites the gist after a conflict", async () => {
    const { fake, a, b, gistId } = await linkedPair();
    await write(a, "skills/x/refs/deep/notes.md", "a wins?\n");
    await write(b, "skills/x/refs/deep/notes.md", "b wins\n");
    await sync.push(a.env(), {});
    await rejectsWith(sync.push(b.env(), {}), "CONFLICT");
    const forced = await sync.push(b.env(), { force: true });
    assert.deepEqual(forced.updated, ["skills/x/refs/deep/notes.md"]);
    assert.equal(fake.gists.get(gistId)?.files["skills%2Fx%2Frefs%2Fdeep%2Fnotes.md"], "b wins\n");
    await pull(a.env(), {});
    assert.equal(await textOf(a, "skills/x/refs/deep/notes.md"), "b wins\n");
  });
});

describe("sync API: credentials encrypt mode over HTTP", () => {
  async function encryptedPair() {
    const fake = await fresh();
    const a = await box(fake, "enc-a", { credentials: "encrypt" });
    await write(a, "auth.json", AUTH_JSON, 0o600);
    await write(a, "AGENTS.md", "plain instructions\n");
    const { gistId } = await sync.init(a.env(PASSPHRASE), {});
    const pushed = await sync.push(a.env(PASSPHRASE), {});
    return { fake, a, gistId, pushed };
  }

  it("round-trips auth.json with a passphrase and only ever uploads ciphertext", async () => {
    const { fake, gistId, pushed } = await encryptedPair();
    assert.deepEqual(pushed.skipped, []);
    assert.deepEqual(pushed.added, ["AGENTS.md", "auth.json"]);

    const gist = fake.gists.get(gistId);
    assert.ok(gist);
    const manifest = JSON.parse(gist.files[MANIFEST_FILE] ?? "{}") as {
      crypto?: unknown;
      files: Record<string, { protection: string }>;
    };
    assert.equal(manifest.files["auth.json"]?.protection, "encrypted");
    assert.equal(manifest.files["AGENTS.md"]?.protection, "plain");
    assert.ok(manifest.crypto, "kdf params are recorded");
    const wire = [...fake.requests.map((r) => r.body), ...Object.values(gist.files)].join("\n");
    assert.ok(!wire.includes(SECRET), "plaintext credential never reached the server");
    assert.ok(!wire.includes(PASSPHRASE), "passphrase never reached the server");

    const b = await box(fake, "enc-b", { credentials: "encrypt" });
    await sync.init(b.env(), { gistId });
    const pulled = await pull(b.env(PASSPHRASE), {});
    assert.deepEqual(pulled.applied, ["AGENTS.md", "auth.json"]);
    assert.equal(await textOf(b, "auth.json"), AUTH_JSON);
    assert.equal(await modeOf(b, "auth.json"), 0o600);
    const status = await sync.status(b.env(PASSPHRASE));
    assert.deepEqual([status.ahead, status.behind, status.conflicts], [[], [], []]);
  });

  it("a wrong passphrase fails with BAD_PASSPHRASE and writes no files", async () => {
    const { fake, gistId } = await encryptedPair();
    const c = await box(fake, "enc-c", { credentials: "encrypt" });
    await sync.init(c.env(), { gistId });
    const before = await tree(c.agentDir);

    await rejectsWith(pull(c.env("wrong passphrase"), {}), "BAD_PASSPHRASE");
    await rejectsWith(pull(c.env("wrong passphrase"), { force: true }), "BAD_PASSPHRASE");
    assert.deepEqual(await tree(c.agentDir), before, "no file, backup or state was written");
    assert.equal(before.includes("AGENTS.md"), false);

    // The right passphrase still works afterwards, so the failed run left nothing half-applied.
    await pull(c.env(PASSPHRASE), {});
    assert.equal(await textOf(c, "auth.json"), AUTH_JSON);
  });

  it("a wrong passphrase cannot push into an encrypted gist", async () => {
    const { fake, a, gistId } = await encryptedPair();
    await write(a, "AGENTS.md", "changed\n");
    const requestsBefore = fake.requests.length;
    await rejectsWith(sync.push(a.env("wrong passphrase"), {}), "BAD_PASSPHRASE");
    assert.equal(
      fake.requests.slice(requestsBefore).filter((r) => r.method === "PATCH").length,
      0,
      "nothing was written to the gist",
    );
    assert.ok(!(fake.gists.get(gistId)?.files["AGENTS.md"] ?? "").includes("changed"));
  });

  it("without a passphrase, encrypted files are skipped and the rest still applies", async () => {
    const { fake, gistId } = await encryptedPair();
    const d = await box(fake, "enc-d", { credentials: "encrypt" });
    await sync.init(d.env(), { gistId });
    const pulled = await pull(d.env(), {});
    assert.deepEqual(pulled.applied, ["AGENTS.md"]);
    assert.match(pulled.lines.join("\n"), /auth\.json/);
    await assert.rejects(stat(join(d.agentDir, "auth.json")));
  });
});

describe("command layer: two machines through the fake gist server", () => {
  it("init, push, then init <id> and pull on a second machine", async () => {
    const a = await machine();
    await put(a, "settings.json", JSON.stringify({ theme: "dark", packages: ["npm:foo"], shellPath: "/bin/a" }));
    await put(a, "skills/review/SKILL.md", "# review\n");
    await put(a, "extensions/hello.ts", "export default () => {};\n");
    await put(a, "prompts/empty.md", "");
    await put(a, "prompts/blank.md", "  \n");
    await put(a, "themes/bin.json", "{}");
    await put(a, "skills/100%/a b.md", "weird name\n");

    const init = await a.run("init");
    assert.doesNotMatch(init, /^error/m);
    const id = lastGistId();

    const push = await a.run("push");
    assert.doesNotMatch(push, /^error/m, push);
    const gist = server.gists.get(id);
    assert.ok(gist);
    assert.equal(gist.public, false);
    assert.ok(gist.files[MANIFEST_FILE]);
    assert.ok(Object.keys(gist.files).every((n) => !n.includes("/")));
    const remoteSettings = JSON.parse(Object.entries(gist.files).find(([, v]) => v.includes('"theme"'))?.[1] ?? "{}");
    assert.equal(remoteSettings.shellPath, undefined, "machine-local key never uploaded");

    const again = await a.run("push");
    assert.match(again, /nothing|up to date|no changes|unchanged/i);

    const b = await machine();
    await put(b, "settings.json", JSON.stringify({ shellPath: "/bin/b" }));
    const link = await b.run(`init ${id}`);
    assert.doesNotMatch(link, /^error/m, link);

    // Differing settings.json on first pull is a conflict by design.
    const blocked = await b.run("pull");
    assert.match(blocked, /^error: .*changed on both sides: settings\.json/);
    assert.equal(b.reloads, 0);

    const pulled = await b.run("pull --force --yes");
    assert.doesNotMatch(pulled, /^error/m, pulled);
    assert.equal(await read(b, "skills/review/SKILL.md"), "# review\n");
    assert.equal(await read(b, "skills/100%/a b.md"), "weird name\n");
    assert.equal(await read(b, "extensions/hello.ts"), "export default () => {};\n");
    assert.equal(await read(b, "prompts/empty.md"), "");
    assert.equal(await read(b, "prompts/blank.md"), "  \n");
    const settings = JSON.parse(await read(b, "settings.json"));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.shellPath, "/bin/b", "local machine-local key preserved");
    assert.equal(b.reloads, 1, "needsReload offers a reload");
    assert.ok((await readdir(join(b.agentDir, "gist-sync-backups"))).length > 0);

    const status = await b.run("status");
    assert.doesNotMatch(status, /^error/m, status);
    assert.doesNotMatch(status, /conflict/i);
  });

  it("propagates an edit and a delete, and prunes only with --prune", async () => {
    const a = await machine();
    await put(a, "skills/x.md", "one\n");
    await put(a, "skills/y.md", "keep\n");
    await a.run("init");
    const id = lastGistId();
    await a.run("push");

    const b = await machine();
    await b.run(`init ${id}`);
    await b.run("pull --yes");
    assert.equal(await read(b, "skills/x.md"), "one\n");

    await put(a, "skills/x.md", "two\n");
    await rm(join(a.agentDir, "skills/y.md"));
    const push = await a.run("push");
    assert.doesNotMatch(push, /^error/m, push);

    const dry = await b.run("pull --dry-run");
    assert.doesNotMatch(dry, /^error/m, dry);
    assert.equal(await read(b, "skills/x.md"), "one\n", "dry run writes nothing");

    await b.run("pull --yes");
    assert.equal(await read(b, "skills/x.md"), "two\n");
    assert.equal(await read(b, "skills/y.md"), "keep\n", "remote delete is not applied without --prune");

    await b.run("pull --prune --yes");
    await assert.rejects(stat(join(b.agentDir, "skills/y.md")));
  });

  it("encrypt mode round-trips a credential file and skip mode never uploads it", async () => {
    const secretText = JSON.stringify({ token: "hunter2-not-a-real-token" });

    const skipper = await machine();
    await put(skipper, "auth.json", secretText, 0o600);
    await put(skipper, "AGENTS.md", "hello\n");
    await skipper.run("init");
    const skipId = lastGistId();
    await skipper.run("push");
    const skipGist = server.gists.get(skipId);
    assert.ok(skipGist);
    assert.ok(Object.values(skipGist.files).every((c) => !c.includes("hunter2")), "credential never uploaded");

    const a = await machine({ credentials: "encrypt" });
    await put(a, "auth.json", secretText, 0o600);
    await a.run("init");
    const id = lastGistId();
    const env = { PI_GIST_SYNC_PASSPHRASE: PASSPHRASE };
    const push = await a.run("push", { env });
    assert.doesNotMatch(push, /^error/m, push);
    const gist = server.gists.get(id);
    assert.ok(gist);
    assert.ok(Object.values(gist.files).every((c) => !c.includes("hunter2")), "ciphertext only");

    const b = await machine({ credentials: "encrypt" });
    await b.run(`init ${id}`);
    const pull = await b.run("pull --yes", { env });
    assert.doesNotMatch(pull, /^error/m, pull);
    assert.equal(await read(b, "auth.json"), secretText);
    assert.equal((await stat(join(b.agentDir, "auth.json"))).mode & 0o777, 0o600);
  });

  it("a pull confirm that answers no aborts and writes nothing", async () => {
    const a = await machine();
    await put(a, "extensions/e.ts", "export default () => {};\n");
    await a.run("init");
    const id = lastGistId();
    await a.run("push");

    const b = await machine();
    await b.run(`init ${id}`);
    const out = await b.run("pull", { confirm: false });
    assert.match(out, /^error/m);
    await assert.rejects(stat(join(b.agentDir, "extensions/e.ts")));
  });
});
