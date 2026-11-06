import { GistSyncError } from "./types.ts";
import type { GistClient, GistSnapshot } from "./types.ts";

export interface GistClientOptions {
  token: string;
  /** Default https://api.github.com */
  baseUrl?: string;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Retries GET and PATCH on 5xx and network errors only; a POST is never retried. Default 2. */
  maxRetries?: number;
  /** Largest raw gist file the client will buffer. Default 64 MiB. */
  maxRawBytes?: number;
}

const DEFAULT_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_GIST_FILES = 300;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const RAW_FETCH_CONCURRENCY = 4;
const RETRY_BASE_DELAY_MS = 200;
const DEFAULT_MAX_RAW_BYTES = 64 * 1024 * 1024;
// Raw gist content is served here; it is the only non-API host that may see the token.
const RAW_HOST = "gist.githubusercontent.com";
const TOKEN_ENV_VARS = ["PI_GIST_SYNC_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;

export async function resolveToken(
  env: NodeJS.ProcessEnv,
  ghAuthToken: () => Promise<string | undefined>,
): Promise<string> {
  for (const name of TOKEN_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  let fromGh: string | undefined;
  try {
    fromGh = (await ghAuthToken())?.trim();
  } catch {
    // A missing or failing gh CLI just means there is no token from that source.
    fromGh = undefined;
  }
  if (fromGh) return fromGh;
  throw new GistSyncError(
    "NO_TOKEN",
    "No GitHub token found. Set PI_GIST_SYNC_TOKEN (or GH_TOKEN or GITHUB_TOKEN) to a token with the `gist` scope, " +
      "or sign in with `gh auth login` and run `gh auth refresh -s gist`.",
  );
}

export function createGistClient(opts: GistClientOptions): GistClient {
  const token = opts.token;
  const doFetch = opts.fetch ?? fetch;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiUrl = parseHttpUrl(baseUrl);
  if (!apiUrl) throw new GistSyncError("API", "The GitHub API base URL is not a valid http(s) URL.");
  const apiOrigin = apiUrl.origin;
  const userAgent = opts.userAgent ?? "pi-gist-sync";
  const maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? 2));
  const maxRawBytes = opts.maxRawBytes ?? DEFAULT_MAX_RAW_BYTES;
  // A bad character would make fetch throw an error that quotes the header value.
  const tokenIsValid = /^[\x21-\x7e]+$/.test(token);

  // Every message and thrown error passes through here so the token cannot leak.
  function redact(text: string): string {
    let out = text.replace(/Bearer\s+\S+/gi, "Bearer ***");
    if (token) out = out.split(token).join("***");
    return out;
  }

  function fail(code: ConstructorParameters<typeof GistSyncError>[0], message: string): GistSyncError {
    return new GistSyncError(code, redact(message));
  }

  function isTrustedForToken(url: URL): boolean {
    if (url.origin === apiOrigin) return true;
    return url.protocol === "https:" && url.hostname === RAW_HOST;
  }

  function headersFor(url: URL, hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "User-Agent": userAgent,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
    };
    if (isTrustedForToken(url)) headers.Authorization = `Bearer ${token}`;
    if (hasBody) headers["Content-Type"] = "application/json";
    return headers;
  }

  async function discard(res: Response): Promise<void> {
    try {
      await res.body?.cancel();
    } catch {
      // Body already consumed or closed; nothing to free.
    }
  }

  // One logical request: follows GET redirects by hand so the token is re-checked on every hop.
  async function send(method: string, startUrl: URL, body?: string): Promise<Response> {
    let url = startUrl;
    for (let hop = 0; ; hop++) {
      const res = await doFetch(url.toString(), {
        method,
        headers: headersFor(url, body !== undefined),
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const isRedirect = [301, 302, 303, 307, 308].includes(res.status);
      const location = res.headers.get("location");
      if (!isRedirect || method !== "GET" || !location || hop >= MAX_REDIRECTS) return res;
      const next = parseHttpUrl(location, url);
      if (!next) return res;
      await discard(res);
      url = next;
    }
  }

  async function request(method: string, rawUrl: string, body?: string): Promise<Response> {
    if (!tokenIsValid) {
      throw fail("AUTH", "The GitHub token is empty or contains whitespace or non-ASCII characters.");
    }
    const url = parseHttpUrl(rawUrl);
    if (!url) throw fail("API", "GitHub returned an invalid or unsupported URL.");
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      let networkError: unknown;
      try {
        res = await send(method, url, body);
      } catch (err) {
        networkError = err;
      }
      if (res && res.status < 500) return res;
      // A retried create could leave a duplicate gist behind when the first attempt did land.
      if (attempt >= (method === "POST" ? 0 : maxRetries)) {
        if (res) return res;
        throw fail("API", `Could not reach GitHub: ${describeNetworkError(networkError)}`);
      }
      if (res) await discard(res);
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }

  async function failureFor(res: Response, subject: string): Promise<GistSyncError> {
    const detail = await errorDetail(res);
    const suffix = detail ? `: ${detail}` : "";
    const { status } = res;
    if (status === 401) {
      return fail("AUTH", "GitHub rejected the token (HTTP 401). Check that it is valid and has the `gist` scope.");
    }
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retryAfter = res.headers.get("retry-after");
    if (status === 429 || (status === 403 && (remaining === "0" || retryAfter !== null))) {
      return fail("RATE_LIMIT", `GitHub rate limit reached. ${retryHint(res.headers)}`);
    }
    if (status === 403) {
      return fail("AUTH", `GitHub denied access (HTTP 403${suffix}). The token needs the \`gist\` scope.`);
    }
    if (status === 404) {
      return fail("NOT_FOUND", `${subject} not found (HTTP 404). Check the id and that the token's account can see it.`);
    }
    if (status === 422) return fail("API", `GitHub rejected the request (HTTP 422)${suffix}`);
    return fail("API", `GitHub API error (HTTP ${status})${suffix}`);
  }

  async function errorDetail(res: Response): Promise<string> {
    let text = "";
    try {
      text = await res.text();
    } catch {
      return "";
    }
    try {
      const json: unknown = JSON.parse(text);
      if (!isRecord(json)) return "";
      const parts: string[] = [];
      if (typeof json.message === "string") parts.push(json.message);
      if (Array.isArray(json.errors)) {
        for (const item of json.errors) {
          const line = describeApiError(item);
          if (line) parts.push(line);
        }
      }
      return redact(parts.join("; ").slice(0, 300));
    } catch {
      // Non-JSON bodies (proxy error pages) are noise; the status code is enough.
      return "";
    }
  }

  async function fetchRaw(rawUrl: string): Promise<string> {
    const res = await request("GET", rawUrl);
    if (!res.ok) throw await failureFor(res, "Gist file");
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxRawBytes) throw tooBig();
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    for (;;) {
      const next = await reader?.read();
      if (!next || next.done) break;
      total += next.value.length;
      if (total > maxRawBytes) {
        await reader?.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(next.value);
    }
    // ignoreBOM keeps a leading BOM, which Response.text() would drop and break digests.
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(Buffer.concat(chunks));
  }

  function tooBig(): GistSyncError {
    return fail("API", `A gist file is larger than the ${maxRawBytes} byte limit, so it was not downloaded.`);
  }

  async function snapshotFrom(res: Response): Promise<GistSnapshot> {
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw fail("API", "GitHub returned a response that is not valid JSON.");
    }
    if (!isRecord(json) || typeof json.id !== "string" || !isRecord(json.files)) {
      throw fail("API", "GitHub returned an unexpected gist payload.");
    }
    const entries: Array<[string, string]> = [];
    const pending: Array<{ name: string; rawUrl: string }> = [];
    for (const [name, file] of Object.entries(json.files)) {
      if (!isRecord(file)) continue;
      if (typeof file.content === "string" && file.truncated !== true) {
        entries.push([name, file.content]);
      } else if (typeof file.raw_url === "string") {
        pending.push({ name, rawUrl: file.raw_url });
      } else {
        throw fail("API", "GitHub returned a truncated file without a raw_url.");
      }
    }
    await runPool(pending, RAW_FETCH_CONCURRENCY, async (item) => {
      entries.push([item.name, await fetchRaw(item.rawUrl)]);
    });
    const snapshot: GistSnapshot = {
      id: json.id,
      htmlUrl: typeof json.html_url === "string" ? json.html_url : "",
      updatedAt: typeof json.updated_at === "string" ? json.updated_at : "",
      // fromEntries defines own properties, so a file named __proto__ survives.
      files: Object.fromEntries(entries),
    };
    if (isRecord(json.owner) && typeof json.owner.login === "string") snapshot.owner = json.owner.login;
    if (typeof json.public === "boolean") snapshot.public = json.public;
    return snapshot;
  }

  function gistPath(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw fail("NOT_FOUND", "That is not a valid gist id.");
    return `${baseUrl}/gists/${id}`;
  }

  async function call(method: string, url: string, subject: string, payload?: unknown): Promise<GistSnapshot> {
    const res = await request(method, url, payload === undefined ? undefined : JSON.stringify(payload));
    if (!res.ok) throw await failureFor(res, subject);
    return snapshotFrom(res);
  }

  return {
    async viewer() {
      const res = await request("GET", `${baseUrl}/user`);
      // A token without profile access still works for gists; the caller then treats the owner as unknown.
      if (res.status === 403 || res.status === 404) {
        await discard(res);
        return undefined;
      }
      if (!res.ok) throw await failureFor(res, "Account");
      try {
        const json: unknown = await res.json();
        return isRecord(json) && typeof json.login === "string" ? json.login : undefined;
      } catch {
        return undefined;
      }
    },
    async create(description, files) {
      assertFileCount(Object.keys(files).length);
      const body = {
        description,
        public: false,
        files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { content }])),
      };
      return call("POST", `${baseUrl}/gists`, "Gist", body);
    },
    async get(id) {
      return call("GET", gistPath(id), `Gist ${id}`);
    },
    async update(id, changes) {
      // Only the written files are knowable here; GitHub enforces the total for the rest.
      assertFileCount(Object.values(changes).filter((value) => value !== null).length);
      const files = Object.fromEntries(
        Object.entries(changes).map(([name, content]) => [name, content === null ? null : { content }]),
      );
      return call("PATCH", gistPath(id), `Gist ${id}`, { files });
    },
  };
}

function assertFileCount(count: number): void {
  if (count > MAX_GIST_FILES) {
    throw new GistSyncError(
      "TOO_MANY_FILES",
      `A gist holds at most ${MAX_GIST_FILES} files but this sync has ${count}. ` +
        'Narrow "include" or add "exclude" globs in gist-sync.json.',
    );
  }
}

function retryHint(headers: Headers): string {
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (headers.get("x-ratelimit-reset") && Number.isFinite(reset)) {
    return `Resets at ${new Date(reset * 1000).toISOString()}.`;
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter) return `Retry in ${retryAfter}s.`;
  return "Try again later.";
}

function describeApiError(item: unknown): string {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return "";
  if (typeof item.message === "string") return item.message;
  return [item.resource, item.field, item.code].filter((part) => typeof part === "string").join(" ");
}

function describeNetworkError(err: unknown): string {
  const e = err as { message?: unknown; cause?: { code?: unknown } } | undefined;
  const message = typeof e?.message === "string" ? e.message : "unknown error";
  const code = typeof e?.cause?.code === "string" ? ` (${e.cause.code})` : "";
  return message + code;
}

function parseHttpUrl(text: string, base?: URL): URL | undefined {
  try {
    const url = new URL(text, base);
    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++] as T;
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
