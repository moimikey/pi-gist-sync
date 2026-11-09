import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { CommandIO } from "../src/command.ts";
import { argumentCompletions, describeReview, parseArgs, runCommand, startupCheck, SUBCOMMANDS, wantsRootNames } from "../src/command.ts";
import { loadConfig } from "../src/config.ts";
import type {
  GistClient,
  PullPlan,
  PullResult,
  PullReview,
  PushResult,
  StatusResult,
  SyncApi,
  SyncEnv,
} from "../src/types.ts";
import { GistSyncError } from "../src/types.ts";
import registerExtension from "../extensions/index.ts";

// ---- fixtures ----------------------------------------------------------------

const GH_TOKEN = "ghp_" + "a".repeat(36);
const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpAgentDir(config?: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gist-sync-cmd-"));
  dirs.push(dir);
  if (config) await writeFile(join(dir, "gist-sync.json"), JSON.stringify(config));
  return dir;
}

interface FakeIO extends CommandIO {
  notes: { message: string; level: string }[];
  confirms: { title: string; message: string }[];
  inputs: { title: string; placeholder?: string }[];
  reloads: number;
  execs: { cmd: string; args: string[] }[];
}

function fakeIO(
  opts: {
    hasUI?: boolean;
    confirmAnswers?: boolean[];
    inputAnswer?: string;
    exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;
  } = {},
): FakeIO {
  const answers = [...(opts.confirmAnswers ?? [])];
  const io: FakeIO = {
    hasUI: opts.hasUI ?? true,
    notes: [],
    confirms: [],
    inputs: [],
    reloads: 0,
    execs: [],
    notify(message, level) {
      io.notes.push({ message, level });
    },
    async confirm(title, message) {
      io.confirms.push({ title, message });
      return answers.shift() ?? false;
    },
    async input(title, placeholder) {
      io.inputs.push({ title, placeholder });
      return opts.inputAnswer;
    },
    async reload() {
      io.reloads++;
    },
    async exec(cmd, args) {
      io.execs.push({ cmd, args });
      return opts.exec ? opts.exec(cmd, args) : { stdout: "", code: 1 };
    },
  };
  return io;
}

const emptyPlan: PullPlan = {
  gistUrl: "https://gist.github.com/u/1",
  remoteRevision: 1,
  add: [],
  update: [],
  localOnly: [],
  conflicts: [],
  review: [],
  undecryptable: [],
};

const pushResult = (lines: string[] = ["pushed"]): PushResult => ({
  lines,
  skipped: [],
  gistUrl: "u",
  revision: 1,
  added: [],
  updated: [],
  deleted: [],
  noop: false,
});
const pullResult = (over: Partial<PullResult> = {}): PullResult => ({
  lines: ["pulled"],
  skipped: [],
  applied: [],
  needsReload: false,
  ...over,
});
const statusResult = (over: Partial<StatusResult> = {}): StatusResult => ({
  lines: ["in sync"],
  skipped: [],
  linked: true,
  ahead: [],
  behind: [],
  conflicts: [],
  ...over,
});

interface Call {
  name: string;
  env: SyncEnv;
  opts?: Record<string, unknown>;
}
interface FakeApi extends SyncApi {
  calls: Call[];
}

function fakeApi(over: Partial<SyncApi> = {}): FakeApi {
  const calls: Call[] = [];
  const api: FakeApi = {
    calls,
    async init(env, opts) {
      calls.push({ name: "init", env, opts });
      return { gistId: opts.gistId ?? "newgist", gistUrl: "https://gist.github.com/u/newgist", created: opts.gistId === undefined };
    },
    async status(env) {
      calls.push({ name: "status", env });
      return statusResult();
    },
    async push(env, opts) {
      calls.push({ name: "push", env, opts });
      return pushResult();
    },
    async pull(env, opts) {
      calls.push({ name: "pull", env, opts });
      return pullResult();
    },
    async scanCandidates(env) {
      calls.push({ name: "scan", env });
      return [];
    },
    async unlink(env) {
      calls.push({ name: "unlink", env });
    },
    ...over,
  };
  return api;
}

const lastNote = (io: FakeIO) => io.notes[io.notes.length - 1];

async function run(
  args: string,
  io: FakeIO,
  api: FakeApi,
  extra: { env?: NodeJS.ProcessEnv; agentDir?: string; client?: GistClient; home?: string } = {},
) {
  await runCommand(args, io, {
    api,
    env: extra.env ?? { GH_TOKEN },
    agentDir: extra.agentDir ?? (await tmpAgentDir()),
    client: extra.client,
    home: extra.home ?? (await tmpAgentDir()),
  });
}

// ---- parseArgs ---------------------------------------------------------------

describe("parseArgs", () => {
  it("defaults to help on empty input", () => {
    assert.deepEqual(parseArgs(""), { sub: "help", flags: new Set(), rest: [] });
    assert.equal(parseArgs("   ").sub, "help");
  });

  it("splits subcommand, flags (without dashes) and positionals", () => {
    const p = parseArgs("pull --force --dry-run");
    assert.equal(p.sub, "pull");
    assert.deepEqual([...p.flags].sort(), ["dry-run", "force"]);
    assert.deepEqual(p.rest, []);
  });

  it("lowercases the subcommand and flags but keeps positional case", () => {
    const p = parseArgs("  INIT   AbC123  --FORCE ");
    assert.equal(p.sub, "init");
    assert.deepEqual(p.rest, ["AbC123"]);
    assert.ok(p.flags.has("force"));
  });

  it("accepts flags before the subcommand and single-dash flags", () => {
    const p = parseArgs("--yes pull -f");
    assert.equal(p.sub, "pull");
    assert.deepEqual([...p.flags].sort(), ["f", "yes"]);
  });

  it("treats a bare dash or double dash as a positional", () => {
    assert.deepEqual(parseArgs("init -").rest, ["-"]);
    assert.deepEqual(parseArgs("init --").rest, ["--"]);
  });
});

describe("SUBCOMMANDS", () => {
  it("lists every command from the spec", () => {
    assert.deepEqual([...SUBCOMMANDS], ["init", "status", "push", "pull", "scan", "roots", "unlink", "help"]);
  });
});

// ---- help and argument validation ---------------------------------------------

