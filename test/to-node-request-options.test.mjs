import { test } from "node:test";
import assert from "node:assert/strict";
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
