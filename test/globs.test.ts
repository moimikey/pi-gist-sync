import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, isCredentialPath } from "../src/config.ts";
import { matchesAny, matchGlob } from "../src/globs.ts";

test("literal globs match only the exact path", () => {
  assert.equal(matchGlob("settings.json", "settings.json"), true);
  assert.equal(matchGlob("settings.json", "xsettings.json"), false);
  assert.equal(matchGlob("settings.json", "settings.jsonx"), false);
  assert.equal(matchGlob("settings.json", "a/settings.json"), false);
});

test("regex metacharacters in a glob are literal", () => {
  assert.equal(matchGlob("a.b", "a.b"), true);
  assert.equal(matchGlob("a.b", "axb"), false);
  assert.equal(matchGlob("a+b(1)[x]^$|", "a+b(1)[x]^$|"), true);
});

test("* does not cross a slash", () => {
  assert.equal(matchGlob("*.json", "a.json"), true);
  assert.equal(matchGlob("*.json", "a/b.json"), false);
  assert.equal(matchGlob("a/*", "a/b"), true);
  assert.equal(matchGlob("a/*", "a/b/c"), false);
  assert.equal(matchGlob("*", "a/b"), false);
});

test("* matches the empty string and dotfiles", () => {
  assert.equal(matchGlob("*.json", ".json"), true);
  assert.equal(matchGlob("*.json", ".hidden.json"), true);
  assert.equal(matchGlob("a*b", "ab"), true);
  assert.equal(matchGlob("*", ".env"), true);
});

test("? matches exactly one non-slash character", () => {
  assert.equal(matchGlob("a?c", "abc"), true);
  assert.equal(matchGlob("a?c", "ac"), false);
  assert.equal(matchGlob("a?c", "a/c"), false);
  assert.equal(matchGlob("a?c", "abbc"), false);
});

test("**/ matches zero or more directories", () => {
  assert.equal(matchGlob("**/x.md", "x.md"), true);
  assert.equal(matchGlob("**/x.md", "a/x.md"), true);
  assert.equal(matchGlob("**/x.md", "a/b/c/x.md"), true);
  assert.equal(matchGlob("**/x.md", "a/bx.md"), false);
  assert.equal(matchGlob("a/**/b", "a/b"), true);
  assert.equal(matchGlob("a/**/b", "a/x/y/b"), true);
  assert.equal(matchGlob("a/**/b", "ab"), false);
});

test("trailing /** matches everything below, at any depth", () => {
  assert.equal(matchGlob("sessions/**", "sessions/a"), true);
  assert.equal(matchGlob("sessions/**", "sessions/a/b/c.json"), true);
  assert.equal(matchGlob("sessions/**", "sessions"), false);
  assert.equal(matchGlob("sessions/**", "other/sessions/a"), false);
  assert.equal(matchGlob("**/node_modules/**", "node_modules/x"), true);
  assert.equal(matchGlob("**/node_modules/**", "a/b/node_modules/x/y"), true);
  assert.equal(matchGlob("**/node_modules/**", "a/node_modules"), false);
});

test("** glued to other text acts like *", () => {
  assert.equal(matchGlob("a**b", "axb"), true);
  assert.equal(matchGlob("a**b", "a/b"), false);
  assert.equal(matchGlob("**.md", "x.md"), true);
  assert.equal(matchGlob("**.md", "a/x.md"), false);
});

test("a bare ** matches any path", () => {
  assert.equal(matchGlob("**", "a"), true);
  assert.equal(matchGlob("**", "a/b/c"), true);
});

test("{a,b} alternation", () => {
  assert.equal(matchGlob("*.{json,md}", "a.json"), true);
  assert.equal(matchGlob("*.{json,md}", "a.md"), true);
  assert.equal(matchGlob("*.{json,md}", "a.txt"), false);
  assert.equal(matchGlob("{extensions,skills}/**", "skills/x/y"), true);
  assert.equal(matchGlob("{extensions,skills}/**", "prompts/x"), false);
  assert.equal(matchGlob("{a,b}", "a"), true);
  assert.equal(matchGlob("{a,b}", "ab"), false);
});