describe("help and validation", () => {
  it("prints help at info level for empty args and for `help`", async () => {
    for (const args of ["", "help"]) {
      const io = fakeIO();
      const api = fakeApi();
      await run(args, io, api);
      assert.equal(io.notes.length, 1);
      assert.equal(lastNote(io)?.level, "info");
      for (const sub of SUBCOMMANDS) assert.match(lastNote(io)?.message ?? "", new RegExp(sub));
      assert.deepEqual(api.calls, []);
      assert.deepEqual(io.execs, []);
    }
  });

  it("answers an unknown subcommand with help at warning level", async () => {
    const io = fakeIO();
    const api = fakeApi();
    await run("frobnicate", io, api);
    assert.equal(lastNote(io)?.level, "warning");
    assert.match(lastNote(io)?.message ?? "", /Unknown subcommand "frobnicate"/);
    assert.match(lastNote(io)?.message ?? "", /pull/);
    assert.deepEqual(api.calls, []);
  });

  it("rejects an unknown flag instead of running a different operation", async () => {
    const io = fakeIO();
    const api = fakeApi();
    await run("push --dry-rn", io, api);
    assert.equal(lastNote(io)?.level, "warning");
    assert.match(lastNote(io)?.message ?? "", /--dry-rn/);
    assert.deepEqual(api.calls, []);
  });

  it("rejects a flag that belongs to another subcommand", async () => {
    const io = fakeIO();
    const api = fakeApi();
    await run("push --prune", io, api);
    assert.equal(lastNote(io)?.level, "warning");
    assert.deepEqual(api.calls, []);
  });

  it("rejects stray positionals", async () => {
    const io = fakeIO();
    const api = fakeApi();
    await run("push extra", io, api);
    assert.equal(lastNote(io)?.level, "warning");
    assert.match(lastNote(io)?.message ?? "", /Unexpected argument "extra"/);
    await run("init a1 b2", io, api);
    assert.match(lastNote(io)?.message ?? "", /Unexpected argument "b2"/);
    assert.deepEqual(api.calls, []);
  });
});

// ---- subcommand wiring ---------------------------------------------------------

describe("subcommands", () => {
  it("push forwards flags and prints the report lines", async () => {
    const spy = fakeApi();
    await run("push --force --dry-run", fakeIO(), spy);
    assert.deepEqual(spy.calls[0]?.opts, { force: true, dryRun: true });
    const io = fakeIO();
    await run("push", io, fakeApi({ push: async () => pushResult(["Pushed 2 files", "revision 3"]) }));
    assert.deepEqual(io.notes, [{ message: "Pushed 2 files\nrevision 3", level: "info" }]);
  });

  it("status prints the report lines at info level", async () => {
    const io = fakeIO();
    await run("status", io, fakeApi({ status: async () => statusResult({ lines: ["ahead: a", "behind: b"] }) }));
    assert.deepEqual(io.notes, [{ message: "ahead: a\nbehind: b", level: "info" }]);
  });

  it("init without an id creates a gist and warns that secret gists are unlisted", async () => {
    const io = fakeIO();
    const api = fakeApi();
    await run("init", io, api);
    assert.equal(api.calls[0]?.opts?.gistId, undefined);
    const msg = lastNote(io)?.message ?? "";
    assert.match(msg, /Created secret gist newgist/);
    assert.match(msg, /unlisted, not private/);
    assert.match(msg, /\/gist-sync push/);
  });

  it("init with an id links it", async () => {
    const io = fakeIO();
    const api = fakeApi();
    await run("init abc123def", io, api);
    assert.equal(api.calls[0]?.opts?.gistId, "abc123def");
    assert.match(lastNote(io)?.message ?? "", /Linked gist abc123def/);
    assert.match(lastNote(io)?.message ?? "", /\/gist-sync pull/);
  });

  it("init accepts a gist URL and extracts the id", async () => {
    const io = fakeIO();
    const api = fakeApi();
    await run("init https://gist.github.com/someone/0123abcd/", io, api);
    assert.equal(api.calls[0]?.opts?.gistId, "0123abcd");
  });

  it("init rejects ids that could escape the API path", async () => {
    for (const bad of ["../users/x", "a%2Fb", "https://evil.example/abc123", "a.b"]) {
      const io = fakeIO();
      const api = fakeApi();
      await run(`init ${bad}`, io, api);
      assert.equal(lastNote(io)?.level, "warning", bad);
      assert.deepEqual(api.calls, [], bad);
    }
  });

  it("scan lists unsynced files and needs no token", async () => {
    const io = fakeIO();
    const api = fakeApi({ scanCandidates: async () => ["notes.txt", "scratch/a.txt"] });
    await run("scan", io, api, { env: {} });
    const msg = lastNote(io)?.message ?? "";
    assert.match(msg, /2 file\(s\)/);
    assert.match(msg, /notes\.txt/);
    assert.equal(lastNote(io)?.level, "info");
    assert.deepEqual(io.execs, []);
  });

  it("scan says so when nothing is unsynced", async () => {
    const io = fakeIO();
    await run("scan", io, fakeApi());
    assert.match(lastNote(io)?.message ?? "", /No unsynced files/);
  });

  it("unlink calls the api without a token and says nothing was touched", async () => {
    const io = fakeIO();
    const api = fakeApi();
    await run("unlink", io, api, { env: {} });
    assert.equal(api.calls[0]?.name, "unlink");
    assert.match(lastNote(io)?.message ?? "", /not touched/);
    assert.deepEqual(io.execs, []);
    await assert.rejects(api.calls[0]!.env.client.get("x"), (e: unknown) => e instanceof GistSyncError);
  });

  it("passes a populated SyncEnv", async () => {
    const dir = await tmpAgentDir();
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    const io = fakeIO();
    const api = fakeApi();
    await run("status", io, api, { agentDir: dir });
    const env = api.calls[0]!.env;
    assert.equal(env.agentDir, dir);
    assert.equal(env.hostname, hostname());
    assert.equal(env.version, pkg.version);
    assert.ok(env.now() instanceof Date);
    assert.equal(typeof env.client.get, "function");
  });
});

// ---- token resolution ------------------------------------------------------------

describe("token resolution", () => {
  it("uses an injected client without resolving a token", async () => {
    const io = fakeIO();
    const api = fakeApi();
    const client = {} as GistClient;
    await run("status", io, api, { env: {}, client });
    assert.equal(api.calls[0]?.env.client, client);
    assert.deepEqual(io.execs, []);
  });

  it("prefers environment tokens over `gh auth token`", async () => {
    const io = fakeIO();
    const api = fakeApi();
    await run("status", io, api, { env: { GITHUB_TOKEN: "env-token-value-1234" } });
    assert.equal(api.calls.length, 1);
    assert.deepEqual(io.execs, []);
  });

  it("falls back to `gh auth token`, trimming its output", async () => {
    const io = fakeIO({ exec: async () => ({ stdout: "gh-cli-token-value-9999\n", code: 0 }) });
    const api = fakeApi({
      status: async () => {
        throw new Error("boom with gh-cli-token-value-9999 inside");
      },
    });
    await run("status", io, api, { env: {} });
    assert.deepEqual(io.execs, [{ cmd: "gh", args: ["auth", "token"] }]);
    assert.equal(lastNote(io)?.level, "error");
    assert.doesNotMatch(lastNote(io)?.message ?? "", /gh-cli-token-value-9999/);
    assert.match(lastNote(io)?.message ?? "", /\[redacted\]/);
  });

  it("reports NO_TOKEN when gh exits non-zero and never calls the api", async () => {
    const io = fakeIO({ exec: async () => ({ stdout: "", code: 1 }) });
    const api = fakeApi();
    await run("push", io, api, { env: {} });
    assert.equal(lastNote(io)?.level, "error");
    assert.match(lastNote(io)?.message ?? "", /gist/i);
    assert.deepEqual(api.calls, []);
  });

  it("reports NO_TOKEN when gh is not runnable", async () => {
    const io = fakeIO({
      exec: async () => {
        throw new Error("spawn gh ENOENT");
      },
    });
    const api = fakeApi();
    await run("pull", io, api, { env: {} });
    assert.equal(lastNote(io)?.level, "error");
    assert.deepEqual(api.calls, []);
  });
});

