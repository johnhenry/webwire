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

// --- client disconnects, HEAD, early body errors, content-length ----------

const listenWith = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  return server;
};

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

test("a client disconnecting mid-stream is not reported to onError, and the body is cancelled", async () => {
  const errors = [];
  const cancelled = deferred();
  const written = deferred();
  const server = await listenWith(async (req, res) => {
    let n = 0;
    const body = new ReadableStream({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 20));
        controller.enqueue(new TextEncoder().encode(`chunk-${n++}\n`));
      },
      cancel() {
        cancelled.resolve(n);
      },
    });
    await writeWebResponse(new Response(body), res, { onError: (e) => errors.push(e) });
    written.resolve();
  });
  try {
    const client = http.request({ port: server.address().port, agent: false }, (res) => {
      res.once("data", () => client.destroy());
    });
    client.on("error", () => {});
    client.end();
    const pulled = await cancelled.promise;
    await written.promise;
    assert.deepEqual(errors, []);
    assert.ok(pulled < 20, `stream kept being pulled (${pulled} chunks)`);
  } finally {
    server.close();
  }
});

test("a client that is already gone while the first chunk is pending is not reported either", async () => {
  const errors = [];
  const cancelled = deferred();
  const written = deferred();
  const server = await listenWith(async (req, res) => {
    const body = new ReadableStream({
      pull: () => new Promise(() => {}), // never produces
      cancel: () => cancelled.resolve(),
    });
    await writeWebResponse(new Response(body), res, { onError: (e) => errors.push(e) });
    written.resolve();
  });
  try {
    const client = http.request({ port: server.address().port, agent: false });
    client.on("error", () => {});
    client.end();
    setTimeout(() => client.destroy(), 50);
    await cancelled.promise;
    await written.promise;
    assert.deepEqual(errors, []);
  } finally {
    server.close();
  }
});

test("a real body error after headers are sent is still reported and the connection destroyed", async () => {
  const errors = [];
  const server = await listenWith(async (req, res) => {
    let n = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (n++ === 0) controller.enqueue(new TextEncoder().encode("first"));
        else controller.error(new Error("upstream broke"));
      },
    });
    await writeWebResponse(new Response(body), res, { onError: (e) => errors.push(e) });
  });
  try {
    const outcome = await new Promise((resolve) => {
      const req = http.request({ port: server.address().port, agent: false }, (res) => {
        res.on("data", () => {});
        res.on("error", () => resolve("error"));
        res.on("aborted", () => resolve("aborted"));
        res.on("end", () => resolve("end"));
      });
      req.on("error", () => resolve("error"));
      req.end();
    });
    assert.notEqual(outcome, "end");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "upstream broke");
  } finally {
    server.close();
  }
});

test("a body that fails on its first read gets a 500 (headers not yet sent)", async () => {
  const errors = [];
  const server = await listenWith(async (req, res) => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error("boom"));
      },
    });
    await writeWebResponse(
      new Response(body, { status: 200, statusText: "Fine", headers: { "x-app": "1" } }),
      res,
      { onError: (e) => errors.push(e) }
    );
  });
  try {
    const { res, body } = await get(server.address().port);
    assert.equal(res.statusCode, 500);
    assert.equal(res.statusMessage, "Internal Server Error");
    assert.equal(res.headers["x-app"], undefined);
    assert.equal(body, "Internal Server Error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].message, "boom");
  } finally {
    server.close();
  }
});

const pullCountingBody = (state) =>
  new ReadableStream({
    pull(controller) {
      state.pulls++;
      controller.enqueue(new Uint8Array(64 * 1024));
      if (state.pulls > 5000) controller.close(); // ~300 MB
    },
    cancel() {
      state.cancelled = true;
    },
  });

const head = (port) =>
  new Promise((resolve, reject) => {
    const req = http.request({ port, method: "HEAD" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res));
    });
    req.on("error", reject);
    req.end();
  });

