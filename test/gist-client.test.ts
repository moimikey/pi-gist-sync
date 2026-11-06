import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createGistClient, resolveToken } from "../src/gist-client.ts";
import type { GistClientOptions } from "../src/gist-client.ts";
import { GistSyncError } from "../src/types.ts";
import type { ErrorCode } from "../src/types.ts";
import { FAKE_TOKEN, FAKE_USER, startFakeGist } from "./helpers/fake-gist-server.ts";
import type { FakeGistServer } from "./helpers/fake-gist-server.ts";

const MIB = 1024 * 1024;

async function rejection(promise: Promise<unknown>): Promise<GistSyncError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof GistSyncError, `expected GistSyncError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the promise to reject");
}

function assertCode(err: GistSyncError, code: ErrorCode) {
  assert.equal(err.code, code, `${err.code}: ${err.message}`);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Scripted fetch: records each call and answers from a queue of handlers. */
function scriptedFetch(...handlers: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string>) },
    };
    calls.push(call);
    const handler = handlers[calls.length - 1] ?? handlers[handlers.length - 1];
    assert.ok(handler, "no handler");
    return handler(call);
  }) as typeof fetch;
  return { calls, fetch: impl };
}

function truncatedGist(rawUrl: string) {
  return {
    id: "abc123",
    html_url: "https://gist.github.com/abc123",
    updated_at: "2026-01-01T00:00:00Z",
    files: { "big.txt": { filename: "big.txt", truncated: true, raw_url: rawUrl, size: 2 * MIB } },
  };
}

describe("gist client against the fake server", () => {
  let server: FakeGistServer;

  const client = (extra: Partial<GistClientOptions> = {}) =>
    createGistClient({ token: FAKE_TOKEN, baseUrl: server.baseUrl, ...extra });

  beforeEach(async () => {
    server = await startFakeGist();
  });
  afterEach(async () => {
    await server.close();
  });

  describe("create / get / update", () => {
    it("creates a secret gist with the documented request shape", async () => {
      const snap = await client({ userAgent: "ua-test" }).create("my desc", {
        "a.txt": "alpha",
        "b%2Fc.json": "{}",
      });

      assert.equal(server.requests.length, 1);
      const req = server.requests[0]!;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/gists");
      assert.equal(req.headers.authorization, `Bearer ${FAKE_TOKEN}`);
      assert.equal(req.headers.accept, "application/vnd.github+json");
      assert.equal(req.headers["x-github-api-version"], "2022-11-28");
      assert.equal(req.headers["user-agent"], "ua-test");
      assert.deepEqual(JSON.parse(req.body), {
        description: "my desc",
        public: false,
        files: { "a.txt": { content: "alpha" }, "b%2Fc.json": { content: "{}" } },
      });

      assert.deepEqual(snap.files, { "a.txt": "alpha", "b%2Fc.json": "{}" });
      assert.match(snap.id, /^[0-9a-f]{32}$/);
      assert.equal(snap.htmlUrl, `https://gist.github.com/${snap.id}`);
      assert.ok(snap.updatedAt);
      const stored = server.gists.get(snap.id)!;
      assert.equal(stored.public, false);
      assert.equal(stored.description, "my desc");
    });

    it("gets a gist with full content and metadata", async () => {
      const created = await client().create("d", { "one.md": "# hi\n", "two.md": "line\n" });
      const snap = await client().get(created.id);

      assert.deepEqual(snap.files, { "one.md": "# hi\n", "two.md": "line\n" });
      assert.equal(snap.id, created.id);
      assert.equal(snap.updatedAt, server.gists.get(created.id)!.updatedAt);
      const req = server.requests.at(-1)!;
      assert.equal(req.method, "GET");
      assert.equal(req.url, `/gists/${created.id}`);
    });

    it("updates in a single PATCH: edit, add and delete (null)", async () => {
      const created = await client().create("d", { "keep.txt": "k", "edit.txt": "old", "gone.txt": "x" });
      server.requests.length = 0;

      const snap = await client().update(created.id, { "edit.txt": "new", "added.txt": "fresh", "gone.txt": null });

      assert.equal(server.requests.length, 1);
      const req = server.requests[0]!;
      assert.equal(req.method, "PATCH");
      assert.deepEqual(JSON.parse(req.body), {
        files: { "edit.txt": { content: "new" }, "added.txt": { content: "fresh" }, "gone.txt": null },
      });
      assert.deepEqual(snap.files, { "keep.txt": "k", "edit.txt": "new", "added.txt": "fresh" });
      assert.deepEqual(server.gists.get(created.id)!.files, snap.files);
    });

    it("round-trips unicode, percent-encoded names and whitespace-padded content", async () => {
      const files = { "caf%C3%A9.md": "héllo ✓ 日本\n", "a%2Fb.txt": "  padded  ", "%25.txt": "pct" };
      const created = await client().create("d", files);
      assert.deepEqual((await client().get(created.id)).files, files);
    });

    it("keeps a file literally named __proto__", async () => {
      const fetched = scriptedFetch(() =>
        jsonResponse(
          JSON.parse('{"id":"abc","files":{"__proto__":{"filename":"__proto__","content":"x","truncated":false}}}'),
        ),
      );
      const snap = await createGistClient({ token: FAKE_TOKEN, fetch: fetched.fetch }).get("abc");
      assert.deepEqual(Object.keys(snap.files), ["__proto__"]);
      assert.equal(Object.getOwnPropertyDescriptor(snap.files, "__proto__")?.value, "x");
    });

    it("tolerates a trailing slash on baseUrl", async () => {
      const created = await client({ baseUrl: `${server.baseUrl}///` }).create("d", { "a.txt": "a" });
      assert.ok(server.gists.has(created.id));
    });

    it("rejects a malformed gist id without sending a request", async () => {
      for (const id of ["", "../users", "a/b", "a b", "a?b"]) {
        assertCode(await rejection(client().get(id)), "NOT_FOUND");
        assertCode(await rejection(client().update(id, { "a.txt": "a" })), "NOT_FOUND");
      }
      assert.equal(server.requests.length, 0);
    });
  });

  describe("truncated files", () => {
    it("fetches truncated files from raw_url, keeping a leading BOM", async () => {
      const big = `\uFEFF${"x".repeat(MIB + 100)}`;
      const created = await client().create("d", { "small.txt": "s", "big.txt": big });
      // create already hydrated the response; start counting from a clean slate.
      server.requests.length = 0;

      const snap = await client().get(created.id);

      assert.equal(snap.files["big.txt"], big);
      assert.equal(snap.files["small.txt"], "s");
      assert.equal(server.requests.length, 2);
      assert.equal(server.requests[0]!.url, `/gists/${created.id}`);
      assert.equal(server.requests[1]!.url, `/raw/${created.id}/big.txt`);
    });

    it("also hydrates truncated files returned by create and update", async () => {
      const big = "y".repeat(MIB + 1);
      const created = await client().create("d", { "big.txt": big });
      assert.equal(created.files["big.txt"], big);
      const updated = await client().update(created.id, { "other.txt": "o" });
      assert.equal(updated.files["big.txt"], big);
    });

    it("sends the token to the raw URL on the API host", async () => {
      const created = await client().create("d", { "big.txt": "z".repeat(MIB + 1) });
      server.requests.length = 0;
      await client().get(created.id);
      const rawRequest = server.requests.find((r) => r.url.startsWith("/raw/"))!;
      assert.equal(rawRequest.headers.authorization, `Bearer ${FAKE_TOKEN}`);
    });

    it("encodes percent-escaped names in raw URLs", async () => {
      const name = "a%2Fb %25.txt";
      const big = "q".repeat(MIB + 1);
      const created = await client().create("d", { [name]: big });
      assert.equal(created.files[name], big);
    });

    it("maps a failing raw fetch through the error table", async () => {
      const rawUrl = "https://gist.githubusercontent.com/u/abc/raw/f";
      const gone = scriptedFetch(
        () => jsonResponse(truncatedGist(rawUrl)),
        () => jsonResponse({ message: "Not Found" }, { status: 404 }),
      );
      assertCode(await rejection(createGistClient({ token: "ghp_tok", fetch: gone.fetch }).get("abc123")), "NOT_FOUND");

      const flaky = scriptedFetch(
        () => jsonResponse(truncatedGist(rawUrl)),
        () => new Response("oops", { status: 502 }),
        () => new Response("recovered", { status: 200 }),
      );
      const snap = await createGistClient({ token: "ghp_tok", fetch: flaky.fetch }).get("abc123");
      assert.equal(snap.files["big.txt"], "recovered");
    });
  });

  describe("token handling for raw_url hosts", () => {
    const cases: Array<{ rawUrl: string; trusted: boolean }> = [
      { rawUrl: "https://api.github.com/raw/x", trusted: true },
      { rawUrl: "https://gist.githubusercontent.com/u/abc/raw/f", trusted: true },
      { rawUrl: "https://evil.example.com/raw/x", trusted: false },
      { rawUrl: "https://api.github.com.evil.example/raw/x", trusted: false },
      { rawUrl: "https://gist.githubusercontent.com.evil.example/raw/x", trusted: false },
      { rawUrl: "https://gist.githubusercontent.com@evil.example/raw/x", trusted: false },
      { rawUrl: "http://gist.githubusercontent.com/u/abc/raw/f", trusted: false },
      { rawUrl: "http://api.github.com/raw/x", trusted: false },
      { rawUrl: "https://api.github.com:8443/raw/x", trusted: false },
      { rawUrl: "https://raw.githubusercontent.com/u/abc/raw/f", trusted: false },
    ];

    for (const { rawUrl, trusted } of cases) {
      it(`${trusted ? "sends" : "withholds"} the token for ${rawUrl}`, async () => {
        const fetched = scriptedFetch(
          () => jsonResponse(truncatedGist(rawUrl)),
          () => new Response("full body", { status: 200 }),
        );
        const snap = await createGistClient({ token: "ghp_tok", fetch: fetched.fetch }).get("abc123");

        assert.equal(snap.files["big.txt"], "full body");
        assert.equal(fetched.calls.length, 2);
        assert.equal(fetched.calls[0]!.headers.Authorization, "Bearer ghp_tok");
        assert.equal(fetched.calls[1]!.url, new URL(rawUrl).toString());
        assert.equal(fetched.calls[1]!.headers.Authorization, trusted ? "Bearer ghp_tok" : undefined);
      });
    }

    it("re-checks the host on a redirect and drops the token for a foreign hop", async () => {
      const fetched = scriptedFetch(
        () => jsonResponse(truncatedGist("https://gist.githubusercontent.com/u/abc/raw/f")),
        () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/steal" } }),
        () => new Response("redirected body", { status: 200 }),
      );
      const snap = await createGistClient({ token: "ghp_tok", fetch: fetched.fetch }).get("abc123");

      assert.equal(snap.files["big.txt"], "redirected body");
      assert.equal(fetched.calls[1]!.headers.Authorization, "Bearer ghp_tok");
      assert.equal(fetched.calls[2]!.url, "https://evil.example.com/steal");
      assert.equal(fetched.calls[2]!.headers.Authorization, undefined);
    });

    it("never follows a redirect on a write", async () => {
      const fetched = scriptedFetch(
        () => new Response(null, { status: 307, headers: { location: "https://evil.example.com/steal" } }),
      );
      const err = await rejection(
        createGistClient({ token: "ghp_tok", fetch: fetched.fetch }).update("abc123", { "a.txt": "a" }),
      );
      assertCode(err, "API");
      assert.equal(fetched.calls.length, 1);
    });

    it("stops after too many redirects instead of looping", async () => {
      const fetched = scriptedFetch(
        () => jsonResponse(truncatedGist("https://gist.githubusercontent.com/u/abc/raw/f")),
        () => new Response(null, { status: 302, headers: { location: "https://gist.githubusercontent.com/loop" } }),
      );
      const err = await rejection(createGistClient({ token: "ghp_tok", fetch: fetched.fetch }).get("abc123"));
      assertCode(err, "API");
      assert.ok(fetched.calls.length <= 8);
    });

    it("rejects a raw_url with a non-http scheme", async () => {
      const fetched = scriptedFetch(() => jsonResponse(truncatedGist("file:///etc/passwd")));
      const err = await rejection(createGistClient({ token: "ghp_tok", fetch: fetched.fetch }).get("abc123"));
      assertCode(err, "API");
      assert.equal(fetched.calls.length, 1);
    });

    it("rejects a truncated file that has no raw_url", async () => {
      const payload = { id: "abc123", files: { "big.txt": { filename: "big.txt", truncated: true } } };
      const fetched = scriptedFetch(() => jsonResponse(payload));
      const err = await rejection(createGistClient({ token: "ghp_tok", fetch: fetched.fetch }).get("abc123"));
      assertCode(err, "API");
    });
  });

  describe("error mapping", () => {
    it("401 -> AUTH", async () => {
      const err = await rejection(client({ token: "wrong-token" }).get("deadbeef"));
      assertCode(err, "AUTH");
      assert.match(err.message, /gist/);
    });

    it("403 with x-ratelimit-remaining 0 -> RATE_LIMIT with the reset time", async () => {
      const reset = Math.floor(Date.UTC(2030, 0, 2, 3, 4, 5) / 1000);
      server.failNext(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) });
      const err = await rejection(client().get("deadbeef"));
      assertCode(err, "RATE_LIMIT");
      assert.match(err.message, /2030-01-02T03:04:05\.000Z/);
    });

    it("403 with retry-after (secondary limit) and 429 -> RATE_LIMIT", async () => {
      server.failNext(403, { "retry-after": "60" });
      const secondary = await rejection(client().get("deadbeef"));
      assertCode(secondary, "RATE_LIMIT");
      assert.match(secondary.message, /60s/);

      server.failNext(429);
      assertCode(await rejection(client().get("deadbeef")), "RATE_LIMIT");
    });

    it("403 without a rate limit -> AUTH mentioning the gist scope", async () => {
      server.failNext(403, { "x-ratelimit-remaining": "4999" });
      const err = await rejection(client().get("deadbeef"));
      assertCode(err, "AUTH");
      assert.match(err.message, /`gist` scope/);
    });

    it("404 -> NOT_FOUND", async () => {
      const err = await rejection(client().get("deadbeef"));
      assertCode(err, "NOT_FOUND");
      assert.match(err.message, /deadbeef/);
      assertCode(await rejection(client().update("deadbeef", { "a.txt": "a" })), "NOT_FOUND");
    });

    it("422 -> API carrying GitHub's message", async () => {
      const empty = await rejection(client().create("d", { "empty.txt": "" }));
      assertCode(empty, "API");
      assert.match(empty.message, /Validation Failed/);
      assert.match(empty.message, /empty\.txt/);

      const slash = await rejection(client().create("d", { "a/b.txt": "x" }));
      assertCode(slash, "API");
      assert.match(slash.message, /a\/b\.txt/);

      assertCode(await rejection(client().create("d", { "ws.txt": " \n\t " })), "API");
    });

    it("other statuses -> API", async () => {
      server.failNext(400);
      const err = await rejection(client({ maxRetries: 0 }).get("deadbeef"));
      assertCode(err, "API");
      assert.match(err.message, /400/);
    });

    it("GitHub's 300-file limit on update surfaces as API (client cannot know the total)", async () => {
      const files: Record<string, string> = {};
      for (let i = 0; i < 300; i++) files[`f${i}.txt`] = "x";
      const created = await client().create("d", files);
      const err = await rejection(client().update(created.id, { "one-more.txt": "x" }));
      assertCode(err, "API");
      assert.match(err.message, /300/);
    });

    it("non-JSON error bodies fall back to the status code", async () => {
      const fetched = scriptedFetch(() => new Response("<html>bad gateway</html>", { status: 418 }));
      const err = await rejection(createGistClient({ token: "ghp_tok", fetch: fetched.fetch, maxRetries: 0 }).get("abc"));
      assertCode(err, "API");
      assert.match(err.message, /418/);
      assert.doesNotMatch(err.message, /html/);
    });

    it("an invalid success payload -> API", async () => {
      const notJson = scriptedFetch(() => new Response("nope", { status: 200 }));
      assertCode(await rejection(createGistClient({ token: "ghp_tok", fetch: notJson.fetch }).get("abc")), "API");
      const noFiles = scriptedFetch(() => jsonResponse({ id: "abc" }));
      assertCode(await rejection(createGistClient({ token: "ghp_tok", fetch: noFiles.fetch }).get("abc")), "API");
    });
  });

  describe("retries", () => {
    it("retries 5xx and then succeeds", async () => {
      const created = await client().create("d", { "a.txt": "a" });
      server.requests.length = 0;
      server.failNext(502);
      server.failNext(503);

      const snap = await client().get(created.id);

      assert.deepEqual(snap.files, { "a.txt": "a" });
      assert.equal(server.requests.length, 3);
    });

    it("gives up after maxRetries (default 2) with the 5xx mapped to API", async () => {
      server.failNext(500);
      server.failNext(500);
      server.failNext(500);
      const err = await rejection(client().get("deadbeef"));
      assertCode(err, "API");
      assert.match(err.message, /500/);
      assert.equal(server.requests.length, 3);
    });

    it("honours maxRetries: 0 and a custom count", async () => {
      server.failNext(500);
      await rejection(client({ maxRetries: 0 }).get("deadbeef"));
      assert.equal(server.requests.length, 1);

      server.requests.length = 0;
      server.failNext(500);
      server.failNext(500);
      await rejection(client({ maxRetries: 1 }).get("deadbeef"));
      assert.equal(server.requests.length, 2);
    });

    it("never retries a create, because the first attempt may have landed", async () => {
      server.failNext(502);
      const err = await rejection(client().create("d", { "a.txt": "a" }));
      assertCode(err, "API");
      assert.equal(server.requests.length, 1);
      assert.equal(server.gists.size, 0);

      const down = scriptedFetch(() => {
        throw new TypeError("fetch failed");
      });
      await rejection(createGistClient({ token: "ghp_tok", fetch: down.fetch }).create("d", { "a.txt": "a" }));
      assert.equal(down.calls.length, 1);
    });

    it("still retries a PATCH, which is safe to repeat", async () => {
      const created = await client().create("d", { "a.txt": "a" });
      server.requests.length = 0;
      server.failNext(503);
      await client().update(created.id, { "a.txt": "b" });
      assert.equal(server.requests.length, 2);
    });

    it("does not retry 4xx", async () => {
      await rejection(client().get("deadbeef"));
      assert.equal(server.requests.length, 1);
      server.requests.length = 0;
      server.failNext(429);
      await rejection(client().get("deadbeef"));
      assert.equal(server.requests.length, 1);
    });

    it("retries network errors, then reports them as API", async () => {
      const flaky = scriptedFetch(
        () => {
          throw new TypeError("fetch failed");
        },
        () => jsonResponse({ id: "abc", files: {} }),
      );
      const snap = await createGistClient({ token: "ghp_tok", fetch: flaky.fetch }).get("abc");
      assert.equal(snap.id, "abc");
      assert.equal(flaky.calls.length, 2);

      const down = scriptedFetch(() => {
        throw new TypeError("fetch failed");
      });
      const err = await rejection(createGistClient({ token: "ghp_tok", fetch: down.fetch }).get("abc"));
      assertCode(err, "API");
      assert.match(err.message, /Could not reach GitHub/);
      assert.equal(down.calls.length, 3);
    });

    it("retries a real connection failure", async () => {
      const dead = await startFakeGist();
      const deadUrl = dead.baseUrl;
      await dead.close();
      const err = await rejection(
        createGistClient({ token: FAKE_TOKEN, baseUrl: deadUrl, maxRetries: 1 }).get("abc"),
      );
      assertCode(err, "API");
      assert.match(err.message, /Could not reach GitHub/);
    });
  });

  describe("owner, visibility and viewer", () => {
    it("reports the owner login and the public flag on a snapshot", async () => {
      const created = await client().create("d", { "a.txt": "a" });
      const snap = await client().get(created.id);
      assert.equal(snap.owner, FAKE_USER);
      assert.equal(snap.public, false);

      server.gists.get(created.id)!.public = true;
      server.gists.get(created.id)!.owner = "someone-else";
      const other = await client().get(created.id);
      assert.equal(other.owner, "someone-else");
      assert.equal(other.public, true);
    });

    it("leaves owner and public unset when the payload omits them", async () => {
      const bare = scriptedFetch(() => jsonResponse({ id: "abc", files: {} }));
      const snap = await createGistClient({ token: "ghp_tok", fetch: bare.fetch }).get("abc");
      assert.equal("owner" in snap, false);
      assert.equal("public" in snap, false);
    });

    it("viewer() returns the token's login", async () => {
      assert.equal(await client().viewer(), FAKE_USER);
      assert.equal(server.requests.at(-1)!.url, "/user");
    });

    it("viewer() is undefined when the token cannot read its profile, and errors on a bad token", async () => {
      for (const status of [403, 404]) {
        server.failNext(status);
        assert.equal(await client().viewer(), undefined, String(status));
      }
      assertCode(await rejection(createGistClient({ token: "wrong", baseUrl: server.baseUrl }).viewer()), "AUTH");
      const odd = scriptedFetch(() => jsonResponse({ nope: 1 }));
      assert.equal(await createGistClient({ token: "ghp_tok", fetch: odd.fetch }).viewer(), undefined);
    });
  });

  describe("raw file size cap", () => {
    const raw = "https://gist.githubusercontent.com/u/abc/raw/big.txt";

    it("rejects a raw file whose declared length exceeds the cap, without reading it", async () => {
      const f = scriptedFetch(
        () => jsonResponse(truncatedGist(raw)),
        () => new Response("x".repeat(10), { status: 200, headers: { "content-length": "5000" } }),
      );
      const err = await rejection(createGistClient({ token: "ghp_tok", fetch: f.fetch, maxRawBytes: 1000 }).get("abc"));
      assertCode(err, "API");
      assert.match(err.message, /larger than the 1000 byte limit/);
    });

    it("stops a stream that outgrows the cap even when it declares nothing", async () => {
      const big = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(400).fill(97));
        },
      });
      const f = scriptedFetch(() => jsonResponse(truncatedGist(raw)), () => new Response(big, { status: 200 }));
      const err = await rejection(createGistClient({ token: "ghp_tok", fetch: f.fetch, maxRawBytes: 1000 }).get("abc"));
      assertCode(err, "API");
    });

    it("keeps a leading BOM and multi-byte text for files under the cap", async () => {
      const f = scriptedFetch(() => jsonResponse(truncatedGist(raw)), () => new Response("\ufeffh\u00e9llo", { status: 200 }));
      const snap = await createGistClient({ token: "ghp_tok", fetch: f.fetch, maxRawBytes: 1000 }).get("abc");
      assert.equal(snap.files["big.txt"], "\ufeffh\u00e9llo");
    });
  });

  describe("token never leaks", () => {
    const SECRET = "ghp_SuperSecretTokenValue123";

    function assertClean(err: GistSyncError) {
      assert.ok(!err.message.includes(SECRET), `leaked in message: ${err.message}`);
      assert.ok(!String(err.stack).includes(SECRET), "leaked in stack");
      assert.equal(err.cause, undefined);
    }

    it("is absent from every mapped error, including a bad-token 401", async () => {
      assertClean(await rejection(createGistClient({ token: SECRET, baseUrl: server.baseUrl }).get("deadbeef")));
      for (const status of [403, 404, 422, 429, 500]) {
        server.failNext(status);
        assertClean(
          await rejection(createGistClient({ token: SECRET, baseUrl: server.baseUrl, maxRetries: 0 }).get("abc")),
        );
      }
    });

    it("is redacted from network errors that quote it", async () => {
      const quoting = scriptedFetch(() => {
        throw new TypeError(`Headers.append: "Bearer ${SECRET}" is an invalid header value`);
      });
      const err = await rejection(
        createGistClient({ token: SECRET, fetch: quoting.fetch, maxRetries: 0 }).get("abc"),
      );
      assertClean(err);
      assert.match(err.message, /Could not reach GitHub/);
    });

    it("is redacted when GitHub echoes it in a message", async () => {
      const echo = scriptedFetch(() => jsonResponse({ message: `bad ${SECRET} value` }, { status: 422 }));
      const err = await rejection(createGistClient({ token: SECRET, fetch: echo.fetch }).get("abc"));
      assertClean(err);
      assert.match(err.message, /bad \*\*\* value/);
    });

    it("rejects a token with whitespace without echoing it or sending a request", async () => {
      const bad = `${SECRET}\n`;
      const never = scriptedFetch(() => jsonResponse({ id: "x", files: {} }));
      const err = await rejection(createGistClient({ token: bad, fetch: never.fetch }).get("abc"));
      assertCode(err, "AUTH");
      assertClean(err);
      assert.equal(never.calls.length, 0);
    });
  });

  describe("300-file guard", () => {
    const many = (n: number, value: string | null = "x") => {
      const files: Record<string, string | null> = {};
      for (let i = 0; i < n; i++) files[`f${i}.txt`] = value;
      return files;
    };

    it("create with 301 files throws TOO_MANY_FILES before any request", async () => {
      const err = await rejection(client().create("d", many(301) as Record<string, string>));
      assertCode(err, "TOO_MANY_FILES");
      assert.match(err.message, /300/);
      assert.match(err.message, /301/);
      assert.equal(server.requests.length, 0);
    });

    it("create with exactly 300 files is allowed", async () => {
      const snap = await client().create("d", many(300) as Record<string, string>);
      assert.equal(Object.keys(snap.files).length, 300);
    });

    it("update writing 301 files throws before any request; deletions do not count", async () => {
      const err = await rejection(client().update("deadbeef", many(301)));
      assertCode(err, "TOO_MANY_FILES");
      assert.equal(server.requests.length, 0);

      const created = await client().create("d", { "keep.txt": "k" });
      server.requests.length = 0;
      const changes = { ...many(300), "keep.txt": null };
      const snap = await client().update(created.id, changes);
      assert.equal(Object.keys(snap.files).length, 300);
      assert.equal(server.requests.length, 1);
    });
  });
});

