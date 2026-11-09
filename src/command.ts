// Command layer: parses `/gist-sync ...`, wires the real environment into SyncApi, and maps every outcome to notify().
import { readFile, realpath } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveAgentDir, saveConfig } from "./config.ts";
import { createGistClient, resolveToken } from "./gist-client.ts";
import { expandHome, ROOT_NAME, resolveRoots } from "./roots.ts";
import { sync } from "./sync.ts";
import type { GistClient, PullPlan, PullReview, ReviewTier, SyncApi, SyncConfig, SyncEnv } from "./types.ts";
import { GistSyncError } from "./types.ts";

export interface CommandIO {
  notify(message: string, level: "info" | "warning" | "error"): void;
  confirm(title: string, message: string): Promise<boolean>; // false when no UI
  input(title: string, placeholder?: string): Promise<string | undefined>;
  hasUI: boolean;
  reload(): Promise<void>;
  exec(cmd: string, args: string[]): Promise<{ stdout: string; code: number }>;
}

export type CommandDeps = Partial<{
  api: SyncApi;
  env: NodeJS.ProcessEnv;
  agentDir: string;
  client: GistClient;
  /** Home dir for `~` in root dirs; tests pass a temp dir. */
  home: string;
}>;

export const SUBCOMMANDS: readonly string[] = ["init", "status", "push", "pull", "scan", "roots", "unlink", "help"];

export const SUBCOMMAND_SUMMARY: Readonly<Record<string, string>> = {
  init: "Create a secret gist, or link an existing one: init [gist-id] [--yes]",
  status: "Compare this machine with the gist",
  push: "Upload local changes: push [--force] [--dry-run]",
  pull: "Apply gist changes locally: pull [--force] [--dry-run] [--prune] [--yes]",
  scan: "List files under the agent dir and roots that are not synced",
  roots: "List, add or remove extra synced dirs: roots [add <name> <dir> <glob>... | remove <name>]",
  unlink: "Forget the linked gist (the gist and local files stay untouched)",
  help: "Show this help",
};

export interface Completion {
  value: string;
  label: string;
  description?: string;
}

const ROOTS_ACTIONS: Readonly<Record<string, string>> = {
  add: "Add a root: roots add <name> <dir> <glob>...",
  remove: "Remove a root from local config: roots remove <name>",
};

/** True when completing the name after `roots remove`, which needs the configured names. */
export function wantsRootNames(prefix: string): boolean {
  return /^\s*roots\s+remove\s+\S*$/i.test(prefix);
}

/** Pi replaces the whole argument text with `value`, so nested items carry the words before them. */
export function argumentCompletions(prefix: string, rootNames: readonly string[] = []): Completion[] | null {
  const words = prefix.trimStart().split(/\s+/);
  let items: Completion[];
  if (words.length === 1) {
    const typed = words[0]!.toLowerCase();
    items = SUBCOMMANDS.filter((s) => s.startsWith(typed)).map((s) => ({ value: s, label: s, description: SUBCOMMAND_SUMMARY[s] }));
  } else if (words[0]!.toLowerCase() === "roots" && words.length === 2) {
    const typed = words[1]!.toLowerCase();
    items = Object.keys(ROOTS_ACTIONS)
      .filter((a) => a.startsWith(typed))
      .map((a) => ({ value: `roots ${a}`, label: a, description: ROOTS_ACTIONS[a] }));
  } else if (wantsRootNames(prefix)) {
    const typed = words[2] ?? "";
    items = rootNames.filter((n) => n.startsWith(typed)).map((n) => ({ value: `roots remove ${n}`, label: n }));
  } else {
    return null;
  }
  return items.length > 0 ? items : null;
}

/** Configured root names for completion; empty when the config cannot be read. */
export async function configuredRootNames(deps: CommandDeps = {}): Promise<string[]> {
  try {
    const config = await loadConfig(deps.agentDir ?? resolveAgentDir(deps.env ?? process.env));
    return Object.keys(config.roots).sort();
  } catch {
    return [];
  }
}

const ALLOWED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  init: ["yes"],
  push: ["force", "dry-run"],
  pull: ["force", "dry-run", "prune", "yes"],
};