// ---- error mapping and redaction ---------------------------------------------------

describe("error mapping", () => {
  it("maps GistSyncError to an error notify with its message", async () => {
    const io = fakeIO();
    const api = fakeApi({
      push: async () => {
        throw new GistSyncError("CONFLICT", "Conflicts: a.md, b.md");
      },
    });
    await run("push", io, api);
    assert.deepEqual(io.notes, [{ message: "Conflicts: a.md, b.md", level: "error" }]);
  });

  it("maps unknown errors and non-Error throws to an error notify", async () => {
    for (const thrown of [new TypeError("bad thing"), "plain string", 42]) {
      const io = fakeIO();
      const api = fakeApi({
        status: async () => {
          throw thrown;
        },
      });
      await run("status", io, api);
      assert.equal(io.notes.length, 1);
      assert.equal(lastNote(io)?.level, "error");
      assert.match(lastNote(io)?.message ?? "", new RegExp(String(thrown instanceof Error ? thrown.message : thrown)));
    }
  });

  it("redacts GitHub token shapes from error messages", async () => {
    const pat = "github_pat_" + "B".repeat(30);
    const legacy = "0123456789abcdef".repeat(3).slice(0, 40);
    const message = `401 for ${GH_TOKEN}; ${pat}; Authorization: Bearer abcdefghijklmnop1234; ${legacy}`;
    const io = fakeIO();
    const api = fakeApi({
      push: async () => {
        throw new GistSyncError("AUTH", message);
      },
    });
    await run("push", io, api);
    const out = lastNote(io)?.message ?? "";
    for (const secret of [GH_TOKEN, pat, "abcdefghijklmnop1234", legacy]) assert.ok(!out.includes(secret), secret);
    assert.match(out, /401 for \[redacted\]/);
  });

  it("redacts the resolved token even when it matches no known pattern", async () => {
    const io = fakeIO();
    const api = fakeApi({
      status: async () => {
        throw new Error("request failed for opaque-credential-xyz");
      },
    });
    await run("status", io, api, { env: { GH_TOKEN: "opaque-credential-xyz" } });
    assert.doesNotMatch(lastNote(io)?.message ?? "", /opaque-credential-xyz/);
  });

  it("redacts the passphrase from errors", async () => {
    const io = fakeIO();
    const api = fakeApi({
      push: async () => {
        throw new Error("bad key correct horse battery");
      },
    });
    await run("push", io, api, { env: { GH_TOKEN, PI_GIST_SYNC_PASSPHRASE: "correct horse battery" } });
    assert.doesNotMatch(lastNote(io)?.message ?? "", /correct horse/);
  });

  it("redacts tokens echoed in successful output too", async () => {
    const io = fakeIO();
    await run("status", io, fakeApi({ status: async () => statusResult({ lines: [`leak ${GH_TOKEN}`] }) }));
    assert.doesNotMatch(lastNote(io)?.message ?? "", /ghp_/);
    assert.equal(lastNote(io)?.level, "info");
  });

  it("strips terminal escapes from output", async () => {
    const io = fakeIO();
    await run("status", io, fakeApi({ status: async () => statusResult({ lines: ["\u001b[2Jcleared\u202e"] }) }));
    assert.equal(lastNote(io)?.message, "?[2Jcleared?");
  });

  it("never throws, even when notify throws", async () => {
    const io = fakeIO();
    io.notify = () => {
      throw new Error("ui gone");
    };
    const api = fakeApi({
      status: async () => {
        throw new Error("boom");
      },
    });
    await assert.doesNotReject(run("status", io, api));
  });
});

// ---- pull confirmation ------------------------------------------------------------

/** Mimics sync.pull: asks `confirm` once with a plan and aborts when it says no. */
function pullWithPlan(plan: PullPlan, result: PullResult = pullResult()): Partial<SyncApi> {
  return {
    async pull(_env, opts) {
      if (opts.confirm && !(await opts.confirm(plan))) throw new GistSyncError("ABORTED", "Pull aborted.");
      return result;
    },
  };
}

const review = (over: Partial<PullReview> & { path: string }): PullReview => ({ action: "update", tier: "code", ...over });