describe("fake server fixture", () => {
  let server: FakeGistServer;
  beforeEach(async () => {
    server = await startFakeGist();
  });
  afterEach(async () => {
    await server.close();
  });

  it("records requests and lets failNext target any route in order", async () => {
    server.failNext(503, { "x-custom": "yes" });
    const res = await fetch(`${server.baseUrl}/gists/nothing`, { headers: { authorization: "Bearer nope" } });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("x-custom"), "yes");
    assert.equal(server.requests[0]!.method, "GET");
    assert.equal(server.requests[0]!.url, "/gists/nothing");
    assert.equal((await fetch(`${server.baseUrl}/gists/nothing`)).status, 401);
  });

  it("omits content from the listing for files over 1 MiB and serves them raw", async () => {
    const auth = { authorization: `Bearer ${FAKE_TOKEN}` };
    const created = await createGistClient({ token: FAKE_TOKEN, baseUrl: server.baseUrl }).create("d", {
      "big.txt": "a".repeat(MIB + 1),
      "exact.txt": "b".repeat(MIB),
    });
    const listing = (await (await fetch(`${server.baseUrl}/gists/${created.id}`, { headers: auth })).json()) as {
      files: Record<string, { truncated: boolean; content?: string; raw_url: string }>;
    };
    assert.equal(listing.files["big.txt"]!.truncated, true);
    assert.equal(listing.files["big.txt"]!.content, undefined);
    assert.equal(listing.files["exact.txt"]!.truncated, false);
    assert.equal(listing.files["exact.txt"]!.content!.length, MIB);
    // Only ever hit the fake server: assert the origin, then rebuild the URL from its base.
    const rawUrl = new URL(listing.files["big.txt"]!.raw_url);
    assert.equal(rawUrl.origin, server.baseUrl);
    const raw = await fetch(new URL(rawUrl.pathname, server.baseUrl));
    assert.equal((await raw.text()).length, MIB + 1);
  });

  it("enforces the 300-file limit on create over plain HTTP", async () => {
    const files: Record<string, { content: string }> = {};
    for (let i = 0; i < 301; i++) files[`f${i}`] = { content: "x" };
    const res = await fetch(`${server.baseUrl}/gists`, {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_TOKEN}` },
      body: JSON.stringify({ files }),
    });
    assert.equal(res.status, 422);
  });

  it("answers 400 for unparseable bodies", async () => {
    const res = await fetch(`${server.baseUrl}/gists`, {
      method: "POST",
      headers: { authorization: `Bearer ${FAKE_TOKEN}` },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });
});

describe("createGistClient options", () => {
  it("defaults to api.github.com and a pi-gist-sync user agent", async () => {
    const fetched = scriptedFetch(() => jsonResponse({ id: "abc", files: {} }));
    await createGistClient({ token: "ghp_tok", fetch: fetched.fetch }).get("abc");
    assert.equal(fetched.calls[0]!.url, "https://api.github.com/gists/abc");
    assert.equal(fetched.calls[0]!.headers["User-Agent"], "pi-gist-sync");
    assert.equal(fetched.calls[0]!.headers.Accept, "application/vnd.github+json");
    assert.equal(fetched.calls[0]!.headers["X-GitHub-Api-Version"], "2022-11-28");
  });

  it("rejects an unusable baseUrl", () => {
    assert.throws(
      () => createGistClient({ token: "ghp_tok", baseUrl: "not a url" }),
      (err: unknown) => err instanceof GistSyncError && err.code === "API",
    );
  });
});

describe("resolveToken", () => {
  const noGh = async () => undefined;

  it("prefers PI_GIST_SYNC_TOKEN, then GH_TOKEN, then GITHUB_TOKEN, then gh", async () => {
    const env = { PI_GIST_SYNC_TOKEN: "a", GH_TOKEN: "b", GITHUB_TOKEN: "c" };
    assert.equal(await resolveToken(env, async () => "d"), "a");
    assert.equal(await resolveToken({ GH_TOKEN: "b", GITHUB_TOKEN: "c" }, async () => "d"), "b");
    assert.equal(await resolveToken({ GITHUB_TOKEN: "c" }, async () => "d"), "c");
    assert.equal(await resolveToken({}, async () => "d"), "d");
  });

  it("does not run gh when an env var supplies a token", async () => {
    let called = 0;
    await resolveToken({ GH_TOKEN: "b" }, async () => {
      called++;
      return "d";
    });
    assert.equal(called, 0);
  });

  it("trims values and skips blank ones", async () => {
    assert.equal(await resolveToken({ PI_GIST_SYNC_TOKEN: "  ", GH_TOKEN: " tok \n" }, noGh), "tok");
    assert.equal(await resolveToken({ GH_TOKEN: "" }, async () => "  from-gh\n"), "from-gh");
  });

  it("throws NO_TOKEN mentioning the gist scope when nothing yields a token", async () => {
    for (const gh of [noGh, async () => "  ", async () => Promise.reject(new Error("gh missing"))]) {
      const err = await rejection(resolveToken({ GH_TOKEN: " " }, gh));
      assertCode(err, "NO_TOKEN");
      assert.match(err.message, /`gist` scope/);
      assert.match(err.message, /PI_GIST_SYNC_TOKEN/);
    }
  });
});
