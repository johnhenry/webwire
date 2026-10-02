import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeWebResponse } from "../lib/write-web-response.mjs";
import { setTrailers } from "../lib/trailers.mjs";

// writeWebResponse() needs a real ServerResponse (headers/trailers/streaming
// semantics aren't practical to fake convincingly) -- every test here spins
// up a real http server whose handler calls writeWebResponse() directly and
// hits it with a real client request.

const withServer = async (handler, run) => {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      res.destroy(err);
    }
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await run(port);
  } finally {
    server.close();
  }
};

const get = (port, path = "/") =>
  new Promise((resolve, reject) => {
    const req = http.request({ port, path }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ res, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });

test("writes status, headers, and a string body", async () => {
  await withServer(
    async (req, res) => {
      await writeWebResponse(
        new Response("hi", { status: 201, headers: { "x-test": "1" } }),
        res
      );
    },
    async (port) => {
      const { res, body } = await get(port);
      assert.equal(res.statusCode, 201);
      assert.equal(res.headers["x-test"], "1");
      assert.equal(body, "hi");
    }
  );
});

test("multi-value headers (e.g. Set-Cookie) are sent as separate header lines, not comma-joined", async () => {
  await withServer(
    async (req, res) => {
      const headers = new Headers();
      headers.append("set-cookie", "a=1");
      headers.append("set-cookie", "b=2");
      await writeWebResponse(new Response(null, { headers }), res);
    },
    async (port) => {
      const { res } = await get(port);
      assert.deepEqual(res.headers["set-cookie"], ["a=1", "b=2"]);
    }
  );
});

test("writes a Uint8Array body", async () => {
  await withServer(
    async (req, res) => {
      await writeWebResponse(new Response(new TextEncoder().encode("bytes")), res);
    },
    async (port) => {
      const { body } = await get(port);
      assert.equal(body, "bytes");
    }
  );
});

test("streams a ReadableStream body", async () => {
  await withServer(
    async (req, res) => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk-1"));
          controller.enqueue(new TextEncoder().encode("chunk-2"));
          controller.close();
        },
      });
      await writeWebResponse(new Response(stream), res);
    },
    async (port) => {
      const { body } = await get(port);
      assert.equal(body, "chunk-1chunk-2");
    }
  );
});

test("attaches trailers set via setTrailers() after the body finishes", async () => {
  await withServer(
    async (req, res) => {
      const response = new Response("body");
      setTrailers(response, { "x-checksum": "abc123" });
      await writeWebResponse(response, res);
    },
    async (port) => {
      const { res, body } = await get(port);
      assert.equal(body, "body");
      assert.equal(res.trailers["x-checksum"], "abc123");
    }
  );
});

test("skips writing entirely for a 101 (WebSocket upgrade already handled elsewhere)", async () => {
  await withServer(
    async (req, res) => {
      // A real `Response` can't hold status 101 at all -- the Fetch spec's
      // constructor throws for any status outside [200, 599]. Callers that
      // need to signal "this was a WebSocket upgrade, don't write a normal
      // response" hand writeWebResponse() a plain duck-typed object instead
      // (matching @johnhenry/leserve's own WEBSOCKET_UPGRADE_RESPONSE).
      await writeWebResponse(Object.freeze({ status: 101 }), res);
      // Confirms writeWebResponse() returns without touching `res` at all
      // (no headersSent, no error) so the caller remains free to handle the
      // upgrade its own way.
      assert.equal(res.headersSent, false);
      res.end();
    },
    async (port) => {
      const { res } = await get(port);
      assert.equal(res.statusCode, 200); // res.end() with no prior writeHead defaults to 200
    }
  );
});

test("a bodyless response finishes cleanly", async () => {
  await withServer(
    async (req, res) => {
      await writeWebResponse(new Response(null, { status: 204 }), res);
    },
    async (port) => {
      const { res, body } = await get(port);
      assert.equal(res.statusCode, 204);
      assert.equal(body, "");
    }
  );
});

test("writes a non-empty statusText as the HTTP reason phrase", async () => {
  await withServer(
    async (req, res) => {
      await writeWebResponse(
        new Response("hi", { status: 201, statusText: "Made It", headers: { "x-test": "1" } }),
        res
      );
    },
    async (port) => {
      const { res, body } = await get(port);
      assert.equal(res.statusCode, 201);
      assert.equal(res.statusMessage, "Made It");
      assert.equal(res.headers["x-test"], "1");
      assert.equal(body, "hi");
    }
  );
});

test("an empty statusText leaves Node's default reason phrase", async () => {
  await withServer(
    async (req, res) => {
      await writeWebResponse(new Response("nope", { status: 404 }), res);
    },
    async (port) => {
      const { res } = await get(port);
      assert.equal(res.statusMessage, "Not Found");
    }
  );
});