describe("pull confirm gating", () => {
  const execPlan: PullPlan = {
    ...emptyPlan,
    review: [
      review({ path: "extensions/hook.ts", sha256: "ab".repeat(32), size: 2048 }),
      review({ path: "settings.json", keys: ["packages", "shellCommandPrefix"], sha256: "cd".repeat(32), size: 90 }),
      review({ path: "skills/x/SKILL.md", tier: "instructions", action: "add", sha256: "ef".repeat(32), size: 12 }),
      review({ path: "notes.md", tier: "other", action: "delete" }),
    ],
  };

  it("asks for confirmation listing each path, its tier, keys and a content hash", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    await run("pull", io, fakeApi(pullWithPlan(execPlan)));
    assert.equal(io.confirms.length, 1);
    const msg = io.confirms[0]!.message;
    assert.match(msg, /4 change\(s\) need your approval/);
    assert.match(msg, /Code and settings Pi runs \(2\)/);
    assert.match(msg, /Instructions and skills that steer the model \(1\)/);
    assert.match(msg, /Other files \(1\)/);
    assert.match(msg, /update extensions\/hook\.ts {2}sha256:abababababab 2\.0 KB/);
    assert.match(msg, /update settings\.json {2}keys: packages, shellCommandPrefix {2}sha256:cdcdcdcdcdcd 90 B/);
    assert.match(msg, /add skills\/x\/SKILL\.md/);
    assert.match(msg, /delete notes\.md$/);
    assert.equal(lastNote(io)?.level, "info");
  });

  it("aborts when the user declines", async () => {
    const io = fakeIO({ confirmAnswers: [false] });
    await run("pull", io, fakeApi(pullWithPlan(execPlan)));
    assert.equal(lastNote(io)?.level, "error");
    assert.match(lastNote(io)?.message ?? "", /aborted/i);
  });

  it("skips the prompt with --yes", async () => {
    const io = fakeIO();
    await run("pull --yes", io, fakeApi(pullWithPlan(execPlan)));
    assert.deepEqual(io.confirms, []);
    assert.equal(lastNote(io)?.level, "info");
  });

  it("does not prompt when nothing needs approval", async () => {
    const io = fakeIO();
    await run("pull", io, fakeApi(pullWithPlan({ ...emptyPlan, add: ["keybindings.json"] })));
    assert.deepEqual(io.confirms, []);
    assert.equal(lastNote(io)?.level, "info");
  });

  it("aborts with a clear message when there is no UI and no --yes", async () => {
    const io = fakeIO({ hasUI: false });
    await run("pull", io, fakeApi(pullWithPlan(execPlan)));
    assert.deepEqual(io.confirms, []);
    assert.equal(lastNote(io)?.level, "error");
    assert.match(lastNote(io)?.message ?? "", /--yes/);
    assert.match(lastNote(io)?.message ?? "", /extensions\/hook\.ts/);
  });

  it("applies without UI when --yes is given", async () => {
    const io = fakeIO({ hasUI: false });
    await run("pull --yes", io, fakeApi(pullWithPlan(execPlan)));
    assert.equal(lastNote(io)?.level, "info");
  });

  it("does not pass confirm on a dry run", async () => {
    const io = fakeIO({ hasUI: false });
    const api = fakeApi();
    await run("pull --dry-run", io, api);
    assert.equal(api.calls[0]?.opts?.confirm, undefined);
    assert.equal(api.calls[0]?.opts?.dryRun, true);
  });

  it("forwards force and prune", async () => {
    const io = fakeIO();
    const api = fakeApi();
    await run("pull --force --prune", io, api);
    assert.equal(api.calls[0]?.opts?.force, true);
    assert.equal(api.calls[0]?.opts?.prune, true);
    assert.equal(typeof api.calls[0]?.opts?.confirm, "function");
  });

  it("sanitizes remote-controlled paths shown in the prompt", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    const plan = { ...emptyPlan, review: [review({ path: "extensions/\u001b[31mevil\u202e.ts" })] };
    await run("pull", io, fakeApi(pullWithPlan(plan)));
    assert.doesNotMatch(io.confirms[0]!.message, /[\u001b\u202e]/);
  });

  it("lists every entry of every tier, so nothing is approved unseen", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    const many = Array.from({ length: 40 }, (_, i) => review({ path: `notes/n${i}.md`, tier: "other" }));
    await run("pull", io, fakeApi(pullWithPlan({ ...emptyPlan, review: many })));
    const message = io.confirms[0]!.message;
    assert.match(message, /40 change\(s\) need your approval/);
    for (let i = 0; i < 40; i++) assert.ok(message.includes(`notes/n${i}.md`), `missing notes/n${i}.md`);
    assert.doesNotMatch(message, /more$/m);
  });

  it("escapes look-alike characters in a root path and its destination", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    const plan = { ...emptyPlan, review: [review({ path: "@local-bin/piwt\u00a0", dest: "/h/.local/bin/piwt\u00a0" })] };
    await run("pull", io, fakeApi(pullWithPlan(plan)));
    const message = io.confirms[0]!.message;
    assert.match(message, /update @local-bin\/piwt\\u\{a0\} -> \/h\/\.local\/bin\/piwt\\u\{a0\}/);
    assert.doesNotMatch(message, /\u00a0/);
  });

  it("never truncates the code tier, so no code is approved unseen", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    const many = Array.from({ length: 40 }, (_, i) => review({ path: `extensions/e${i}.ts` }));
    await run("pull", io, fakeApi(pullWithPlan({ ...emptyPlan, review: many })));
    const message = io.confirms[0]!.message;
    for (let i = 0; i < 40; i++) assert.ok(message.includes(`extensions/e${i}.ts`), `missing extensions/e${i}.ts`);
    assert.doesNotMatch(message, /more$/m);
  });
});

describe("describeReview", () => {
  it("orders tiers code, instructions, other and omits empty ones", () => {
    const text = describeReview([
      review({ path: "z.md", tier: "other" }),
      review({ path: "AGENTS.md", tier: "instructions" }),
      review({ path: "mcp.json" }),
    ]);
    const order = ["Code and settings", "Instructions and skills", "Other files"].map((t) => text.indexOf(t));
    assert.ok(order[0]! < order[1]! && order[1]! < order[2]!);
    assert.equal(describeReview([review({ path: "a.ts" })]).includes("Other files"), false);
  });
});

describe("init ownership prompt", () => {
  function ownerApi(): FakeApi {
    return fakeApi({
      async init(_env, opts) {
        const ok = await opts.confirmForeign?.("mallory");
        if (!ok) throw new GistSyncError("ABORTED", "That gist belongs to mallory.");
        return { gistId: opts.gistId ?? "x", gistUrl: "https://gist.github.com/u/x", created: false };
      },
    });
  }

  it("asks the user with the owner's name and links on yes", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    await run("init abc123", io, ownerApi());
    assert.equal(io.confirms.length, 1);
    assert.match(io.confirms[0]!.message, /belongs to mallory/);
    assert.match(lastNote(io)?.message ?? "", /Linked gist abc123/);
  });

  it("does not link on no", async () => {
    const io = fakeIO({ confirmAnswers: [false] });
    await run("init abc123", io, ownerApi());
    assert.equal(lastNote(io)?.level, "error");
  });

  it("--yes skips the prompt", async () => {
    const io = fakeIO();
    await run("init abc123 --yes", io, ownerApi());
    assert.deepEqual(io.confirms, []);
    assert.match(lastNote(io)?.message ?? "", /Linked gist/);
  });

  it("with no UI and no --yes, tells the user to re-run with --yes", async () => {
    const io = fakeIO({ hasUI: false });
    await run("init abc123", io, ownerApi());
    assert.deepEqual(io.confirms, []);
    assert.equal(lastNote(io)?.level, "error");
    assert.match(lastNote(io)?.message ?? "", /--yes/);
  });

  it("init takes --yes and nothing else", async () => {
    const io = fakeIO();
    const api = fakeApi();
    await run("init --force", io, api);
    assert.equal(lastNote(io)?.level, "warning");
    assert.deepEqual(api.calls, []);
  });
});

