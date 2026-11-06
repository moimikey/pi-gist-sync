import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { matchesAny } from "./globs.ts";
import type { CredentialMode, SyncConfig, SyncState } from "./types.ts";

export const CONFIG_FILE = "gist-sync.json";
export const STATE_FILE = "gist-sync.state.json";
export const BACKUP_DIR = "gist-sync-backups";

export const DEFAULT_INCLUDE: readonly string[] = Object.freeze([
  "settings.json",
  "keybindings.json",
  "mcp.json",
  "models.json",
  "AGENTS.md",
  "AGENTS.override.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
  "SYSTEM.md",
  "APPEND_SYSTEM.md",
  "extensions/**",
  "skills/**",
  "prompts/**",
  "themes/**",
  "agents/**",
  // third-party extension config such as mcp-adapter.json
  "*.json",
  "*.md",
]);

export const DEFAULT_EXCLUDE: readonly string[] = Object.freeze([
  "**/node_modules/**",
  "**/.git/**",
  "**/.DS_Store",
  "**/*.bak",
  "**/*.bak-*",
  "**/*.log",
  "**/*.jsonl",
  "**/*.tmp",
  "*-cache.json",
  "*-store.json",
  "**/__pycache__/**",
  "**/.ruff_cache/**",
  "sessions/**",
  "subagents/**",
  "checkpoints/**",
  "jobs/**",
  "tmp/**",
  "npm/**",
  "git/**",
  "memory-archive/**",
]);

// Matched case-insensitively at any depth: extensions keep tokens in nested dirs, and macOS ignores case.
export const CREDENTIAL_GLOBS: readonly string[] = Object.freeze([
  "**/auth.json",
  "**/*-auth.json",
  "**/oauth.json",
  "**/*credentials*.json",
  "**/*token*.json",
  "**/.env",
  "**/.env.*",
]);

export function isCredentialPath(path: string): boolean {
  return matchesAny(CREDENTIAL_GLOBS, path.toLowerCase());
}

// Pi's own per-machine files: trust grants name absolute project paths, so a synced one would widen trust.
const NEVER_SYNCED_TOP_LEVEL: ReadonlySet<string> = new Set(["trust.json", "oauth.json", "crashes.json"]);

/** Paths no config can opt into, in either direction. Lowercased because macOS and Windows ignore case. */
export function isAlwaysExcluded(path: string): boolean {
  const lower = path.toLowerCase();
  if (lower === CONFIG_FILE || lower === STATE_FILE || NEVER_SYNCED_TOP_LEVEL.has(lower)) return true;
  if (lower === BACKUP_DIR || lower.startsWith(`${BACKUP_DIR}/`)) return true;
  return lower.split("/").some((seg) => seg === ".git" || seg === "node_modules");
}

const DEFAULT_MAX_FILE_BYTES = 1048576;

// Same rule as Pi's own getAgentDir so both always point at one directory.
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  const override = env.PI_CODING_AGENT_DIR;
  if (override) {
    if (override === "~") return home;
    if (override.startsWith("~/") || (process.platform === "win32" && override.startsWith("~\\"))) {
      return join(home, override.slice(2));
    }
    return override;
  }
  return join(home, ".pi", "agent");
}

export function defaultConfig(): SyncConfig {
  return {
    include: [...DEFAULT_INCLUDE],
    exclude: [...DEFAULT_EXCLUDE],
    credentials: "skip",
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    checkOnStart: false,
  };
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

// ENOENT -> undefined; a file that is not valid JSON is treated like a missing one.
async function readJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function loadConfig(agentDir: string): Promise<SyncConfig> {
  const cfg = defaultConfig();
  const raw = await readJson(join(agentDir, CONFIG_FILE));
  if (!isRecord(raw)) return cfg;

  if (typeof raw.gistId === "string" && raw.gistId.length > 0) cfg.gistId = raw.gistId;
  if (isStringArray(raw.include)) cfg.include = raw.include;
  if (isStringArray(raw.exclude)) cfg.exclude = raw.exclude;
  if (raw.credentials === "skip" || raw.credentials === "encrypt") {
    cfg.credentials = raw.credentials as CredentialMode;
  }
  if (typeof raw.maxFileBytes === "number" && Number.isFinite(raw.maxFileBytes) && raw.maxFileBytes > 0) {
    cfg.maxFileBytes = Math.floor(raw.maxFileBytes);
  }
  if (typeof raw.checkOnStart === "boolean") cfg.checkOnStart = raw.checkOnStart;
  return cfg;
}

// Temp file in the same dir so rename is atomic; 0600 because state and config name the gist.
async function writeAtomic(agentDir: string, name: string, text: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const tmp = join(agentDir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(text, "utf8");
      await fh.chmod(0o600);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, join(agentDir, name));
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function saveConfig(agentDir: string, cfg: SyncConfig): Promise<void> {
  // Whitelist fields so stray properties never reach disk
  const out: SyncConfig = {
    include: cfg.include,
    exclude: cfg.exclude,
    credentials: cfg.credentials,
    maxFileBytes: cfg.maxFileBytes,
    checkOnStart: cfg.checkOnStart,
  };
  if (cfg.gistId !== undefined) out.gistId = cfg.gistId;
  await writeAtomic(agentDir, CONFIG_FILE, `${JSON.stringify(out, null, 2)}\n`);
}

export async function loadState(agentDir: string): Promise<SyncState | undefined> {
  const raw = await readJson(join(agentDir, STATE_FILE));
  if (!isRecord(raw)) return undefined;
  const { gistId, revision, files, syncedAt, signed } = raw;
  if (typeof gistId !== "string" || gistId.length === 0) return undefined;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return undefined;
  if (typeof syncedAt !== "string") return undefined;
  if (!isRecord(files)) return undefined;
  const entries = Object.entries(files);
  if (!entries.every(([, digest]) => typeof digest === "string")) return undefined;
  // fromEntries defines own properties, so a `__proto__` key cannot rewrite the prototype
  const state: SyncState = { gistId, revision, files: Object.fromEntries(entries) as Record<string, string>, syncedAt };
  if (signed === true) state.signed = true;
  return state;
}

export async function saveState(agentDir: string, st: SyncState): Promise<void> {
  const out: SyncState = { gistId: st.gistId, revision: st.revision, files: st.files, syncedAt: st.syncedAt };
  if (st.signed) out.signed = true;
  await writeAtomic(agentDir, STATE_FILE, `${JSON.stringify(out, null, 2)}\n`);
}

export async function clearState(agentDir: string): Promise<void> {
  try {
    await unlink(join(agentDir, STATE_FILE));
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}
