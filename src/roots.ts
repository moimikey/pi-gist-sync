import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { isCredentialPath } from "./config.ts";
import type { SyncConfig } from "./types.ts";

export const ROOT_PREFIX = "@";
export const ROOT_NAME: RegExp = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface ResolvedRoot {
  name: string;
  /** Absolute, realpath'd. */
  dir: string;
  include: readonly string[];
  exclude: readonly string[];
  /** dev:ino at resolve time; a write refuses a root dir whose identity changed since. */
  id?: string;
  /** The dir relative to realpath(home), or its absolute path without the leading slash outside home; POSIX separators. */
  credPrefix: string;
}

export interface RootProblem {
  name: string;
  message: string;
}

/** "@a/b/c" -> { name: "a", rel: "b/c" }; undefined for non-root paths and a root with no rel. */
export function splitRootPath(gistPath: string): { name: string; rel: string } | undefined {
  if (!gistPath.startsWith(ROOT_PREFIX)) return undefined;
  const slash = gistPath.indexOf("/");
  if (slash <= ROOT_PREFIX.length) return undefined;
  const rel = gistPath.slice(slash + 1);
  if (rel === "") return undefined;
  return { name: gistPath.slice(ROOT_PREFIX.length, slash), rel };
}

export function joinRootPath(name: string, rel: string): string {
  return `${ROOT_PREFIX}${name}/${rel}`;
}

/** Only "~" and "~/x"; "~user" needs a passwd lookup, so it is left as is and then fails the absolute check. */
export function expandHome(dir: string, home: string): string {
  if (dir === "~") return home;
  if (dir.startsWith("~/")) return join(home, dir.slice(2));
  return dir;
}

// macOS and Windows volumes usually ignore case, so "~/Bin" and "~/bin" are one dir there.
const caseInsensitive = process.platform === "darwin" || process.platform === "win32";

function fold(p: string): string {
  return caseInsensitive ? p.toLowerCase() : p;
}

function samePath(a: string, b: string): boolean {
  return fold(a) === fold(b);
}