describe("module loading", () => {
  // jiti can hand a second concurrent dynamic import() of one module an undefined namespace, which
  // broke back-to-back commands in real Pi. Node cannot reproduce that, so pin the cause instead.
  it("command.ts has no dynamic import()", async () => {
    const text = await readFile(new URL("../src/command.ts", import.meta.url), "utf8");
    assert.equal(/\bimport\s*\(/.test(text.replace(/\/\/.*$/gm, "")), false);
  });

  it("concurrent commands on the real sync api both finish without error", async () => {
    const dir = await tmpAgentDir();
    const a = fakeIO();
    const b = fakeIO();
    const deps = { agentDir: dir, env: { GH_TOKEN } };
    await Promise.all([runCommand("scan", a, deps), runCommand("status", b, deps), runCommand("scan", fakeIO(), deps)]);
    assert.equal(lastNote(a)?.level, "info");
    assert.equal(lastNote(b)?.level, "info");
    assert.match(lastNote(b)?.message ?? "", /Not linked/);
  });
});

// ---- reload offer -----------------------------------------------------------------

describe("reload offer", () => {
  it("offers a reload after a pull that needs one and reloads on yes", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    await run("pull", io, fakeApi({ pull: async () => pullResult({ needsReload: true }) }));
    assert.equal(io.confirms.length, 1);
    assert.equal(io.confirms[0]!.title, "Reload Pi?");
    assert.equal(io.reloads, 1);
  });

  it("reports results before offering the reload", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    await run("pull", io, fakeApi({ pull: async () => pullResult({ needsReload: true, lines: ["Applied 3 files"] }) }));
    assert.equal(io.notes[0]?.message, "Applied 3 files");
  });

  it("does not reload when declined and points at /reload", async () => {
    const io = fakeIO({ confirmAnswers: [false] });
    await run("pull", io, fakeApi({ pull: async () => pullResult({ needsReload: true }) }));
    assert.equal(io.reloads, 0);
    assert.match(lastNote(io)?.message ?? "", /\/reload/);
  });

  it("tells a UI-less user to run /reload instead of prompting", async () => {
    const io = fakeIO({ hasUI: false });
    await run("pull", io, fakeApi({ pull: async () => pullResult({ needsReload: true }) }));
    assert.deepEqual(io.confirms, []);
    assert.equal(io.reloads, 0);
    assert.match(lastNote(io)?.message ?? "", /Run \/reload/);
  });

  it("does not ask when nothing needs a reload", async () => {
    const io = fakeIO();
    await run("pull", io, fakeApi());
    assert.deepEqual(io.confirms, []);
    assert.equal(io.reloads, 0);
  });

  it("does not ask after a dry run", async () => {
    const io = fakeIO();
    await run("pull --dry-run", io, fakeApi({ pull: async () => pullResult({ needsReload: true }) }));
    assert.deepEqual(io.confirms, []);
    assert.equal(io.reloads, 0);
  });

  it("does not ask after a failed pull", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    await run(
      "pull",
      io,
      fakeApi({
        pull: async () => {
          throw new GistSyncError("CONFLICT", "conflict");
        },
      }),
    );
    assert.deepEqual(io.confirms, []);
    assert.equal(io.reloads, 0);
  });

  it("maps a failing reload to an error notify", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    io.reload = async () => {
      throw new Error("reload failed");
    };
    await run("pull", io, fakeApi({ pull: async () => pullResult({ needsReload: true }) }));
    assert.equal(lastNote(io)?.level, "error");
    assert.match(lastNote(io)?.message ?? "", /reload failed/);
  });
});

// ---- passphrase resolution ---------------------------------------------------------

describe("passphrase resolution", () => {
  it("prefers PI_GIST_SYNC_PASSPHRASE and never prompts", async () => {
    const agentDir = await tmpAgentDir({ credentials: "encrypt" });
    const io = fakeIO();
    const api = fakeApi();
    await run("push", io, api, { agentDir, env: { GH_TOKEN, PI_GIST_SYNC_PASSPHRASE: "from-env" } });
    assert.equal(api.calls[0]?.env.passphrase, "from-env");
    assert.deepEqual(io.inputs, []);
  });

  it("prompts in encrypt mode when the env var is unset", async () => {
    const agentDir = await tmpAgentDir({ credentials: "encrypt" });
    const io = fakeIO({ inputAnswer: "typed pass" });
    const api = fakeApi();
    await run("push", io, api, { agentDir });
    assert.equal(io.inputs.length, 1);
    assert.equal(api.calls[0]?.env.passphrase, "typed pass");
  });

  it("prompts for status and pull as well", async () => {
    const agentDir = await tmpAgentDir({ credentials: "encrypt" });
    for (const sub of ["status", "pull"]) {
      const io = fakeIO({ inputAnswer: "pw" });
      const api = fakeApi();
      await run(sub, io, api, { agentDir });
      assert.equal(io.inputs.length, 1, sub);
      assert.equal(api.calls[0]?.env.passphrase, "pw", sub);
    }
  });

  it("does not prompt when credentials are skipped", async () => {
    const agentDir = await tmpAgentDir({ credentials: "skip" });
    const io = fakeIO({ inputAnswer: "ignored" });
    const api = fakeApi();
    await run("push", io, api, { agentDir });
    assert.deepEqual(io.inputs, []);
    assert.equal(api.calls[0]?.env.passphrase, undefined);
  });

  it("does not prompt with the default config", async () => {
    const io = fakeIO({ inputAnswer: "ignored" });
    const api = fakeApi();
    await run("push", io, api);
    assert.deepEqual(io.inputs, []);
    assert.equal(api.calls[0]?.env.passphrase, undefined);
  });

  it("does not prompt without a UI", async () => {
    const agentDir = await tmpAgentDir({ credentials: "encrypt" });
    const io = fakeIO({ hasUI: false, inputAnswer: "ignored" });
    const api = fakeApi();
    await run("push", io, api, { agentDir });
    assert.deepEqual(io.inputs, []);
    assert.equal(api.calls[0]?.env.passphrase, undefined);
  });

  it("leaves the passphrase undefined when the prompt is cancelled or empty", async () => {
    const agentDir = await tmpAgentDir({ credentials: "encrypt" });
    for (const answer of [undefined, ""]) {
      const io = fakeIO({ inputAnswer: answer });
      const api = fakeApi();
      await run("push", io, api, { agentDir });
      assert.equal(api.calls[0]?.env.passphrase, undefined);
    }
  });

  it("treats an empty env var as unset", async () => {
    const agentDir = await tmpAgentDir({ credentials: "encrypt" });
    const io = fakeIO({ inputAnswer: "typed" });
    const api = fakeApi();
    await run("push", io, api, { agentDir, env: { GH_TOKEN, PI_GIST_SYNC_PASSPHRASE: "" } });
    assert.equal(api.calls[0]?.env.passphrase, "typed");
  });

  it("does not prompt for init, scan or unlink", async () => {
    const agentDir = await tmpAgentDir({ credentials: "encrypt" });
    for (const sub of ["init", "scan", "unlink"]) {
      const io = fakeIO({ inputAnswer: "pw" });
      await run(sub, io, fakeApi(), { agentDir });
      assert.deepEqual(io.inputs, [], sub);
    }
  });

  it("redacts a typed passphrase from errors", async () => {
    const agentDir = await tmpAgentDir({ credentials: "encrypt" });
    const io = fakeIO({ inputAnswer: "hunter2-passphrase" });
    const api = fakeApi({
      push: async () => {
        throw new Error("could not use hunter2-passphrase");
      },
    });
    await run("push", io, api, { agentDir });
    assert.doesNotMatch(lastNote(io)?.message ?? "", /hunter2/);
  });
});