test("HEAD (from res.req.method) cancels the body instead of pulling it", async () => {
  const state = { pulls: 0, cancelled: false };
  const server = await listenWith(async (req, res) => {
    await writeWebResponse(new Response(pullCountingBody(state), { headers: { "x-h": "1" } }), res);
  });
  try {
    const res = await head(server.address().port);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["x-h"], "1");
    assert.equal(state.cancelled, true);
    assert.ok(state.pulls <= 1, `pulled ${state.pulls} chunks`);
  } finally {
    server.close();
  }
});

test("options.method = 'HEAD' also skips the body", async () => {
  const state = { pulls: 0, cancelled: false };
  const server = await listenWith(async (req, res) => {
    await writeWebResponse(new Response(pullCountingBody(state)), res, { method: "head" });
  });
  try {
    await head(server.address().port);
    assert.equal(state.cancelled, true);
    assert.ok(state.pulls <= 1);
  } finally {
    server.close();
  }
});

test("a duck-typed 304 with a stream body cancels it", async () => {
  const state = { pulls: 0, cancelled: false };
  const server = await listenWith(async (req, res) => {
    await writeWebResponse({ status: 304, headers: new Headers(), body: pullCountingBody(state) }, res);
  });
  try {
    const { res, body } = await get(server.address().port);
    assert.equal(res.statusCode, 304);
    assert.equal(body, "");
    assert.equal(state.cancelled, true);
  } finally {
    server.close();
  }
});

test("bufferLimit sends a small body with content-length instead of chunked", async () => {
  const server = await listenWith(async (req, res) => {
    await writeWebResponse(new Response('{"small":"json"}'), res, { bufferLimit: 64 * 1024 });
  });
  try {
    const { res, body } = await get(server.address().port);
    assert.equal(res.headers["content-length"], String(Buffer.byteLength('{"small":"json"}')));
    assert.equal(res.headers["transfer-encoding"], undefined);
    assert.equal(body, '{"small":"json"}');
  } finally {
    server.close();
  }
});

test("without bufferLimit the same body is sent chunked (unchanged default)", async () => {
  const server = await listenWith(async (req, res) => {
    await writeWebResponse(new Response('{"small":"json"}'), res);
  });
  try {
    const { res, body } = await get(server.address().port);
    assert.equal(res.headers["content-length"], undefined);
    assert.equal(res.headers["transfer-encoding"], "chunked");
    assert.equal(body, '{"small":"json"}');
  } finally {
    server.close();
  }
});

test("a body larger than bufferLimit streams chunked and arrives intact", async () => {
  const server = await listenWith(async (req, res) => {
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode("x".repeat(10)));
        c.close();
      },
    });
    await writeWebResponse(new Response(stream), res, { bufferLimit: 15 });
  });
  try {
    const { res, body } = await get(server.address().port);
    assert.equal(res.headers["content-length"], undefined);
    assert.equal(res.headers["transfer-encoding"], "chunked");
    assert.equal(body, "x".repeat(40));
  } finally {
    server.close();
  }
});

test("bufferLimit leaves content-length off when trailers are set", async () => {
  const server = await listenWith(async (req, res) => {
    const response = new Response("body");
    setTrailers(response, { "x-checksum": "abc" });
    await writeWebResponse(response, res, { bufferLimit: 1024 });
  });
  try {
    const { res, body } = await get(server.address().port);
    assert.equal(res.headers["content-length"], undefined);
    assert.equal(body, "body");
    assert.equal(res.trailers["x-checksum"], "abc");
  } finally {
    server.close();
  }
});

test("an already-consumed body is reported and gets a 500 instead of rejecting", async () => {
  const errors = [];
  const server = await listenWith(async (req, res) => {
    const response = new Response("used");
    await response.text();
    await writeWebResponse(response, res, { onError: (e) => errors.push(e) });
  });
  try {
    const { res } = await get(server.address().port);
    assert.equal(res.statusCode, 500);
    assert.equal(errors.length, 1);
  } finally {
    server.close();
  }
});
