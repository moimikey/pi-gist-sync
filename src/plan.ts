import type { Plan, PlanAction, PlanItem, SideEntry } from "./types.ts";

// Own-property read so a path named "__proto__" or "constructor" never hits the prototype.
function digestOf<T extends { digest: string } | string>(rec: Record<string, T>, path: string): string | undefined {
  if (!Object.hasOwn(rec, path)) return undefined;
  const v = rec[path];
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : v.digest;
}

function decide(b: string | undefined, s: string | undefined, t: string | undefined): PlanAction {
  if (s === t) return "unchanged";
  if (t === b) {
    if (s === undefined) return "delete";
    return t === undefined ? "add" : "update";
  }
  if (s === b) return "unchanged";
  return "conflict";
}

/** Per-path three-way plan with git-merge semantics: source wins unless the target also moved. */
export function planSync(
  base: Record<string, string>,
  source: Record<string, SideEntry>,
  target: Record<string, SideEntry>,
): Plan {
  // Base-only paths are gone from both sides, so they need no item.
  const paths = [...new Set([...Object.keys(source), ...Object.keys(target)])].sort();
  const items: PlanItem[] = paths.map((path) => ({
    path,
    action: decide(digestOf(base, path), digestOf(source, path), digestOf(target, path)),
  }));
  return { items };
}
