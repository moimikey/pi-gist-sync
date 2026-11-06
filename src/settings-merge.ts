import { isDeepStrictEqual } from "node:util";

// Per-machine, or security-sensitive: a remote edit must not widen trust or swap the updater.
export const MACHINE_LOCAL_KEYS: readonly string[] = Object.freeze([
  "lastChangelogVersion",
  "extensionChangelogVersions",
  "sessionDir",
  "shellPath",
  "httpProxy",
  "selfUpdateCommand",
  "npmCommand",
  "defaultProjectTrust",
  "deviceId",
  "trackingId",
]);

// Display and behavior keys that cannot run code, load paths or redirect traffic. Any other key,
// including one a future Pi adds, needs approval on pull.
export const SAFE_SETTINGS_KEYS: readonly string[] = Object.freeze([
  "$schema",
  "theme",
  "hideThinkingBlock",
  "quietStartup",
  "collapseChangelog",
  "showCacheMissNotices",
  "steeringMode",
  "followUpMode",
  "queueMode",
  "doubleEscapeAction",
  "treeFilterMode",
  "editorPaddingX",
  "outputPad",
  "autocompleteMaxVisible",
  "showHardwareCursor",
  "tuiMode",
  "fullscreenExitOutput",
  "fullscreenScrollbar",
  "fullscreenCopyOnSelect",
  "fullscreenWheelScrollLines",
  "terminal",
  "markdown",
  "images",
  "warnings",
  "compaction",
  "branchSummary",
  "thinkingBudgets",
  "defaultThinkingLevel",
  "modelThinkingLevels",
  "transport",
  "websockets",
  "httpIdleTimeoutMs",
  "websocketConnectTimeoutMs",
  "retry",
  "cacheWarming",
  "enableSkillCommands",
]);

type JsonObject = Record<string, unknown>;

// Pi strips a leading BOM before parsing, so a BOM'd file must not read as invalid here.
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The settings object, or undefined for invalid JSON or a non-object. */
export function parseSettings(text: string | undefined): JsonObject | undefined {
  if (text === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(stripBom(text));
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function stripMachineLocal(obj: JsonObject): void {
  for (const key of MACHINE_LOCAL_KEYS) delete obj[key];
}

function render(obj: JsonObject): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

/** Callers must reject invalid settings first: unparseable text comes back unchanged, machine-local keys included. */
export function canonicalSettings(text: string): string {
  const obj = parseSettings(text);
  if (!obj) return text;
  stripMachineLocal(obj);
  return render(obj);
}

export function mergeMachineLocal(remoteText: string, localText: string | undefined): string {
  const remote = parseSettings(remoteText);
  if (!remote) return remoteText;
  // Remote's own machine-local keys are dropped too; only the local values survive
  stripMachineLocal(remote);
  const local = parseSettings(localText);
  if (local) {
    for (const key of MACHINE_LOCAL_KEYS) {
      if (Object.hasOwn(local, key)) remote[key] = local[key];
    }
  }
  return render(remote);
}

// Code-unit order, so the key list reads the same on every machine.
function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// Own-property compare so a key named `__proto__` or `constructor` never resolves through the prototype.
function sameEntry(a: JsonObject, b: JsonObject, key: string): boolean {
  const inA = Object.hasOwn(a, key);
  return inA === Object.hasOwn(b, key) && (!inA || isDeepStrictEqual(a[key], b[key]));
}

/** Top-level keys whose value differs, sorted, machine-local keys aside. A missing `before` counts as `{}`. */
export function changedSettingsKeys(beforeText: string | undefined, afterText: string): string[] {
  const after = parseSettings(afterText) ?? {};
  const before = parseSettings(beforeText) ?? {};
  // Machine-local keys are never applied by a pull, so they cannot be a change.
  const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((k) => !MACHINE_LOCAL_KEYS.includes(k)));
  return [...keys].filter((key) => !sameEntry(before, after, key)).sort(byCodeUnit);
}

/** Changed keys that are not on the safe list: these decide whether a settings.json pull needs approval. */
export function unsafeSettingsChanges(beforeText: string | undefined, afterText: string): string[] {
  return changedSettingsKeys(beforeText, afterText).filter((key) => !SAFE_SETTINGS_KEYS.includes(key));
}
