import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planSync } from "../src/plan.ts";
import type { PlanAction, SideEntry } from "../src/types.ts";

const side = (digest: string): SideEntry => ({ digest, size: digest.length, mode: 0o644 });

// Builds sides from digests; undefined means the path is absent on that side.
function actionFor(b: string | undefined, s: string | undefined, t: string | undefined): PlanAction {
  const base: Record<string, string> = b === undefined ? {} : { p: b };
  const source: Record<string, SideEntry> = s === undefined ? {} : { p: side(s) };
  const target: Record<string, SideEntry> = t === undefined ? {} : { p: side(t) };
  const { items } = planSync(base, source, target);
  const hit = items.find((i) => i.path === "p");
  // A path absent from every side is simply not reported.
  return hit ? hit.action : "unchanged";
}

describe("planSync truth table (b = base, s = source, t = target)", () => {
  const cases: Array<[string, string | undefined, string | undefined, string | undefined, PlanAction]> = [
    // synced before (b defined)
    ["all equal", "A", "A", "A", "unchanged"],
    ["source edited, target untouched", "A", "B", "A", "update"],
    ["source deleted, target untouched", "A", undefined, "A", "delete"],
    ["target edited only", "A", "A", "B", "unchanged"],
    ["target deleted only", "A", "A", undefined, "unchanged"],
    ["both edited differently", "A", "B", "C", "conflict"],
    ["both edited identically", "A", "B", "B", "unchanged"],
    ["source edited, target deleted", "A", "B", undefined, "conflict"],
    ["source deleted, target edited", "A", undefined, "B", "conflict"],
    ["both deleted", "A", undefined, undefined, "unchanged"],
    // first sync or path new since base (b undefined)
    ["new on source only", undefined, "A", undefined, "add"],
    ["new on target only", undefined, undefined, "A", "unchanged"],
    ["new on both, same digest", undefined, "A", "A", "unchanged"],
    ["new on both, different digest", undefined, "A", "B", "conflict"],
  ];

  for (const [name, b, s, t, want] of cases) {
    it(`${name}: ${String(b)}/${String(s)}/${String(t)} -> ${want}`, () => {
      assert.equal(actionFor(b, s, t), want);
    });
  }

  it("path present only in base is not reported", () => {
    assert.deepEqual(planSync({ gone: "A" }, {}, {}).items, []);
  });

  it("add only happens when the target is untouched since base", () => {
    // target removed it since base and source still has the base version: never resurrected
    assert.equal(actionFor("A", "A", undefined), "unchanged");
    // source re-created it with new content after the target removed it: conflict
    assert.equal(actionFor("A", "B", undefined), "conflict");
  });
});

describe("planSync items", () => {
  it("sorts items by path and covers the union of both sides", () => {
    const plan = planSync(
      { "m.md": "1" },
      { "z.md": side("9"), "a.md": side("1"), "m.md": side("2") },
      { "a.md": side("1"), "q.md": side("5"), "m.md": side("1") },
    );
    assert.deepEqual(plan.items, [
      { path: "a.md", action: "unchanged" },
      { path: "m.md", action: "update" },
      { path: "q.md", action: "unchanged" },
      { path: "z.md", action: "add" },
    ]);
  });

  it("compares digests only, so mode or size differences alone stay unchanged", () => {
    const plan = planSync(
      { f: "A" },
      { f: { digest: "A", size: 1, mode: 0o600 } },
      { f: { digest: "A", size: 99, mode: 0o755 } },
    );
    assert.deepEqual(plan.items, [{ path: "f", action: "unchanged" }]);
  });

  it("first sync with an empty base mixes add, conflict and unchanged", () => {
    const plan = planSync(
      {},
      { "a": side("1"), "b": side("2"), "c": side("3") },
      { "b": side("2"), "c": side("X"), "d": side("4") },
    );
    assert.deepEqual(plan.items, [
      { path: "a", action: "add" },
      { path: "b", action: "unchanged" },
      { path: "c", action: "conflict" },
      { path: "d", action: "unchanged" },
    ]);
  });

  it("handles a path literally named __proto__ without touching prototypes", () => {
    const source = Object.fromEntries([["__proto__", side("A")]]);
    const plan = planSync({}, source, {});
    assert.deepEqual(plan.items, [{ path: "__proto__", action: "add" }]);
    assert.equal(({} as Record<string, unknown>)["digest"], undefined);
  });

  it("does not mutate its inputs", () => {
    const base = { a: "1" };
    const source = { a: side("2") };
    const target = { a: side("1") };
    const snapshot = JSON.stringify([base, source, target]);
    planSync(base, source, target);
    assert.equal(JSON.stringify([base, source, target]), snapshot);
  });

  it("mirrors the reverse direction: update one way is unchanged the other", () => {
    const base = { f: "A" };
    const local = { f: side("B") };
    const remote = { f: side("A") };
    assert.equal(planSync(base, local, remote).items[0]?.action, "update");
    assert.equal(planSync(base, remote, local).items[0]?.action, "unchanged");
  });
});
