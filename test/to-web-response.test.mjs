import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { toWebResponse } from "../lib/to-web-response.mjs";

test("converts status, statusText, headers, and body", async () => {
  const nodeRes = {
    statusCode: 201,
    statusMessage: "Created",
    headers: {
      "content-type": "text/plain",
      "x-multi": ["a", "b"],
      "x-null": null,
    },
  };

  const response = toWebResponse(nodeRes, "hello");

  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.equal(response.headers.get("content-type"), "text/plain");
  assert.equal(response.headers.get("x-multi"), "a, b");
  assert.equal(response.headers.has("x-null"), false);
  assert.equal(await response.text(), "hello");
});

test("with no body produces an empty-bodied Response", async () => {
  const nodeRes = { statusCode: 204, statusMessage: "No Content", headers: {} };
  const response = toWebResponse(nodeRes);
  assert.equal(response.status, 204);
  assert.equal(await response.text(), "");
});

test("round-trips a real Node client response (http.request) into a Web Response", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "x-custom": "yes" });
    res.end("real server body");
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const nodeRes = await new Promise((resolveReq, rejectReq) => {
      const clientReq = http.request(`http://localhost:${port}/`, resolveReq);
      clientReq.on("error", rejectReq);
      clientReq.end();
    });
    const chunks = [];
    for await (const chunk of nodeRes) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    const response = toWebResponse(nodeRes, body);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/plain");
    assert.equal(response.headers.get("x-custom"), "yes");
    assert.equal(await response.text(), "real server body");
  } finally {
    server.close();
  }
});

for (const status of [204, 205, 304]) {
  test(`status ${status} accepts an (empty) body from a real client response`, async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(status);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, resolve));
    try {
      const nodeRes = await new Promise((resolve, reject) => {
        const clientReq = http.request({ port: server.address().port }, resolve);
        clientReq.on("error", reject);
        clientReq.end();
      });
      const chunks = [];
      for await (const chunk of nodeRes) chunks.push(chunk);
      // The usual buffering pattern hands an empty Buffer here; the Response
      // constructor rejects any non-null body for null-body statuses.
      const response = toWebResponse(nodeRes, Buffer.concat(chunks));
      assert.equal(response.status, status);
      assert.equal(response.body, null);
      assert.equal(toWebResponse(nodeRes, "").body, null);
    } finally {
      server.close();
    }
  });
}