// ---- startupCheck ------------------------------------------------------------------

describe("startupCheck", () => {
  const linked = { gistId: "abc123", checkOnStart: true };

  it("does nothing when checkOnStart is off", async () => {
    const agentDir = await tmpAgentDir({ gistId: "abc123", checkOnStart: false });
    const io = fakeIO();
    const api = fakeApi();
    await startupCheck(io, { api, env: { GH_TOKEN }, agentDir });
    assert.deepEqual(api.calls, []);
    assert.deepEqual(io.notes, []);
  });

  it("does nothing when no gist is linked", async () => {
    const agentDir = await tmpAgentDir({ checkOnStart: true });
    const io = fakeIO({ exec: async () => ({ stdout: "gh-token-1234567", code: 0 }) });
    const api = fakeApi();
    await startupCheck(io, { api, env: {}, agentDir });
    assert.deepEqual(api.calls, []);
    assert.deepEqual(io.execs, []);
  });

  it("notifies only when the remote is ahead", async () => {
    const agentDir = await tmpAgentDir(linked);
    const behind = fakeIO();
    await startupCheck(behind, {
      api: fakeApi({ status: async () => statusResult({ behind: ["a", "b"] }) }),
      env: { GH_TOKEN },
      agentDir,
    });
    assert.equal(behind.notes.length, 1);
    assert.match(behind.notes[0]!.message, /2 remote change/);
    assert.equal(behind.notes[0]!.level, "info");

    const current = fakeIO();
    await startupCheck(current, { api: fakeApi(), env: { GH_TOKEN }, agentDir });
    assert.deepEqual(current.notes, []);
  });

  it("never prompts for a passphrase", async () => {
    const agentDir = await tmpAgentDir({ ...linked, credentials: "encrypt" });
    const io = fakeIO({ inputAnswer: "pw" });
    const api = fakeApi();
    await startupCheck(io, { api, env: { GH_TOKEN }, agentDir });
    assert.deepEqual(io.inputs, []);
    assert.equal(api.calls[0]?.env.passphrase, undefined);
  });

  it("swallows errors silently", async () => {
    const agentDir = await tmpAgentDir(linked);
    const io = fakeIO();
    const api = fakeApi({
      status: async () => {
        throw new GistSyncError("AUTH", "bad credentials");
      },
    });
    await startupCheck(io, { api, env: { GH_TOKEN }, agentDir });
    assert.deepEqual(io.notes, []);
  });

  it("stops waiting after the timeout and ignores a late result", async () => {
    const agentDir = await tmpAgentDir(linked);
    const io = fakeIO();
    let release: (s: StatusResult) => void = () => {};
    const api = fakeApi({ status: () => new Promise<StatusResult>((resolve) => (release = resolve)) });
    // startupCheck unrefs its timer; hold the loop open so Node 22's runner does not exit first.
    const keepAlive = setInterval(() => {}, 1000);
    try {
      const started = Date.now();
      await startupCheck(io, { api, env: { GH_TOKEN }, agentDir }, 30);
      assert.ok(Date.now() - started < 2000);
      release(statusResult({ behind: ["late"] }));
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(io.notes, []);
    } finally {
      clearInterval(keepAlive);
    }
  });
});

// ---- extension glue ------------------------------------------------------------------

describe("extension entry", () => {
  type Handler = (args: string, ctx: unknown) => Promise<void>;
  interface Registered {
    description?: string;
    getArgumentCompletions?: (prefix: string) => { value: string }[] | null;
    handler: Handler;
  }

  function load() {
    const commands = new Map<string, Registered>();
    const events: { name: string; handler: (event: unknown, ctx: unknown) => unknown }[] = [];
    const pi = {
      registerCommand: (name: string, opts: Registered) => commands.set(name, opts),
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => events.push({ name, handler }),
      exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false, truncated: false }),
    };
    registerExtension(pi as never);
    return { commands, events };
  }

  it("registers /gist-sync without starting any work", () => {
    const { commands, events } = load();
    assert.ok(commands.get("gist-sync")?.description);
    assert.deepEqual(events.map((e) => e.name), ["session_start"]);
  });

  it("completes subcommands by prefix and returns null otherwise", () => {
    const complete = load().commands.get("gist-sync")!.getArgumentCompletions!;
    assert.deepEqual(complete("pu")?.map((i) => i.value), ["push", "pull"]);
    assert.deepEqual(complete("")?.map((i) => i.value), [...SUBCOMMANDS]);
    assert.equal(complete("zzz"), null);
    assert.equal(complete("pull --f"), null);
  });

  it("routes the handler through runCommand using the context ui", async () => {
    const notes: { message: string; level: string }[] = [];
    const ctx = {
      hasUI: false,
      ui: {
        notify: (message: string, level: string) => notes.push({ message, level }),
        confirm: async () => true,
        input: async () => "x",
      },
      reload: async () => {},
    };
    await load().commands.get("gist-sync")!.handler("help", ctx);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.level, "info");
    assert.match(notes[0]!.message, /\/gist-sync/);
  });

  it("ignores session_start for anything but a fresh startup", () => {
    const start = load().events[0]!.handler;
    const ctx = { hasUI: true, ui: { notify: () => assert.fail("must not notify") } };
    assert.equal(start({ type: "session_start", reason: "reload" }, ctx), undefined);
    assert.equal(start({ type: "session_start", reason: "resume" }, ctx), undefined);
  });
});

// ---- roots -------------------------------------------------------------------------

