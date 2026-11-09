import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { detectSecrets } from "../src/secrets.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const scan = (s: string): string[] => detectSecrets(enc(s));

// Fixtures are assembled at runtime so no secret-looking literal sits in the repo.
const a = (n: number): string => "a1B2".repeat(Math.ceil(n / 4)).slice(0, n);
const GITHUB = "ghp_" + a(36);
const GITHUB_PAT = "github_pat_" + a(40);
const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
const SLACK = "xoxb-" + "1234567890-" + a(24);
const OPENAI = "sk-" + a(48);
const OPENAI_PROJ = "sk-proj-" + a(60);
const ANTHROPIC = "sk-ant-" + "api03-" + a(60);
const PEM = "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END " + "RSA PRIVATE KEY-----\n";

test("detects well-known token formats with stable labels", () => {
  const cases: [string, string][] = [
    [`token ${GITHUB}`, "github-token"],
    [`GH=${GITHUB_PAT}`, "github-token"],
    [PEM, "private-key"],
    ["-----BEGIN " + "OPENSSH PRIVATE KEY-----", "private-key"],
    ["-----BEGIN " + "PGP PRIVATE KEY BLOCK-----", "private-key"],
    [`aws_access_key_id = ${AWS}`, "aws-access-key"],
    [`SLACK=${SLACK}`, "slack-token"],
    [`key: ${OPENAI}`, "openai-key"],
    [`key: ${OPENAI_PROJ}`, "openai-key"],
    [`key: ${ANTHROPIC}`, "anthropic-key"],
    [`"Authorization": "Bearer ${a(40)}"`, "bearer-token"],
  ];
  for (const [text, label] of cases) {
    assert.ok(scan(text).includes(label), `${label} in ${text.slice(0, 30)}`);
  }
});

test("detects generic secret assignments in json, env and code styles", () => {
  const cases = [
    `{"apiKey": "${a(24)}"}`,
    `{"client_secret": "hunter2hunter2"}`,
    `password = 'hunter2hunter2'`,
    `AUTH_TOKEN=${a(32)}`,
    `secret_key: ${a(32)}`,
    `export const passphrase = "correct-horse-battery";`,
  ];
  for (const text of cases) {
    assert.ok(scan(text).includes("generic-secret-assignment"), text);
  }
});

test("returns [] for clean text, code, prose and settings", () => {
  const clean = [
    "",
    "# Notes\nNothing to see here.\n",
    '{"defaultModel": "claude-sonnet", "maxTokens": 4096, "tokenizer": "some-long-tokenizer-name"}',
    "const token = tokenizer;\nconst apiKey = settings.apiKey;\nconst password = getPassword();",
    "credentials: 'same-origin'",
    "password: required",
    `{"apiKey": "OPENAI_API_KEY"}`,
    `{"apiKey": "$OPENAI_API_KEY"}`,
    `{"apiKey": "!op read secret"}`,
    `{"apiKey": "your-api-key-here"}`,
    `{"token": "<token>"}`,
    `{"token": "\${TOKEN_VALUE_HERE}"}`,
    `token: ./path/to/some/file/here`,
    `password: "https://example.org/reset"`,
    "Bearer authentication-scheme-description-text",
    "the task-runner key is risk-assessment-and-mitigation-plan-for-q3",
    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
  ];
  for (const text of clean) assert.deepEqual(scan(text), [], text.slice(0, 50));
});

test("returns [] for binary input with no token-like content", () => {
  assert.deepEqual(detectSecrets(new Uint8Array([0, 1, 2, 255, 254])), []);
  assert.deepEqual(detectSecrets(new Uint8Array(randomBytes(4096).map((b) => b & 0x7f || 1))), []);
});

test("a token is found when NUL bytes surround or pad it", () => {
  const padded = new Uint8Array([0, ...enc(GITHUB), 0]);
  assert.ok(detectSecrets(padded).includes("github-token"));
  const spread = new Uint8Array([...enc(GITHUB)].flatMap((b) => [b, 0]));
  assert.ok(detectSecrets(spread).includes("github-token"), "UTF-16LE without a BOM");
  const bom = new Uint8Array([0xff, 0xfe, ...spread]);
  assert.ok(detectSecrets(bom).includes("github-token"), "UTF-16LE with a BOM");
});

test("a token hidden behind JSON unicode escapes is still found", () => {
  const escaped = [...GITHUB].map((c, i) => (i < 3 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c)).join("");
  assert.ok(!escaped.includes("ghp_"), "fixture must hide the literal prefix");
  assert.ok(scan(`{"note": "${escaped}"}`).includes("github-token"));
  assert.ok(scan(`{"\\u0061piKey": "${a(24)}"}`).includes("generic-secret-assignment"));
  assert.deepEqual(scan('{"theme": "\\u0064ark"}'), []);
});

