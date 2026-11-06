// Command layer: parses `/gist-sync ...`, wires the real environment into SyncApi, and maps every outcome to notify().
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveAgentDir } from "./config.ts";
import { createGistClient, resolveToken } from "./gist-client.ts";
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
}>;

export const SUBCOMMANDS: readonly string[] = ["init", "status", "push", "pull", "scan", "unlink", "help"];

export const SUBCOMMAND_SUMMARY: Readonly<Record<string, string>> = {
  init: "Create a secret gist, or link an existing one: init [gist-id] [--yes]",
  status: "Compare this machine with the gist",
  push: "Upload local changes: push [--force] [--dry-run]",
  pull: "Apply gist changes locally: pull [--force] [--dry-run] [--prune] [--yes]",
  scan: "List files under the agent dir that are not synced",
  unlink: "Forget the linked gist (the gist and local files stay untouched)",
  help: "Show this help",
};

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
      ? "No unsynced files under the agent dir."
      : [`${files.length} file(s) under the agent dir are not synced (edit include/exclude in gist-sync.json):`, ...listPaths(files, 100)].join("\n"),
    "info",
  );
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
const REVIEW_PER_TIER = 8;

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function reviewLine(r: PullReview): string {
  const parts = [`${r.action} ${r.path}`];
  if (r.keys && r.keys.length > 0) parts.push(`keys: ${r.keys.join(", ")}`);
  if (r.sha256 !== undefined) parts.push(`sha256:${r.sha256.slice(0, 12)} ${formatSize(r.size ?? 0)}`);
  return `  ${parts.join("  ")}`;
}

/** Groups the changes by what they can do, with a content hash so an unexpected edit stands out. */
export function describeReview(review: readonly PullReview[]): string {
  const lines = [`${review.length} change(s) need your approval:`];
  for (const tier of ["code", "instructions", "other"] as const) {
    const group = review.filter((r) => r.tier === tier);
    if (group.length === 0) continue;
    // Code Pi runs is never truncated: approving it unseen is the risk this prompt exists to prevent.
    const shown = tier === "code" ? group : group.slice(0, REVIEW_PER_TIER);
    lines.push(`${TIER_TITLES[tier]} (${group.length})`, ...shown.map(reviewLine));
    if (shown.length < group.length) lines.push(`  ...and ${group.length - shown.length} more`);
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