test("nested and empty alternatives", () => {
  assert.equal(matchGlob("x.{a,b{1,2}}", "x.b2"), true);
  assert.equal(matchGlob("x.{a,b{1,2}}", "x.b3"), false);
  assert.equal(matchGlob("x{,y}", "x"), true);
  assert.equal(matchGlob("x{,y}", "xy"), true);
  assert.equal(matchGlob("{a/**/,}z", "z"), true);
  assert.equal(matchGlob("{a/**/,}z", "a/q/z"), true);
});

test("unbalanced braces and stray commas are literal", () => {
  assert.equal(matchGlob("a{b", "a{b"), true);
  assert.equal(matchGlob("a}b", "a}b"), true);
  assert.equal(matchGlob("a,b", "a,b"), true);
  assert.equal(matchGlob("a{b,c", "a{b,c"), true);
});

test("backslash escapes a metacharacter", () => {
  assert.equal(matchGlob("a\\*b", "a*b"), true);
  assert.equal(matchGlob("a\\*b", "axb"), false);
  assert.equal(matchGlob("a\\{b,c\\}", "a{b,c}"), true);
});

test("matching is case-sensitive", () => {
  assert.equal(matchGlob("AGENTS.md", "agents.md"), false);
  assert.equal(matchGlob("AGENTS.md", "AGENTS.md"), true);
});

test("repeated **/ does not blow up the regex", () => {
  const glob = `${"**/".repeat(30)}x`;
  const miss = `${"a/".repeat(40)}y`;
  const start = Date.now();
  assert.equal(matchGlob(glob, miss), false);
  assert.equal(matchGlob(glob, "a/b/x"), true);
  assert.ok(Date.now() - start < 500);
});

test("newlines in a name are matched by * and **", () => {
  assert.equal(matchGlob("*.md", "a\nb.md"), true);
  assert.equal(matchGlob("sessions/**", "sessions/a\nb"), true);
});

test("matchesAny", () => {
  assert.equal(matchesAny([], "a"), false);
  assert.equal(matchesAny(["x", "*.md"], "a.md"), true);
  assert.equal(matchesAny(["x", "*.md"], "a.txt"), false);
});

test("default globs behave as the spec describes", () => {
  assert.equal(matchesAny(DEFAULT_INCLUDE, "settings.json"), true);
  assert.equal(matchesAny(DEFAULT_INCLUDE, "mcp-adapter.json"), true);
  assert.equal(matchesAny(DEFAULT_INCLUDE, "extensions/foo/index.ts"), true);
  assert.equal(matchesAny(DEFAULT_INCLUDE, "skills/a/SKILL.md"), true);
  assert.equal(matchesAny(DEFAULT_INCLUDE, "random/file.json"), false);

  assert.equal(matchesAny(DEFAULT_EXCLUDE, "sessions/a/b.json"), true);
  assert.equal(matchesAny(DEFAULT_EXCLUDE, "extensions/x/node_modules/y/z.js"), true);
  assert.equal(matchesAny(DEFAULT_EXCLUDE, ".DS_Store"), true);
  assert.equal(matchesAny(DEFAULT_EXCLUDE, "skills/a/.DS_Store"), true);
  assert.equal(matchesAny(DEFAULT_EXCLUDE, "settings.json.bak-2026"), true);
  assert.equal(matchesAny(DEFAULT_EXCLUDE, "update-cache.json"), true);
  assert.equal(matchesAny(DEFAULT_EXCLUDE, "skills/update-cache.json"), false);
  assert.equal(matchesAny(DEFAULT_EXCLUDE, "settings.json"), false);

  assert.equal(isCredentialPath("auth.json"), true);
  assert.equal(isCredentialPath("github-auth.json"), true);
  assert.equal(isCredentialPath("my-credentials-v2.json"), true);
  assert.equal(isCredentialPath("api-token.json"), true);
  assert.equal(isCredentialPath(".env"), true);
  assert.equal(isCredentialPath("extensions/x/.env"), true);
  assert.equal(isCredentialPath("extensions/x/.env.local"), true);
  assert.equal(isCredentialPath("settings.json"), false);
  // Nested credential files are credentials too: extensions keep tokens in their own dirs.
  assert.equal(isCredentialPath("skills/auth.json"), true);
});
