import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { toNodeListener } from "../lib/to-node-listener.mjs";

const withServer = async (listener, run) => {
  const server = http.createServer(listener);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(server.address().port);
  } finally {
    server.close();
  }
};

const request = (port, { method = "GET", path = "/", body } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ res, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });

test("serves a handler end to end and passes connection info as the second argument", async () => {
  let seenInfo, seenBody;
  await withServer(
    toNodeListener(async (req, info) => {
      seenInfo = info;
      seenBody = await req.text();
      return new Response(`${req.method} ${new URL(req.url).pathname}`, { status: 201 });
    }),
    async (port) => {
      const { res, body } = await request(port, { method: "POST", path: "/x", body: "hello" });
      assert.equal(res.statusCode, 201);
      assert.equal(body, "POST /x");
      assert.equal(seenBody, "hello");
      assert.equal(seenInfo.remoteAddress, "127.0.0.1");
      assert.equal(typeof seenInfo.remotePort, "number");
      assert.equal(seenInfo.localAddress, "127.0.0.1");
      assert.equal(seenInfo.localPort, port);
      assert.equal(seenInfo.encrypted, false);
    }
  );
});

test("a malformed request-target gets a 400 and is reported to onError", async () => {
  const errors = [];
  let called = false;
  await withServer(
    toNodeListener(() => { called = true; return new Response("no"); }, { onError: (e) => errors.push(e) }),
    async (port) => {
      const raw = await new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write("GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        });
        let data = "";
        socket.on("data", (c) => (data += c));
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      assert.match(raw, /^HTTP\/1\.1 400 /);
      assert.equal(called, false);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].status, 400);
    }
  );
});

test("a handler that throws gets a 500 and is reported to onError", async () => {
  const errors = [];
  await withServer(
    toNodeListener(async () => { throw new Error("handler broke"); }, { onError: (e) => errors.push(e) }),
    async (port) => {
      const { res, body } = await request(port);
      assert.equal(res.statusCode, 500);
      assert.equal(body, "Internal Server Error");
      assert.equal(errors.length, 1);
      assert.equal(errors[0].message, "handler broke");
    }
  );
});

test("a handler that returns a non-Response gets a 500", async () => {
  const errors = [];
  await withServer(
    toNodeListener(() => "not a response", { onError: (e) => errors.push(e) }),
    async (port) => {
      const { res } = await request(port);
      assert.equal(res.statusCode, 500);
      assert.equal(errors.length, 1);
      assert.ok(errors[0] instanceof TypeError);
    }
  );
});

test("request.signal aborts on client disconnect, and an AbortError rejection is not reported", async () => {
  const errors = [];
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  await withServer(
    toNodeListener(
      async (req) => {
        const started = Date.now();
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 800);
            req.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(req.signal.reason);
            });
          });
          return new Response("too late");
        } finally {
          resolveDone(Date.now() - started);
        }
      },
      { onError: (e) => errors.push(e) }
    ),
    async (port) => {
      const client = http.request({ host: "127.0.0.1", port, agent: false });
      client.on("error", () => {});
      client.end();
      setTimeout(() => client.destroy(), 100);
      const elapsed = await done;
      assert.ok(elapsed < 600, `handler ran ${elapsed} ms`);
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(errors, []);
    }
  );
});

test("HEAD through the listener sends headers but skips the body", async () => {
  let cancelled = false;
  await withServer(
    toNodeListener(() =>
      new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } }), {
        headers: { "x-h": "1" },
      })
    ),
    async (port) => {
      const { res, body } = await request(port, { method: "HEAD" });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["x-h"], "1");
      assert.equal(body, "");
      assert.equal(cancelled, true);
    }
  );
});

test("bufferLimit is passed through to writeWebResponse()", async () => {
  await withServer(
    toNodeListener(() => Response.json({ ok: true }), { bufferLimit: 1024 }),
    async (port) => {
      const { res, body } = await request(port);
      assert.equal(res.headers["content-length"], String(body.length));
      assert.deepEqual(JSON.parse(body), { ok: true });
    }
  );
});
