// Every quantifier is bounded or a single char class, so 1 MiB inputs scan in linear time.

interface Rule {
  label: string;
  re: RegExp;
}

const PREFIXED_RULES: readonly Rule[] = [
  { label: "github-token", re: /gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255}/ },
  { label: "private-key", re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/ },
  { label: "aws-access-key", re: /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/ },
  { label: "slack-token", re: /xox[abeoprs]-[A-Za-z0-9-]{10,200}|xapp-[0-9]-[A-Za-z0-9-]{10,200}/ },
  {
    label: "openai-key",
    re: /(?<![A-Za-z0-9_-])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{32,}|[A-Za-z0-9]{32,})/,
  },
  { label: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{32,}/ },
  { label: "google-api-key", re: /AIza[A-Za-z0-9_-]{35}/ },
  { label: "stripe-key", re: /[sr]k_live_[A-Za-z0-9]{24,}/ },
  { label: "npm-token", re: /npm_[A-Za-z0-9]{36}/ },
  { label: "openrouter-key", re: /sk-or-v1-[A-Fa-f0-9]{32,}/ },
  { label: "groq-key", re: /(?<![A-Za-z0-9_])gsk_[A-Za-z0-9]{40,}/ },
  { label: "huggingface-token", re: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{34,}/ },
  { label: "google-oauth-secret", re: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
  { label: "jwt", re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { label: "url-password", re: /[a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/]{1,100}:[^\s:@/]{3,100}@[^\s/]{1,200}/i },
];

// The keyword must end the key name, so `maxTokens` and `tokenizer` do not match.
const KEY = "(?:api[_-]?key|secret(?:[_-]?key)?|token|passw(?:or)?d|passphrase|(?:private|access|auth)[_-]?key)";
const QUOTED = new RegExp(`${KEY}["']?[ \\t]{0,8}[:=][ \\t]{0,8}(["'\`])([^"'\`\\s]{8,200})\\1`, "gi");
const UNQUOTED = new RegExp(
  `${KEY}[ \\t]{0,8}[:=][ \\t]{0,8}([A-Za-z0-9_\\-+/=.~@#%^&*!:]{16,200})(?![A-Za-z0-9_\\-+/=.~@#%^&*!:(])`,
  "gi",
);
const BEARER = /bearer[ \t]+([A-Za-z0-9._~+/=-]{20,300})/gi;

const PLACEHOLDER = /your|example|placeholder|changeme|change-me|redacted|dummy|sample|insert|replace|todo|xxxx|\*{4}|[<>]|\$\{|\{\{|process\.env|env\./i;
// `$VAR`, `%VAR%` and Pi's `!command` values reference a secret instead of holding one.
const REFERENCE = /^[$%!]/;
const ENV_VAR_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const PATH_OR_URL = /^(?:\.{0,2}\/|~\/|[a-z][a-z0-9+.-]*:\/\/)/i;
const REPEATED = /^(.)\1+$/;

function isRealValue(value: string): boolean {
  return !(
    PLACEHOLDER.test(value) ||
    REFERENCE.test(value) ||
    ENV_VAR_NAME.test(value) ||
    PATH_OR_URL.test(value) ||
    REPEATED.test(value)
  );
}

const hasDigit = (s: string): boolean => /[0-9]/.test(s);
const hasLetter = (s: string): boolean => /[A-Za-z]/.test(s);

function anyMatch(text: string, re: RegExp, accept: (value: string) => boolean): boolean {
  for (const m of text.matchAll(re)) {
    const value = m[m.length - 1];
    if (value !== undefined && isRealValue(value) && accept(value)) return true;
  }
  return false;
}

// A JSON file can hide a token behind escapes (`"\u0067hp_..."`) that the raw text never shows.
function decodedJson(text: string): string | undefined {
  const head = text.trimStart().replace(/^\ufeff/, "").trimStart();
  if (!head.startsWith("{") && !head.startsWith("[")) return undefined;
  try {
    return JSON.stringify(JSON.parse(head));
  } catch {
    return undefined;
  }
}

function scanText(text: string, labels: Set<string>): void {
  for (const rule of PREFIXED_RULES) if (rule.re.test(text)) labels.add(rule.label);
  // Short or digit-free quoted values are usually words, so they need more length to count.
  if (anyMatch(text, BEARER, (v) => hasDigit(v) && hasLetter(v))) labels.add("bearer-token");
  const generic =
    anyMatch(text, QUOTED, (v) => hasDigit(v) || v.length >= 16) ||
    anyMatch(text, UNQUOTED, (v) => hasDigit(v) && hasLetter(v));
  if (generic) labels.add("generic-secret-assignment");
}

/** Labels only; never the matched text. [] for clean input. */
export function detectSecrets(bytes: Uint8Array): string[] {
  // NULs are dropped, not treated as "binary", so UTF-16 text and a token padded with NULs are still seen.
  const view = bytes.includes(0) ? bytes.filter((b) => b !== 0) : bytes;
  const text = new TextDecoder("utf-8").decode(view);
  const labels = new Set<string>();
  scanText(text, labels);
  const decoded = decodedJson(text);
  if (decoded !== undefined && decoded !== text) scanText(decoded, labels);
  return [...labels];
}