const HELP = [
  "/gist-sync <command>",
  ...SUBCOMMANDS.map((s) => `  ${s.padEnd(7)} ${SUBCOMMAND_SUMMARY[s] ?? ""}`),
  "Token: PI_GIST_SYNC_TOKEN, GH_TOKEN, GITHUB_TOKEN, or `gh auth token` (needs the gist scope).",
].join("\n");

const ROOTS_USAGE = [
  "Usage:",
  "  /gist-sync roots                             list roots",
  "  /gist-sync roots add <name> <dir> <glob>...  sync files under <dir> matching a glob as @<name>/...",
  "  /gist-sync roots remove <name>               forget a root (the gist and local files stay untouched)",
  "A name is lowercase letters, digits and dashes (up to 32). At least one include glob is required.",
].join("\n");

const MAX_LISTED = 20;
const DEFAULT_STARTUP_TIMEOUT_MS = 5000;

/** Flags come back without their dashes (`--dry-run` -> "dry-run"); the first bare word is the subcommand. */
export function parseArgs(args: string): { sub: string; flags: Set<string>; rest: string[] } {
  const flags = new Set<string>();
  const words: string[] = [];
  for (const tok of args.trim().split(/\s+/)) {
    if (tok === "") continue;
    if (/^-{1,2}[^-\s]/.test(tok)) flags.add(tok.replace(/^-+/, "").toLowerCase());
    else words.push(tok);
  }
  const [first, ...rest] = words;
  return { sub: first?.toLowerCase() ?? "help", flags, rest };
}

// ---- output gate: every user-visible string goes through here ----------------

const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\b(?:Bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[0-9a-f]{40}\b/g, // legacy classic tokens
];

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

// Paths come from a remote manifest; strip escapes and bidi marks so they cannot spoof a prompt.
function plain(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[^\P{Cc}\n\t]|[\u202a-\u202e\u2066-\u2069]/gu, "?");
}

// One field of a prompt line: a newline here could forge a whole extra line.
function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, "?");
}

type Level = "info" | "warning" | "error";
type Say = (message: string, level: Level) => void;

