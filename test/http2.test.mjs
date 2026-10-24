import { test } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import { toWebRequest } from "../lib/to-web-request.mjs";
import { writeWebResponse } from "../lib/write-web-response.mjs";
import { toNodeListener } from "../lib/to-node-listener.mjs";

// node:http2 compatibility API (Http2ServerRequest/Http2ServerResponse),
// over a real cleartext (h2c) http2.createServer() and http2.connect().

const withH2Server = async (listener, run) => {
  const server = http2.createServer(listener);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const client = http2.connect(`http://localhost:${port}`);
  try {
    await run(client, port);
  } finally {
    client.close();
    server.close();
  }
};

const h2request = (client, headers, body) =>
  new Promise((resolve, reject) => {
    const stream = client.request(headers);
    let responseHeaders;
    const chunks = [];
    stream.on("response", (h) => (responseHeaders = h));
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve({ headers: responseHeaders, body: Buffer.concat(chunks).toString() }));
    stream.on("error", reject);
    stream.end(body);
  });

test("toWebRequest() converts an Http2ServerRequest: URL from :authority/:scheme, no pseudo/symbol headers", async () => {
  let captured;
  await withH2Server(
    async (req, res) => {
      const request = toWebRequest(req, { res });
      captured = {
        method: request.method,
        url: request.url,
        names: [...request.headers.keys()],
        cookies: request.headers.getSetCookie(),
        body: await request.text(),
        aborted: request.signal.aborted,
      };
      res.end("ok");
    },
    async (client, port) => {
      const { body } = await h2request(
        client,
        { ":method": "POST", ":path": "/h2?x=1", "x-test": "1", "set-cookie": ["a=1", "b=2"] },
        "payload"
      );
      assert.equal(body, "ok");
      assert.equal(captured.method, "POST");
      assert.equal(captured.url, `http://localhost:${port}/h2?x=1`);
      assert.ok(captured.names.includes("x-test"));
      assert.ok(captured.names.every((n) => !n.startsWith(":")));
      assert.deepEqual(captured.cookies, ["a=1", "b=2"]);
      assert.equal(captured.body, "payload");
      assert.equal(captured.aborted, false);
    }
  );
});

test("writeWebResponse() writes to an Http2ServerResponse (status, multi-value headers, statusText ignored)", async () => {
  await withH2Server(
    async (req, res) => {
      const headers = new Headers({ "x-test": "1" });
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      await writeWebResponse(new Response("h2 body", { status: 201, statusText: "Made It", headers }), res);
    },
    async (client) => {
      const { headers, body } = await h2request(client, { ":path": "/" });
      assert.equal(headers[":status"], 201);
      assert.equal(headers["x-test"], "1");
      assert.deepEqual(headers["set-cookie"], ["a=1", "b=2"]);
      assert.equal(body, "h2 body");
    }
  );
});

test("toNodeListener() serves http2.createServer() end to end", async () => {
  await withH2Server(
    toNodeListener(async (request, info) =>
      Response.json({ url: request.url, method: request.method, encrypted: info.encrypted })
    ),
    async (client, port) => {
      const { headers, body } = await h2request(client, { ":path": "/json" });
      assert.equal(headers[":status"], 200);
      assert.deepEqual(JSON.parse(body), { url: `http://localhost:${port}/json`, method: "GET", encrypted: false });
    }
  );
});