/** True when `child` is strictly below `parent`. */
function isInside(parent: string, child: string): boolean {
  const rel = relative(fold(parent), fold(child));
  if (rel === "" || isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

function overlaps(a: string, b: string): boolean {
  return samePath(a, b) || isInside(a, b) || isInside(b, a);
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

// Realpath of the deepest existing ancestor plus the rest, so a not-yet-created agent dir still compares correctly.
async function realpathLoose(p: string): Promise<string> {
  const abs = resolve(p);
  try {
    return await realpath(abs);
  } catch (err) {
    const parent = dirname(abs);
    if (parent === abs || errCode(err) !== "ENOENT") return abs;
    return join(await realpathLoose(parent), basename(abs));
  }
}

function idOf(st: { dev: number; ino: number }): string {
  return `${st.dev}:${st.ino}`;
}

async function idAt(p: string): Promise<string | undefined> {
  try {
    return idOf(await stat(p));
  } catch {
    return undefined;
  }
}

/** A real dir's identity plus the identities of its existing ancestors. */
interface Located {
  path: string;
  id: string | undefined;
  chain: Set<string>;
}

async function locate(path: string): Promise<Located> {
  const chain = new Set<string>();
  for (let dir = path; ; dir = dirname(dir)) {
    const id = await idAt(dir);
    if (id !== undefined) chain.add(id);
    if (dirname(dir) === dir) break;
  }
  return { path, id: await idAt(path), chain };
}

// Walks `outer` + `parts` with lstat so a symlink inside `outer` never counts as containment.
async function idBelow(outer: string, parts: readonly string[]): Promise<string | undefined> {
  let current = outer;
  let st;
  try {
    for (const part of parts) {
      current = join(current, part);
      st = await lstat(current);
      if (st.isSymbolicLink()) return undefined;
    }
  } catch {
    return undefined;
  }
  return st ? idOf(st) : undefined;
}

/**
 * True when `outer` is `inner` or holds it, by dev:ino rather than by string, so an alias such as a
 * macOS firmlink (/System/Volumes/Data/...) or a bind mount is caught: either `outer` is one of
 * `inner`'s ancestors, or `outer` plus a tail of `inner`'s path lands on `inner`.
 */
async function holds(outer: Located, inner: Located): Promise<boolean> {
  if (outer.id !== undefined && inner.chain.has(outer.id)) return true;
  if (outer.id === undefined || inner.id === undefined) return false;
  const parts = inner.path.split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    if ((await idBelow(outer.path, parts.slice(i))) === inner.id) return true;
  }
  return false;
}

/** Some credential globs name the dir (`{.,}kube/config`), so the root's own place counts too. */
export function isRootCredential(root: Pick<ResolvedRoot, "credPrefix">, rel: string): boolean {
  return isCredentialPath(rel) || (root.credPrefix !== "" && isCredentialPath(`${root.credPrefix}/${rel}`));
}

// Where the dir sits under home, so the credential globs see `.kube/config` and not just `config`.
function credPrefixOf(realHome: string, real: string): string {
  if (isInside(realHome, real)) {
    const rel = relative(realHome, real);
    // A case-only difference on a folding disk makes the plain relative path climb out.
    const posix = rel === ".." || rel.startsWith(`..${sep}`) ? relative(fold(realHome), fold(real)) : rel;
    return posix.split(sep).join("/");
  }
  return real.slice(parse(real).root.length).split(sep).join("/");
}

// Code-unit order so the later name in a clash is the same on every machine.
function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

async function resolveDir(dir: string): Promise<{ real: string } | { message: string }> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch (err) {
    if (errCode(err) === "ENOENT") return { message: `directory does not exist: ${dir}` };
    return { message: `cannot resolve ${dir}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    if (!(await stat(real)).isDirectory()) return { message: `not a directory: ${dir}` };
  } catch (err) {
    return { message: `cannot inspect ${dir}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { real };
}

export async function resolveRoots(
  config: SyncConfig,
  ctx: { agentDir: string; home: string },
): Promise<{ roots: Map<string, ResolvedRoot>; problems: RootProblem[] }> {
  const roots = new Map<string, ResolvedRoot>();
  const problems: RootProblem[] = [];
  const homes = [resolve(ctx.home), await realpathLoose(ctx.home)];
  const agentDirs = [resolve(ctx.agentDir), await realpathLoose(ctx.agentDir)];
  const home = await locate(homes[1]!);
  const agent = await locate(agentDirs[1]!);
  const located = new Map<string, Located>();

  const entries = Object.entries(config.roots ?? {}).sort(([a], [b]) => compareStrings(a, b));
  for (const [name, entry] of entries) {
    const refuse = (message: string): void => {
      problems.push({ name, message });
    };
    if (!ROOT_NAME.test(name)) {
      refuse("invalid name: use 1 to 32 of a-z, 0-9 and -, starting with a letter or digit");
      continue;
    }
    // Configs built in code skip loadConfig's checks, so re-check the shape here
    const raw: unknown = entry;
    if (typeof raw !== "object" || raw === null) {
      refuse("not an object");
      continue;
    }
    const { dir, include, exclude } = raw as Partial<Record<keyof typeof entry, unknown>>;
    if (typeof dir !== "string" || dir === "") {
      refuse("dir must be a non-empty string");
      continue;
    }
    if (!isStringArray(include) || include.length === 0) {
      refuse("include must be a non-empty list of globs");
      continue;
    }
    if (exclude !== undefined && !isStringArray(exclude)) {
      refuse("exclude must be a list of globs");
      continue;
    }
    const expanded = expandHome(dir, ctx.home);
    if (!isAbsolute(expanded)) {
      refuse(`dir must be absolute or start with ~/: ${dir}`);
      continue;
    }
    const resolved = await resolveDir(expanded);
    if ("message" in resolved) {
      refuse(resolved.message);
      continue;
    }
    const real = resolved.real;
    if (samePath(real, parse(real).root)) {
      refuse("refusing the filesystem root");
      continue;
    }
    const here = await locate(real);
    if (homes.some((h) => samePath(real, h) || isInside(real, h)) || (await holds(here, home))) {
      refuse("refusing the home directory or a directory that contains it");
      continue;
    }
    if (agentDirs.some((a) => overlaps(real, a)) || (await holds(here, agent)) || (await holds(agent, here))) {
      refuse("overlaps the agent dir");
      continue;
    }
    let clash: ResolvedRoot | undefined;
    for (const r of roots.values()) {
      const other = located.get(r.name) as Located;
      if (overlaps(real, r.dir) || (await holds(here, other)) || (await holds(other, here))) {
        clash = r;
        break;
      }
    }
    if (clash) {
      refuse(`overlaps root "${clash.name}"`);
      continue;
    }
    located.set(name, here);
    const root: ResolvedRoot = {
      name,
      dir: real,
      include: [...include],
      exclude: exclude ? [...exclude] : [],
      credPrefix: credPrefixOf(homes[1]!, real),
    };
    if (here.id !== undefined) root.id = here.id;
    roots.set(name, root);
  }
  return { roots, problems };
}