test("detects the newer provider and credential formats", () => {
  const cases: [string, string][] = [
    ["sk-or-v1-" + "ab12".repeat(16), "openrouter-key"],
    ["gsk_" + a(52), "groq-key"],
    ["hf_" + a(36), "huggingface-token"],
    ["GOCSPX-" + a(28), "google-oauth-secret"],
    ["eyJhbGciOiJIUzI1" + ".eyJzdWIiOiIxMjM0" + ".SflKxwRJSMeKKF2QT4", "jwt"],
    ["postgres://admin:s3cretpw@db.internal:5432/app", "url-password"],
  ];
  for (const [text, label] of cases) assert.ok(scan(text).includes(label), label);
});

test("a URL without embedded credentials is not a secret", () => {
  for (const text of ["https://example.com/a/b", "http://localhost:3000/x", "git@github.com:me/repo.git", "https://user@host.test/path"]) {
    assert.deepEqual(scan(text), [], text);
  }
});

test("still scans text that is not valid UTF-8", () => {
  const prefix = enc("\u00e9 ");
  const bad = new Uint8Array([0xff, 0xfe, ...prefix, ...enc(GITHUB)]);
  assert.ok(detectSecrets(bad).includes("github-token"));
});

test("never echoes the secret in its result", () => {
  const secrets = [GITHUB, GITHUB_PAT, AWS, SLACK, OPENAI, OPENAI_PROJ, ANTHROPIC, a(24), "hunter2hunter2", a(40)];
  const text = [
    `a=${GITHUB}`,
    `b=${GITHUB_PAT}`,
    AWS,
    SLACK,
    OPENAI,
    OPENAI_PROJ,
    ANTHROPIC,
    PEM,
    `{"apiKey": "${a(24)}"}`,
    `password = 'hunter2hunter2'`,
    `Authorization: Bearer ${a(40)}`,
  ].join("\n");
  const labels = detectSecrets(enc(text));
  assert.ok(labels.length >= 8);
  const joined = JSON.stringify(labels);
  for (const s of secrets) assert.ok(!joined.includes(s), "secret leaked into result");
  for (const label of labels) assert.match(label, /^[a-z]+(-[a-z]+)*$/);
  assert.equal(new Set(labels).size, labels.length, "labels are unique");
});

test("scans 1 MiB inputs quickly, including pathological ones", () => {
  const MiB = 1024 * 1024;
  const fill = (unit: string): string => unit.repeat(Math.ceil(MiB / unit.length)).slice(0, MiB);
  const inputs: Record<string, string> = {
    "plain prose": fill("The quick brown fox jumps over the lazy dog. "),
    "one long run": "a".repeat(MiB),
    "token= then long value": "token=" + "a1".repeat(MiB / 2 - 3),
    "quoted key, unterminated value": `"password": "` + "x".repeat(MiB - 20),
    "repeated keyword": fill("token"),
    "repeated keyword and spaces": fill("secret        "),
    "repeated assignment head": fill(`api_key = "`),
    "repeated key head": fill("password:\t\t\t\t\t\t\t\t"),
    "repeated pem head": fill("-----BEGIN A B C D E F G H "),
    "repeated github prefix": fill("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    "repeated openai prefix": fill("sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
    "repeated aws prefix": fill("AKIAAAAAAAAAAAAAAAA"),
    "repeated bearer": fill("Bearer aaaaaaaaaaaaaaaaaaa "),
    "long bearer run": "Bearer " + "a".repeat(MiB - 7),
    "slack prefix": fill("xoxb-aaaaaaaaa"),
  };
  for (const [name, text] of Object.entries(inputs)) {
    const bytes = enc(text);
    const start = performance.now();
    detectSecrets(bytes);
    const ms = performance.now() - start;
    assert.ok(ms < 2000, `${name} took ${ms.toFixed(0)} ms`);
  }
});

test("flags base64 PEM keys, docker auth and netrc passwords", () => {
  const b64Pem = Buffer.from(PEM).toString("base64");
  assert.deepEqual(scan(`users:\n- name: u\n  user:\n    client-key-data: ${b64Pem}\n`).includes("private-key"), true);
  const auth = Buffer.from("alice:s3cretPassw0rd").toString("base64");
  assert.ok(scan(`{"auths":{"ghcr.io":{"auth":"${auth}"}}}`).includes("basic-auth"));
  assert.ok(scan("machine api.example.com\n  login alice\n  password hunter2hunter2\n").includes("netrc-password"));
  assert.ok(scan("machine api.example.com login alice password hunter2\n").includes("netrc-password"));
  for (const label of scan(`{"auth":"${auth}"}`)) assert.equal(label.includes("alice"), false);
});

test("an auth field that is not base64 user:password is left alone", () => {
  assert.deepEqual(scan('{"auth":"required"}'), []);
  assert.deepEqual(scan('{"auth":"oauth2-pkce-flow"}'), []);
  assert.deepEqual(scan("Set a password in the machine settings.\n"), []);
});
