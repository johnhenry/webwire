import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toWebRequest } from "../lib/to-web-request.mjs";

// A minimal IncomingMessage-shaped fake for unit tests that don't need a
// real socket. Real end-to-end coverage (a genuine http.createServer) is
// below.
const fakeReq = (overrides = {}) => ({
  method: "GET",
  url: "/hello?x=1",
  headers: { host: "example.com" },
  ...overrides,
});

test("converts method, url, and headers", () => {
  const request = toWebRequest(fakeReq());
  assert.equal(request.method, "GET");
  assert.equal(request.url, "http://example.com/hello?x=1");
});

test("falls back to localhost when no host header is present", () => {
  const request = toWebRequest(fakeReq({ headers: {} }));
  assert.equal(request.url, "http://localhost/hello?x=1");
});

test("hostHeaders lets a caller prioritize a forwarded-host header", () => {
  const req = fakeReq({
    headers: { host: "internal:9000", "x-forwarded-host": "public.example.com" },
  });
  const request = toWebRequest(req, { hostHeaders: ["x-forwarded-host", "host"] });
  assert.equal(request.url, "http://public.example.com/hello?x=1");
});

test("GET/HEAD requests get no body", () => {
  const request = toWebRequest(fakeReq({ method: "HEAD" }));
  assert.equal(request.body, null);
});

test("non-GET/HEAD requests carry the raw req as a streamed body", () => {
  const req = fakeReq({ method: "POST" });
  const request = toWebRequest(req);
  assert.notEqual(request.body, null);
});

test("attachRaw exposes the original req as a non-enumerable .raw property", () => {
  const req = fakeReq();
  const request = toWebRequest(req, { attachRaw: true });
  assert.equal(request.raw, req);
  assert.equal(Object.keys(request).includes("raw"), false);
});

test("attachRaw defaults to false", () => {
  const request = toWebRequest(fakeReq());
  assert.equal(request.raw, undefined);
});

test("a malformed request-target throws a tagged 400 error, not a raw URL parse error", () => {
  const req = fakeReq({ url: "http://[::1" }); // malformed IPv6 brackets
  assert.throws(() => toWebRequest(req), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

test("round-trips a real Node server request into a Web Request", async () => {
  let capturedMethod, capturedUrl, capturedHeader, capturedBody;
  const server = http.createServer(async (req, res) => {
    const request = toWebRequest(req, { attachRaw: true });
    capturedMethod = request.method;
    capturedUrl = request.url;
    capturedHeader = request.headers.get("x-test");
    // Read the body BEFORE responding -- responding first can race the
    // client still sending its body over the same connection.
    capturedBody = await request.text();
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await new Promise((resolve, reject) => {
      const req = http.request(
        { port, path: "/greet?name=world", method: "POST", headers: { "x-test": "1" } },
        (res) => res.on("data", () => {}).on("end", resolve)
      );
      req.on("error", reject);
      req.end("body content");
    });
    assert.equal(capturedMethod, "POST");
    assert.equal(new URL(capturedUrl).pathname, "/greet");
    assert.equal(new URL(capturedUrl).searchParams.get("name"), "world");
    assert.equal(capturedHeader, "1");
    assert.equal(capturedBody, "body content");
  } finally {
    server.close();
  }
});

test("hostHeaders names are case-insensitive (Node lower-cases incoming header names)", async () => {
  // Real server: Node itself lower-cases "X-Forwarded-Host" to
  // "x-forwarded-host" on req.headers.
  let url;
  const server = http.createServer((req, res) => {
    url = toWebRequest(req, { hostHeaders: ["X-Forwarded-Host", "Host"] }).url;
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await new Promise((resolve, reject) => {
      const req = http.request(
        { port: server.address().port, path: "/p", headers: { "X-Forwarded-Host": "public.example.com" } },
        (res) => res.on("data", () => {}).on("end", resolve)
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(url, "http://public.example.com/p");
  } finally {
    server.close();
  }
});

test("a comma-chained forwarded host throws the tagged 400 (documented behaviour)", () => {
  const req = fakeReq({ headers: { "x-forwarded-host": "a.com, b.com" } });
  assert.throws(() => toWebRequest(req, { hostHeaders: ["X-Forwarded-Host"] }), (err) => {
    assert.equal(err.status, 400);
    return true;
  });
});

// Generates a throwaway self-signed cert at test time with the system
// `openssl` (Node has no built-in X.509 generation). Returns null if that
// isn't possible, in which case the https test skips loudly.
const selfSignedCert = () => {
  const dir = mkdtempSync(join(tmpdir(), "webwire-cert-"));
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "cert.pem",
       "-days", "1", "-subj", "/CN=localhost"],
      { cwd: dir, stdio: "ignore" }
    );
    return { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("builds an https: URL when the request arrived over TLS (real https.createServer)", async (t) => {
  const creds = selfSignedCert();
  if (!creds) {
    console.warn("SKIPPING https test: could not generate a self-signed cert (is `openssl` on PATH?)");
    t.skip("openssl unavailable, cannot generate a self-signed cert");
    return;
  }
  let url;
  const server = https.createServer(creds, (req, res) => {
    url = toWebRequest(req).url;
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    await new Promise((resolve, reject) => {
      const req = https.request(
        { port: server.address().port, hostname: "localhost", path: "/secure?x=1", rejectUnauthorized: false },
        (res) => res.on("data", () => {}).on("end", resolve)
      );
      req.on("error", reject);
      req.end();
    });
    assert.match(url, /^https:\/\/localhost:\d+\/secure\?x=1$/);
  } finally {
    server.close();
  }
});

test("a plain-http request still builds an http: URL", () => {
  assert.equal(toWebRequest(fakeReq({ socket: { encrypted: undefined } })).url, "http://example.com/hello?x=1");
});