describe("roots", () => {
  // Both the agent dir and home are temp dirs, so nothing here can reach the real ~.
  async function setup(config?: Record<string, unknown>) {
    const agentDir = await tmpAgentDir(config);
    const home = await tmpAgentDir();
    const binDir = join(home, "bin");
    await mkdir(binDir);
    return { agentDir, home, binDir };
  }

  async function roots(args: string, ctx: { agentDir: string; home: string }, io: FakeIO = fakeIO(), api: FakeApi = fakeApi()) {
    await run(`roots ${args}`.trim(), io, api, { ...ctx, env: {} });
    return { io, api, note: lastNote(io) };
  }

  it("is listed in help and needs no token or gist link", async () => {
    const io = fakeIO();
    await run("help", io, fakeApi());
    assert.match(lastNote(io)?.message ?? "", /roots/);
    const ctx = await setup();
    const { note, io: rio, api } = await roots("", ctx);
    assert.equal(note?.level, "info");
    assert.match(note?.message ?? "", /No roots configured/);
    assert.deepEqual(rio.execs, []);
    assert.deepEqual(api.calls, []);
  });

  it("adds a valid root, preserves other config fields and prints the summary", async () => {
    const ctx = await setup({ gistId: "abc123", credentials: "encrypt", maxFileBytes: 2048, checkOnStart: true, include: ["x/**"], exclude: ["y"] });
    const { note } = await roots(`add local-bin ${ctx.binDir} piwt *.sh`, ctx);
    assert.equal(note?.level, "info");
    assert.equal(
      note?.message,
      `Root "local-bin" added: ${ctx.binDir} (2 include glob(s)). Everything under a root needs approval on pull.`,
    );
    const cfg = await loadConfig(ctx.agentDir);
    assert.deepEqual(cfg.roots, { "local-bin": { dir: ctx.binDir, include: ["piwt", "*.sh"], exclude: [] } });
    assert.equal(cfg.gistId, "abc123");
    assert.equal(cfg.credentials, "encrypt");
    assert.equal(cfg.maxFileBytes, 2048);
    assert.equal(cfg.checkOnStart, true);
    assert.deepEqual(cfg.include, ["x/**"]);
    assert.deepEqual(cfg.exclude, ["y"]);
  });

  it("expands ~ against the injected home, not the real one", async () => {
    const ctx = await setup();
    const { note } = await roots("add local-bin ~/bin piwt", ctx);
    assert.equal(note?.level, "info", note?.message);
    assert.equal((await loadConfig(ctx.agentDir)).roots["local-bin"]?.dir, "~/bin");
    const listed = await roots("", ctx);
    assert.match(listed.note?.message ?? "", /local-bin {2}~\/bin {2}include: piwt {2}ok/);
  });

  it("refuses add without any include glob", async () => {
    const ctx = await setup();
    const { note } = await roots(`add local-bin ${ctx.binDir}`, ctx);
    assert.equal(note?.level, "warning");
    assert.match(note?.message ?? "", /at least one include glob/);
    assert.match(note?.message ?? "", /Usage:/);
    assert.deepEqual((await loadConfig(ctx.agentDir)).roots, {});
  });

  it("refuses an invalid name", async () => {
    const ctx = await setup();
    for (const bad of ["Local-Bin", "a.b", "a_b", "__proto__", "x".repeat(33)]) {
      const { note } = await roots(`add ${bad} ${ctx.binDir} piwt`, ctx);
      assert.equal(note?.level, "warning", bad);
      assert.match(note?.message ?? "", /not a valid root name/, bad);
    }
    assert.deepEqual((await loadConfig(ctx.agentDir)).roots, {});
  });

  it("refuses a missing dir, a relative dir, home itself and an agent-dir overlap", async () => {
    const ctx = await setup();
    for (const dir of [join(ctx.home, "nope"), "bin", "~", ctx.agentDir, join(ctx.agentDir, "..")]) {
      const { note } = await roots(`add local-bin ${dir} piwt`, ctx);
      assert.equal(note?.level, "warning", dir);
      assert.match(note?.message ?? "", /Root "local-bin" not added: /, dir);
    }
    assert.deepEqual((await loadConfig(ctx.agentDir)).roots, {});
  });

  it("refuses overlap with an existing root in either direction", async () => {
    const ctx = await setup();
    await mkdir(join(ctx.binDir, "sub"));
    assert.equal((await roots(`add mid ${ctx.binDir} *`, ctx)).note?.level, "info");
    // A nested dir under a later name is dropped itself.
    const nested = await roots(`add zz ${join(ctx.binDir, "sub")} *`, ctx);
    assert.equal(nested.note?.level, "warning");
    // An earlier name would knock the existing root out instead; still refused.
    const parent = await roots(`add aa ${join(ctx.binDir, "sub")} *`, ctx);
    assert.equal(parent.note?.level, "warning");
    assert.match(parent.note?.message ?? "", /not added/);
    assert.deepEqual(Object.keys((await loadConfig(ctx.agentDir)).roots), ["mid"]);
  });

  it("refuses a duplicate name", async () => {
    const ctx = await setup();
    await roots(`add local-bin ${ctx.binDir} piwt`, ctx);
    const { note } = await roots(`add local-bin ${ctx.binDir} other`, ctx);
    assert.equal(note?.level, "warning");
    assert.match(note?.message ?? "", /already exists/);
    assert.deepEqual((await loadConfig(ctx.agentDir)).roots["local-bin"]?.include, ["piwt"]);
  });

  it("lists roots with their globs and ok or the problem", async () => {
    const ctx = await setup({
      roots: {
        "local-bin": { dir: "~/bin", include: ["piwt"], exclude: ["*.bak"] },
        gone: { dir: "~/missing", include: ["*"], exclude: [] },
      },
    });
    const { note } = await roots("", ctx);
    const msg = note?.message ?? "";
    assert.equal(note?.level, "info");
    assert.match(msg, /2 root\(s\)/);
    assert.match(msg, /local-bin {2}~\/bin {2}include: piwt {2}exclude: \*\.bak {2}ok/);
    assert.match(msg, /gone {2}~\/missing {2}include: \* {2}ignored: \S/);
    assert.ok(msg.indexOf("gone") < msg.indexOf("local-bin"));
  });

  it("works with a root dir that is a symlink", async () => {
    const ctx = await setup();
    await symlink(ctx.binDir, join(ctx.home, "link"));
    assert.equal((await roots(`add linked ${join(ctx.home, "link")} piwt`, ctx)).note?.level, "info");
  });

  it("removes a root from config only, keeping other fields", async () => {
    const ctx = await setup({ gistId: "abc123", roots: { a: { dir: "~/bin", include: ["x"], exclude: [] }, b: { dir: "~/b", include: ["y"], exclude: [] } } });
    await writeFile(join(ctx.binDir, "x"), "keep me");
    const { note, api } = await roots("remove a", ctx);
    assert.equal(note?.level, "info");
    assert.match(note?.message ?? "", /Root "a" removed .*not touched/);
    const cfg = await loadConfig(ctx.agentDir);
    assert.deepEqual(Object.keys(cfg.roots), ["b"]);
    assert.equal(cfg.gistId, "abc123");
    assert.equal(await readFile(join(ctx.binDir, "x"), "utf8"), "keep me");
    assert.deepEqual(api.calls, []);
  });

  it("warns on removing an unknown root", async () => {
    const ctx = await setup();
    const { note } = await roots("remove nope", ctx);
    assert.equal(note?.level, "warning");
    assert.match(note?.message ?? "", /No root named "nope"/);
  });

  it("prints usage at warning level for bad arguments and changes nothing", async () => {
    const ctx = await setup({ roots: { a: { dir: "~/bin", include: ["x"], exclude: [] } } });
    for (const args of ["frob", "remove", "remove a b", "add", "add a", "list", `add b ${ctx.binDir} x --yes`]) {
      const { note } = await roots(args, ctx);
      assert.equal(note?.level, "warning", args);
      assert.match(note?.message ?? "", /Usage:/, args);
    }
    assert.deepEqual(Object.keys((await loadConfig(ctx.agentDir)).roots), ["a"]);
  });
});