function makeSay(io: CommandIO, secrets: readonly string[]): Say {
  return (message, level) => {
    try {
      io.notify(plain(redact(message, secrets)), level);
    } catch {
      // A broken UI must not turn into an unhandled rejection.
    }
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

function listPaths(paths: readonly string[], limit = MAX_LISTED): string[] {
  const shown = paths.slice(0, limit).map((p) => `  ${p}`);
  if (paths.length > limit) shown.push(`  ...and ${paths.length - limit} more`);
  return shown;
}

// ---- environment wiring ------------------------------------------------------

let versionCache: Promise<string> | undefined;

async function readPackageVersion(): Promise<string> {
  try {
    const text = await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");
    const v: unknown = (JSON.parse(text) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0"; // a missing or unreadable package.json must not block syncing
  }
}

function packageVersion(): Promise<string> {
  versionCache ??= readPackageVersion();
  return versionCache;
}

async function resolveClient(io: CommandIO, deps: CommandDeps, secrets: string[]): Promise<GistClient> {
  if (deps.client) return deps.client;
  const ghAuthToken = async (): Promise<string | undefined> => {
    try {
      const res = await io.exec("gh", ["auth", "token"]);
      const token = res.stdout.trim();
      return res.code === 0 && token !== "" ? token : undefined;
    } catch {
      return undefined; // gh missing or not runnable: fall through to NO_TOKEN
    }
  };
  const token = await resolveToken(deps.env ?? process.env, ghAuthToken);
  secrets.push(token);
  return createGistClient({ token, userAgent: `pi-gist-sync/${await packageVersion()}` });
}

// scan and unlink never touch GitHub, so they must work without a token.
function offlineClient(): GistClient {
  const fail = (): never => {
    throw new GistSyncError("NO_TOKEN", "This command does not talk to GitHub.");
  };
  return { create: async () => fail(), get: async () => fail(), update: async () => fail(), viewer: async () => fail() };
}

async function resolvePassphrase(
  io: CommandIO,
  env: NodeJS.ProcessEnv,
  config: SyncConfig,
  secrets: string[],
  mayPrompt: boolean,
): Promise<string | undefined> {
  const fromEnv = env.PI_GIST_SYNC_PASSPHRASE;
  let passphrase: string | undefined = fromEnv !== undefined && fromEnv !== "" ? fromEnv : undefined;
  if (passphrase === undefined && mayPrompt && config.credentials === "encrypt" && io.hasUI) {
    const typed = await io.input("Gist sync passphrase", "Typed text is visible; prefer PI_GIST_SYNC_PASSPHRASE");
    passphrase = typed !== undefined && typed !== "" ? typed : undefined;
  }
  if (passphrase !== undefined) secrets.push(passphrase);
  return passphrase;
}

async function baseEnv(deps: CommandDeps, client: GistClient, passphrase?: string): Promise<SyncEnv> {
  return {
    agentDir: deps.agentDir ?? resolveAgentDir(deps.env ?? process.env),
    home: deps.home ?? homedir(),
    client,
    passphrase,
    hostname: hostname(),
    version: await packageVersion(),
    now: () => new Date(),
  };
}

// Static imports: jiti can hand a second concurrent dynamic import() of one module an empty namespace.
function loadApi(deps: CommandDeps): SyncApi {
  return deps.api ?? sync;
}

// ---- command dispatch --------------------------------------------------------

export async function runCommand(args: string, io: CommandIO, deps: CommandDeps = {}): Promise<void> {
  const secrets: string[] = [];
  const say = makeSay(io, secrets);
  try {
    await dispatch(args, io, deps, secrets, say);
  } catch (err) {
    say(describeError(err), "error");
  }
}

async function dispatch(args: string, io: CommandIO, deps: CommandDeps, secrets: string[], say: Say): Promise<void> {
  const { sub, flags, rest } = parseArgs(args);
  if (!SUBCOMMANDS.includes(sub)) {
    say(`Unknown subcommand "${sub}".\n${HELP}`, "warning");
    return;
  }
  if (sub === "help") {
    say(HELP, "info");
    return;
  }
  // Roots edit local config only: no token, no gist link, and their own argument shape.
  if (sub === "roots") return runRoots(rest, flags, deps, say);

  const allowed = ALLOWED_FLAGS[sub] ?? [];
  const unknownFlags = [...flags].filter((f) => !allowed.includes(f));
  if (unknownFlags.length > 0) {
    // A mistyped --dry-run must not silently become a real push.
    say(`Unknown flag ${unknownFlags.map((f) => `--${f}`).join(", ")} for "${sub}". Run /gist-sync help.`, "warning");
    return;
  }
  if (rest.length > (sub === "init" ? 1 : 0)) {
    say(`Unexpected argument "${rest[sub === "init" ? 1 : 0]}" for "${sub}". Run /gist-sync help.`, "warning");
    return;
  }

  if (sub === "init") return runInit(rest[0], flags.has("yes"), io, deps, secrets, say);
  if (sub === "scan" || sub === "unlink") return runOffline(sub, deps, say);
  return runSynced(sub, flags, io, deps, secrets, say);
}

function parseGistId(input: string): string | undefined {
  let id = input;
  if (/^https?:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (url.hostname !== "gist.github.com") return undefined;
      id = url.pathname.split("/").filter(Boolean).pop() ?? "";
    } catch {
      return undefined;
    }
  }
  // The id lands in an API path, so reject anything that is not a plain id.
  return /^[A-Za-z0-9]{1,64}$/.test(id) ? id : undefined;
}

async function runInit(
  arg: string | undefined,
  yes: boolean,
  io: CommandIO,
  deps: CommandDeps,
  secrets: string[],
  say: Say,
): Promise<void> {
  let gistId: string | undefined;
  if (arg !== undefined) {
    gistId = parseGistId(arg);
    if (gistId === undefined) {
      say(`"${arg}" is not a gist ID or gist URL.`, "warning");
      return;
    }
  }
  const api = loadApi(deps);
  const client = await resolveClient(io, deps, secrets);
  const res = await api.init(await baseEnv(deps, client), {
    gistId,
    confirmForeign: (owner) => confirmForeign(io, owner, yes),
  });
  const lines = res.created
    ? [
        `Created secret gist ${res.gistId}: ${res.gistUrl}`,
        "Secret gists are unlisted, not private: anyone with the URL can read them.",
        "Next: /gist-sync push",
      ]
    : [`Linked gist ${res.gistId}: ${res.gistUrl}`, "Next: /gist-sync pull"];
  say(lines.join("\n"), "info");
}

async function runOffline(sub: "scan" | "unlink", deps: CommandDeps, say: Say): Promise<void> {
  const api = loadApi(deps);
  const env = await baseEnv(deps, offlineClient());
  if (sub === "unlink") {
    await api.unlink(env);
    say("Unlinked. The gist and your local files were not touched.", "info");
    return;
  }
  const files = await api.scanCandidates(env);
  say(
    files.length === 0
      ? "No unsynced files under the agent dir or roots."
      : [
          `${files.length} file(s) are not synced (edit include/exclude in gist-sync.json; @<name>/ paths belong to roots):`,
          ...listPaths(files, 100),
        ].join("\n"),
    "info",
  );
}

// ---- roots: local config only, never read from or written to the gist ----------

async function runRoots(rest: readonly string[], flags: ReadonlySet<string>, deps: CommandDeps, say: Say): Promise<void> {
  if (flags.size > 0) {
    say(`Unknown flag ${[...flags].map((f) => `--${f}`).join(", ")} for "roots".\n${ROOTS_USAGE}`, "warning");
    return;
  }
  const agentDir = deps.agentDir ?? resolveAgentDir(deps.env ?? process.env);
  const ctx = { agentDir, home: deps.home ?? homedir() };
  const [action, ...args] = rest;
  if (action === undefined) return listRoots(ctx, say);
  const verb = action.toLowerCase();
  if (verb === "add") return addRoot(args, ctx, say);
  if (verb === "remove") return removeRoot(args, ctx, say);
  say(`Unknown roots action "${action}".\n${ROOTS_USAGE}`, "warning");
}

async function listRoots(ctx: { agentDir: string; home: string }, say: Say): Promise<void> {
  const config = await loadConfig(ctx.agentDir);
  const names = Object.keys(config.roots).sort();
  if (names.length === 0) {
    say("No roots configured. Add one with: /gist-sync roots add <name> <dir> <glob>...", "info");
    return;
  }
  const { problems } = await resolveRoots(config, ctx);
  const lines = [`${names.length} root(s):`];
  for (const name of names) {
    const root = config.roots[name]!;
    const problem = problems.find((p) => p.name === name);
    // A hand-edited config can hold a newline, which would forge a line of this list.
    const parts = [`  ${oneLine(name)}  ${oneLine(root.dir)}  include: ${oneLine(root.include.join(", "))}`];
    if (root.exclude.length > 0) parts.push(`exclude: ${oneLine(root.exclude.join(", "))}`);
    parts.push(problem ? `ignored: ${oneLine(problem.message)}` : "ok");
    lines.push(parts.join("  "));
  }
  say(lines.join("\n"), "info");
}

async function addRoot(args: readonly string[], ctx: { agentDir: string; home: string }, say: Say): Promise<void> {
  const [name, dir, ...include] = args;
  if (name === undefined || dir === undefined || include.length === 0) {
    // No glob means no default: a root never syncs a whole dir by accident.
    say(`roots add needs a name, a dir and at least one include glob.\n${ROOTS_USAGE}`, "warning");
    return;
  }
  if (!ROOT_NAME.test(name)) {
    say(`"${name}" is not a valid root name.\n${ROOTS_USAGE}`, "warning");
    return;
  }
  const config = await loadConfig(ctx.agentDir);
  if (Object.hasOwn(config.roots, name)) {
    say(`Root "${name}" already exists. Remove it first: /gist-sync roots remove ${name}`, "warning");
    return;
  }
  const next = { ...config, roots: { ...config.roots, [name]: { dir, include, exclude: [] } } };
  const before = new Set((await resolveRoots(config, ctx)).problems.map((p) => p.name));
  const { problems } = await resolveRoots(next, ctx);
  // Overlap drops the later name, so the new root can also knock out one that worked before.
  const caused = problems.filter((p) => p.name === name || !before.has(p.name));
  if (caused.length > 0) {
    const why = caused.map((p) => (p.name === name ? p.message : `root "${p.name}" would break: ${p.message}`));
    say(`Root "${name}" not added: ${why.join("; ")}`, "warning");
    return;
  }
  const broad = await credentialStoreCatchAll(dir, include, ctx.home);
  if (broad !== undefined) {
    say(`Root "${name}" not added: ${broad} holds credentials, so a catch-all include (${include.join(", ")}) is refused. Name the files instead.`, "warning");
    return;
  }
  await saveConfig(ctx.agentDir, next);
  say(`Root "${name}" added: ${dir} (${include.length} include glob(s)). Everything under a root needs approval on pull.`, "info");
}

// Dirs under ~ that mostly hold keys and tokens; a catch-all root there would push every new one.
const CREDENTIAL_STORES: readonly string[] = [".config", ".ssh", ".aws", ".kube", ".docker", ".gnupg"];

function isCatchAll(glob: string): boolean {
  const first = glob.split("/")[0];
  return first === "*" || first === "**";
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/** The `~/...` name of the credential store `dir` is, when any include glob is a catch-all. */
async function credentialStoreCatchAll(dir: string, include: readonly string[], home: string): Promise<string | undefined> {
  if (!include.some(isCatchAll)) return undefined;
  const real = (await realOrSelf(expandHome(dir, home))).toLowerCase();
  for (const store of CREDENTIAL_STORES) {
    if ((await realOrSelf(join(home, store))).toLowerCase() === real) return `~/${store}`;
  }
  return undefined;
}

async function removeRoot(args: readonly string[], ctx: { agentDir: string; home: string }, say: Say): Promise<void> {
  if (args.length !== 1) {
    say(`roots remove takes exactly one name.\n${ROOTS_USAGE}`, "warning");
    return;
  }
  const name = args[0]!;
  const config = await loadConfig(ctx.agentDir);
  if (!Object.hasOwn(config.roots, name)) {
    say(`No root named "${name}".`, "warning");
    return;
  }
  const roots = Object.fromEntries(Object.entries(config.roots).filter(([n]) => n !== name));
  await saveConfig(ctx.agentDir, { ...config, roots });
  say(`Root "${name}" removed from gist-sync.json. The gist and local files were not touched.`, "info");
}

async function runSynced(
  sub: string,
  flags: ReadonlySet<string>,
  io: CommandIO,
  deps: CommandDeps,
  secrets: string[],
  say: Say,
): Promise<void> {
  const api = loadApi(deps);
  const client = await resolveClient(io, deps, secrets);
  const processEnv = deps.env ?? process.env;
  const agentDir = deps.agentDir ?? resolveAgentDir(processEnv);
  const config = await loadConfig(agentDir);
  const passphrase = await resolvePassphrase(io, processEnv, config, secrets, true);
  const env = await baseEnv({ ...deps, agentDir }, client, passphrase);
  const dryRun = flags.has("dry-run");

  if (sub === "status") {
    say(joinLines((await api.status(env)).lines, "Nothing to report."), "info");
  } else if (sub === "push") {
    say(joinLines((await api.push(env, { force: flags.has("force"), dryRun })).lines, "Nothing to push."), "info");
  } else {
    const res = await api.pull(env, {
      force: flags.has("force"),
      dryRun,
      prune: flags.has("prune"),
      // A dry run writes nothing, so it has nothing to confirm.
      confirm: dryRun ? undefined : (plan) => confirmReview(io, plan, flags.has("yes")),
    });
    say(joinLines(res.lines, "Nothing to pull."), "info");
    if (!dryRun && res.needsReload) await offerReload(io, say);
  }
}

function joinLines(lines: readonly string[], fallback: string): string {
  return lines.length > 0 ? lines.join("\n") : fallback;
}

async function confirmForeign(io: CommandIO, owner: string | undefined, yes: boolean): Promise<boolean> {
  if (yes) return true;
  const who = owner ?? "an account that could not be identified";
  if (!io.hasUI) {
    throw new GistSyncError("ABORTED", `That gist belongs to ${who}, not to your token's account. Re-run with --yes to link it anyway.`);
  }
  return io.confirm(
    "Link a gist owned by someone else?",
    `This gist belongs to ${plain(who)}, not to your account. Whoever owns it controls the files you pull.`,
  );
}

const TIER_TITLES: Readonly<Record<ReviewTier, string>> = {
  code: "Code and settings Pi runs",
  instructions: "Instructions and skills that steer the model",
  other: "Other files",
};

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

// Root files may land on PATH, so a look-alike letter in their name is shown as an escape.
function ascii(text: string): string {
  return oneLine(text).replace(/[^\x20-\x7e]/gu, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`);
}

function reviewLine(r: PullReview): string {
  // A root file names where it lands, since that dir may be on PATH.
  const target = r.dest !== undefined ? `${ascii(r.path)} -> ${ascii(r.dest)}` : oneLine(r.path);
  const parts = [`${r.action} ${target}`];
  if (r.keys && r.keys.length > 0) parts.push(`keys: ${oneLine(r.keys.join(", "))}`);
  if (r.sha256 !== undefined) parts.push(`sha256:${r.sha256.slice(0, 12)} ${formatSize(r.size ?? 0)}`);
  return `  ${parts.join("  ")}`;
}

/** Groups the changes by what they can do, with a content hash so an unexpected edit stands out. */
export function describeReview(review: readonly PullReview[]): string {
  const lines = [`${review.length} change(s) need your approval:`];
  for (const tier of ["code", "instructions", "other"] as const) {
    const group = review.filter((r) => r.tier === tier);
    if (group.length === 0) continue;
    // Never truncated: a file approved unseen is the risk this prompt exists to prevent, and a gist caps it at 300.
    lines.push(`${TIER_TITLES[tier]} (${group.length})`, ...group.map(reviewLine));
  }
  return lines.join("\n");
}

async function confirmReview(io: CommandIO, plan: PullPlan, yes: boolean): Promise<boolean> {
  if (plan.review.length === 0 || yes) return true;
  const text = describeReview(plan.review);
  if (!io.hasUI) {
    throw new GistSyncError("ABORTED", `This pull changes files that need approval and there is no UI to confirm. Re-run with --yes to apply.\n${text}`);
  }
  return io.confirm("Apply changes from the gist?", plain(text));
}

async function offerReload(io: CommandIO, say: Say): Promise<void> {
  if (!io.hasUI) {
    say("Run /reload to apply the pulled changes.", "info");
    return;
  }
  if (await io.confirm("Reload Pi?", "The pulled changes apply after a reload.")) {
    await io.reload(); // terminal: the old command context is stale afterwards
    return;
  }
  say("Run /reload when you are ready to apply the pulled changes.", "info");
}

// ---- session-start probe -----------------------------------------------------

/** Quiet remote-ahead check for `checkOnStart`: never prompts, never throws, gives up after `timeoutMs`. */
export async function startupCheck(
  io: CommandIO,
  deps: CommandDeps = {},
  timeoutMs: number = DEFAULT_STARTUP_TIMEOUT_MS,
): Promise<void> {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([probe(io, deps, () => live), timeout]);
  } catch {
    // A background probe has nobody to report to.
  } finally {
    live = false;
    clearTimeout(timer);
  }
}

async function probe(io: CommandIO, deps: CommandDeps, isLive: () => boolean): Promise<void> {
  const secrets: string[] = [];
  const processEnv = deps.env ?? process.env;
  const agentDir = deps.agentDir ?? resolveAgentDir(processEnv);
  const config = await loadConfig(agentDir);
  if (!config.checkOnStart || !config.gistId) return;
  const api = loadApi(deps);
  const client = await resolveClient(io, deps, secrets);
  const passphrase = await resolvePassphrase(io, processEnv, config, secrets, false);
  const status = await api.status(await baseEnv({ ...deps, agentDir }, client, passphrase));
  if (isLive() && status.behind.length > 0) {
    makeSay(io, secrets)(`Pi gist sync: ${status.behind.length} remote change(s) not pulled yet. Run /gist-sync pull.`, "info");
  }
}
