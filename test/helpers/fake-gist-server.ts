import { randomBytes } from "node:crypto";
import http from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

export const FAKE_TOKEN = "test-token";
export const FAKE_USER = "fake-user";
export const FAKE_MAX_FILES = 300;
// GitHub omits content from listings above this size and points at raw_url instead.
export const FAKE_TRUNCATE_BYTES = 1024 * 1024;

export interface FakeGist {
  id: string;
  description: string;
  public: boolean;
  /** Login reported as owner; defaults to FAKE_USER. */
  owner?: string;
  updatedAt: string;
  /** name -> full content; the server renders truncation on the way out. */
  files: Record<string, string>;
}

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeGistServer {
  baseUrl: string;
  close(): Promise<void>;
  gists: Map<string, FakeGist>;
  requests: RecordedRequest[];
  /** Queues one injected failure for the next request (any route). Calls stack in order. */
  failNext(status: number, headers?: Record<string, string>): void;
}

interface Injected {
  status: number;
  headers: Record<string, string>;
}

interface Validation {
  message: string;
}

export async function startFakeGist(): Promise<FakeGistServer> {
  const gists = new Map<string, FakeGist>();
  const requests: RecordedRequest[] = [];
  const injected: Injected[] = [];
  let baseUrl = "";

  function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body));
  }

  function invalid(res: http.ServerResponse, problem: Validation) {
    sendJson(res, 422, {
      message: "Validation Failed",
      errors: [{ resource: "Gist", field: "files", code: "invalid", message: problem.message }],
    });
  }

  function render(gist: FakeGist) {
    const files: Record<string, unknown> = {};
    for (const [name, content] of Object.entries(gist.files)) {
      const size = Buffer.byteLength(content);
      const truncated = size > FAKE_TRUNCATE_BYTES;
      files[name] = {
        filename: name,
        type: "text/plain",
        language: null,
        raw_url: `${baseUrl}/raw/${gist.id}/${encodeURIComponent(name)}`,
        size,
        truncated,
        ...(truncated ? {} : { content }),
      };
    }
    return {
      id: gist.id,
      html_url: `https://gist.github.com/${gist.id}`,
      description: gist.description,
      public: gist.public,
      owner: { login: gist.owner ?? FAKE_USER },
      updated_at: gist.updatedAt,
      files,
    };
  }

  function checkWrite(name: string, content: unknown): Validation | undefined {
    if (name === "" || name.includes("/")) return { message: `Invalid file name "${name}"` };
    if (typeof content !== "string") return { message: `File "${name}" is missing content` };
    if (content.trim() === "") return { message: `File "${name}" content cannot be empty` };
    return undefined;
  }

  function handleCreate(res: http.ServerResponse, raw: string) {
    const body = parseObject(raw);
    if (!body) return sendJson(res, 400, { message: "Problems parsing JSON" });
    const incoming = isObject(body.files) ? body.files : {};
    const names = Object.keys(incoming);
    if (names.length === 0) return invalid(res, { message: "Gist files are required" });
    if (names.length > FAKE_MAX_FILES) return invalid(res, { message: `A gist holds at most ${FAKE_MAX_FILES} files` });
    const files: Record<string, string> = {};
    for (const name of names) {
      const file = incoming[name];
      const content = isObject(file) ? file.content : undefined;
      const problem = checkWrite(name, content);
      if (problem) return invalid(res, problem);
      files[name] = content as string;
    }
    const gist: FakeGist = {
      id: randomBytes(16).toString("hex"),
      description: typeof body.description === "string" ? body.description : "",
      public: body.public === true,
      updatedAt: new Date().toISOString(),
      files,
    };
    gists.set(gist.id, gist);
    sendJson(res, 201, render(gist));
  }

  function handleUpdate(res: http.ServerResponse, gist: FakeGist, raw: string) {
    const body = parseObject(raw);
    if (!body) return sendJson(res, 400, { message: "Problems parsing JSON" });
    const next: Record<string, string> = { ...gist.files };
    const incoming = isObject(body.files) ? body.files : {};
    for (const [name, file] of Object.entries(incoming)) {
      if (file === null) {
        delete next[name];
        continue;
      }
      const content = isObject(file) ? file.content : undefined;
      if (content === undefined && name in next) continue;
      const problem = checkWrite(name, content);
      if (problem) return invalid(res, problem);
      next[name] = content as string;
    }
    const count = Object.keys(next).length;
    if (count === 0) return invalid(res, { message: "Gist files are required" });
    if (count > FAKE_MAX_FILES) return invalid(res, { message: `A gist holds at most ${FAKE_MAX_FILES} files` });
    gist.files = next;
    if (typeof body.description === "string") gist.description = body.description;
    gist.updatedAt = new Date().toISOString();
    sendJson(res, 200, render(gist));
  }

  function route(req: http.IncomingMessage, res: http.ServerResponse, raw: string) {
    const method = req.method ?? "GET";
    const { pathname } = new URL(req.url ?? "/", "http://fake.invalid");

    // Raw URLs are public for secret gists, so no token is required here.
    const rawMatch = /^\/raw\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (rawMatch && method === "GET") {
      const gist = gists.get(rawMatch[1] as string);
      const content = gist?.files[decodeURIComponent(rawMatch[2] as string)];
      if (content === undefined) return sendJson(res, 404, { message: "Not Found" });
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return void res.end(content);
    }

    if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
      return sendJson(res, 401, { message: "Bad credentials" });
    }
    if (pathname === "/user" && method === "GET") return sendJson(res, 200, { login: FAKE_USER });
    if (pathname === "/gists" && method === "POST") return handleCreate(res, raw);
    const match = /^\/gists\/([^/]+)$/.exec(pathname);
    if (match) {
      const gist = gists.get(match[1] as string);
      if (!gist) return sendJson(res, 404, { message: "Not Found" });
      if (method === "GET") return sendJson(res, 200, render(gist));
      if (method === "PATCH") return handleUpdate(res, gist, raw);
    }
    sendJson(res, 404, { message: "Not Found" });
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body: raw });
      const failure = injected.shift();
      if (failure) return sendJson(res, failure.status, { message: "Injected failure" }, failure.headers);
      route(req, res, raw);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    baseUrl,
    gists,
    requests,
    failNext(status, headers = {}) {
      injected.push({ status, headers });
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Keep-alive sockets from fetch would otherwise hold close() open.
        server.closeAllConnections();
      });
    },
  };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