describe("roots completions", () => {
  it("completes roots and its actions with the full argument text as value", () => {
    assert.deepEqual(argumentCompletions("ro")?.map((i) => i.value), ["roots"]);
    assert.deepEqual(argumentCompletions("roots ")?.map((i) => i.value), ["roots add", "roots remove"]);
    assert.deepEqual(argumentCompletions("roots a")?.map((i) => i.label), ["add"]);
    assert.deepEqual(argumentCompletions("roots r")?.map((i) => i.value), ["roots remove"]);
    assert.equal(argumentCompletions("roots x"), null);
    assert.equal(argumentCompletions("roots add local-bin "), null);
  });

  it("completes configured names after roots remove", () => {
    assert.equal(wantsRootNames("roots remove "), true);
    assert.equal(wantsRootNames("roots add "), false);
    assert.deepEqual(argumentCompletions("roots remove ", ["dotfiles", "local-bin"])?.map((i) => i.value), [
      "roots remove dotfiles",
      "roots remove local-bin",
    ]);
    assert.deepEqual(argumentCompletions("roots remove lo", ["dotfiles", "local-bin"])?.map((i) => i.label), ["local-bin"]);
    assert.equal(argumentCompletions("roots remove ", []), null);
  });

  it("the extension completes root names from the configured agent dir", async () => {
    const agentDir = await tmpAgentDir({ roots: { "local-bin": { dir: "~/bin", include: ["x"], exclude: [] } } });
    const saved = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      let registered: { getArgumentCompletions: (p: string) => unknown } | undefined;
      registerExtension({ registerCommand: (_n: string, o: typeof registered) => (registered = o), on: () => {}, exec: async () => ({}) } as never);
      const items = (await registered!.getArgumentCompletions("roots remove ")) as { value: string }[];
      assert.deepEqual(items.map((i) => i.value), ["roots remove local-bin"]);
      assert.deepEqual((registered!.getArgumentCompletions("roots ") as { label: string }[]).map((i) => i.label), ["add", "remove"]);
    } finally {
      if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = saved;
    }
  });
});

describe("home injection", () => {
  it("passes deps.home into SyncEnv", async () => {
    const home = await tmpAgentDir();
    for (const sub of ["status", "push", "pull", "scan", "unlink", "init"]) {
      const api = fakeApi();
      await run(sub, fakeIO(), api, { home });
      assert.equal(api.calls[0]?.env.home, home, sub);
    }
  });

  it("defaults to os.homedir()", async () => {
    const api = fakeApi();
    await runCommand("status", fakeIO(), { api, env: { GH_TOKEN }, agentDir: await tmpAgentDir() });
    assert.equal(api.calls[0]?.env.home, homedir());
  });
});

describe("root files in the approval prompt", () => {
  it("shows the destination after the path", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    const plan = { ...emptyPlan, review: [review({ path: "@local-bin/piwt", action: "add", dest: "/home/u/.local/bin/piwt", sha256: "ab".repeat(32), size: 10 })] };
    await run("pull", io, fakeApi(pullWithPlan(plan)));
    assert.match(io.confirms[0]!.message, /add @local-bin\/piwt -> \/home\/u\/\.local\/bin\/piwt {2}sha256:abababababab 10 B/);
    assert.match(io.confirms[0]!.message, /Code and settings Pi runs \(1\)/);
  });

  it("sanitizes control characters, newlines and bidi marks in path and dest", async () => {
    const io = fakeIO({ confirmAnswers: [true] });
    const plan = { ...emptyPlan, review: [review({ path: "@r/a\u001b[2J\u202e", dest: "/x/a\nupdate fake.ts\u0007" })] };
    await run("pull", io, fakeApi(pullWithPlan(plan)));
    const msg = io.confirms[0]!.message;
    assert.doesNotMatch(msg, /[\u001b\u202e\u0007]/);
    // The forged second line must stay on the dest's own line.
    assert.doesNotMatch(msg, /^update fake\.ts/m);
    assert.match(msg, /update @r\/a\?\[2J\? -> \/x\/a\?update fake\.ts\?/);
  });

  it("sanitizes dest in the no-UI abort message too", async () => {
    const io = fakeIO({ hasUI: false });
    const plan = { ...emptyPlan, review: [review({ path: "@r/a", dest: "/x/\u001b[31mb\nfake" })] };
    await run("pull", io, fakeApi(pullWithPlan(plan)));
    assert.equal(lastNote(io)?.level, "error");
    assert.match(lastNote(io)?.message ?? "", /@r\/a -> \/x\/\?\[31mb\?fake/);
  });

  it("never truncates root files in the code tier", () => {
    const many = Array.from({ length: 30 }, (_, i) => review({ path: `@bin/s${i}`, dest: `/h/bin/s${i}` }));
    const text = describeReview(many);
    for (let i = 0; i < 30; i++) assert.ok(text.includes(`@bin/s${i} -> /h/bin/s${i}`), `missing s${i}`);
    assert.doesNotMatch(text, /more$/m);
  });
});

describe("scan with roots", () => {
  it("shows root candidates alongside agent-dir files", async () => {
    const io = fakeIO();
    await run("scan", io, fakeApi({ scanCandidates: async () => ["notes.txt", "@local-bin/tool"] }), { env: {} });
    const msg = lastNote(io)?.message ?? "";
    assert.match(msg, /2 file\(s\) are not synced/);
    assert.match(msg, /@local-bin\/tool/);
  });
});

describe("roots hardening", () => {
  async function ctxWith(config?: Record<string, unknown>) {
    const agentDir = await tmpAgentDir(config);
    const home = await tmpAgentDir();
    return { agentDir, home };
  }
  const roots = async (args: string, ctx: { agentDir: string; home: string }) => {
    const io = fakeIO();
    await run(`roots ${args}`, io, fakeApi(), { ...ctx, env: {} });
    return lastNote(io);
  };

  for (const store of [".ssh", ".config", ".aws", ".kube", ".docker", ".gnupg"]) {
    it(`refuses a catch-all include on ~/${store}, but allows named files`, async () => {
      const ctx = await ctxWith();
      await mkdir(join(ctx.home, store));
      for (const glob of ["**", "*", "**/*.json"]) {
        const note = await roots(`add creds ~/${store} ${glob}`, ctx);
        assert.equal(note?.level, "warning", glob);
        assert.match(note?.message ?? "", new RegExp(`~/\\${store} holds credentials`));
        assert.deepEqual((await loadConfig(ctx.agentDir)).roots, {});
      }
      const ok = await roots(`add creds ~/${store} my-app/app.conf`, ctx);
      assert.equal(ok?.level, "info", ok?.message);
    });
  }

  it("a newline in a hand-edited root cannot forge a line of the roots list", async () => {
    const ctx = await ctxWith({ roots: { "x\n  evil  /  include: **  ok": { dir: "/nope\nfake", include: ["a\nb"], exclude: [] } } });
    const note = await roots("", ctx);
    assert.equal(note?.message.split("\n").length, 2, note?.message);
    assert.match(note?.message ?? "", /x\?  evil/);
  });
});
