import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { toNodeRequestOptions } from "../lib/to-node-request-options.mjs";

test("accepts a Request object directly", () => {
  const request = new Request("https://example.com/api?x=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  const { url, isHTTPS, requestOptions } = toNodeRequestOptions(request);
  assert.equal(url.href, "https://example.com/api?x=1");
  assert.equal(isHTTPS, true);
  assert.deepEqual(requestOptions, {
    hostname: "example.com",
    port: 443,
    path: "/api?x=1",
    method: "POST",
    headers: { "content-type": "application/json" },
  });
});

test("accepts a bare URL string + options for callers without a Request object", () => {
  const { isHTTPS, requestOptions } = toNodeRequestOptions("http://example.com/x", {
    method: "GET",
    headers: { "x-test": "1" },
  });
  assert.equal(isHTTPS, false);
  assert.equal(requestOptions.hostname, "example.com");
  assert.equal(requestOptions.port, 80);
  assert.equal(requestOptions.method, "GET");
  assert.deepEqual(requestOptions.headers, { "x-test": "1" });
});

test("defaults to GET with no headers when given a bare URL and no options", () => {
  const { requestOptions } = toNodeRequestOptions("http://example.com/");
  assert.equal(requestOptions.method, "GET");
  assert.deepEqual(requestOptions.headers, {});
});

test("respects an explicit port in the URL", () => {
  const { requestOptions } = toNodeRequestOptions("http://example.com:9000/");
  assert.equal(requestOptions.port, 9000);
});

test("normalizes a Headers instance the same way as a plain object", () => {
  const headers = new Headers({ "x-a": "1", "x-b": "2" });
  const { requestOptions } = toNodeRequestOptions("http://example.com/", { headers });
  assert.deepEqual(requestOptions.headers, { "x-a": "1", "x-b": "2" });
});

test("port is always a number, including when the URL has an explicit port", () => {
  const explicit = toNodeRequestOptions("http://example.com:9000/").requestOptions.port;
  assert.equal(typeof explicit, "number");
  assert.equal(explicit, 9000);
  assert.equal(toNodeRequestOptions("http://example.com/").requestOptions.port, 80);
  assert.equal(toNodeRequestOptions("https://example.com/").requestOptions.port, 443);
});

test("IPv6 hostnames are unbracketed and work against a real server on ::1", async (t) => {
  const { requestOptions } = toNodeRequestOptions("http://[::1]:8080/x");
  assert.equal(requestOptions.hostname, "::1");
  assert.equal(requestOptions.port, 8080);

  const server = http.createServer((req, res) => res.end("v6 ok"));
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::1", resolve);
    });
  } catch (err) {
    console.warn(`SKIPPING IPv6 end-to-end test: cannot listen on ::1 (${err.code})`);
    t.skip(`IPv6 unavailable: ${err.code}`);
    return;
  }
  try {
    const { port } = server.address();
    const opts = toNodeRequestOptions(`http://[::1]:${port}/`).requestOptions;
    const body = await new Promise((resolve, reject) => {
      const req = http.request(opts, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString()));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(body, "v6 ok");
  } finally {
    server.close();
  }
});
