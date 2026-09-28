# webwire

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fwebwire.svg)](https://www.npmjs.com/package/@johnhenry/webwire)
[![CI](https://github.com/johnhenry/webwire/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/webwire/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fwebwire.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/webwire](https://opensource.johnhenry.me/webwire/)

Convert between Node.js's raw `http`/`https` objects and the standard Web
Fetch API (`Request`/`Response`) — both directions, request and response.

Node's own HTTP API (`IncomingMessage`, `ServerResponse`,
`http.request()`/`https.request()`) predates the Fetch API and doesn't speak
it. Any code that wants to work in `Request`/`Response` terms — a router, a
proxy, a test harness — but still has to touch Node's raw sockets somewhere
(running a real server, or making a real outbound client request) needs to
convert at that boundary. There are exactly four such boundaries; this
package is all four, and nothing else:

| Direction | Function |
|---|---|
| Node inbound server request → Web `Request` | [`toWebRequest()`](#towebrequestreq-options) |
| Node outbound client response → Web `Response` | [`toWebResponse()`](#towebresponsenoderes-body) |
| Web `Response` → written-out Node `ServerResponse` | [`writeWebResponse()`](#writewebresponseresponse-res-options) |
| Web `Request`-shaped input → Node client `http.request()` options | [`toNodeRequestOptions()`](#tonoderequestoptionsrequestorurl-options) |

> **Provenance:** extracted from [`@johnhenry/leserve`](https://github.com/johnhenry/leserve)
> (which had the first two functions as `node-request.mjs`/`node-to-web.mjs`,
> and the third inlined in `serve.mjs`) and [`@johnhenry/prism`](https://github.com/johnhenry/prism)
> (whose `timed-fetch.mjs` had a version of the fourth entangled with its own
> socket-timing instrumentation), once a real, independent duplicate of the
> first and third turned up in [`@johnhenry/dialback`](https://github.com/johnhenry/dialback) —
> see [Family](#family) for the full story.

## Install

```bash
npm install @johnhenry/webwire
```

## Quick Start

```js
import { toWebRequest, writeWebResponse } from "@johnhenry/webwire";
import http from "node:http";

const server = http.createServer(async (req, res) => {
  const request = toWebRequest(req, { attachRaw: true });
  const response = new Response(`Hello, ${request.method} ${new URL(request.url).pathname}`);
  await writeWebResponse(response, res);
});
server.listen(8000);
```

```js
import { toNodeRequestOptions, toWebResponse } from "@johnhenry/webwire";
import http from "node:http";
import https from "node:https";

// Make an outbound request from a Request object, using Node's raw client
// API, and get a real Web Response back.
async function nodeFetch(request) {
  const { isHTTPS, requestOptions } = toNodeRequestOptions(request);
  const doRequest = isHTTPS ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const req = doRequest(requestOptions, async (nodeRes) => {
      const chunks = [];
      for await (const chunk of nodeRes) chunks.push(chunk);
      resolve(toWebResponse(nodeRes, Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.end();
  });
}
```

## API

### `toWebRequest(req, options?)`

Converts a Node `http`/`https` **server-side** `IncomingMessage` (the `req`
in `server.on("request", (req, res) => ...)`) into a Web `Request`.

- `options.attachRaw` (`boolean`, default `false`) — attach the original
  `IncomingMessage` as a non-enumerable `.raw` property (e.g. so middleware
  can reach the underlying socket for WebSocket upgrades).
- `options.hostHeaders` (`string[]`, default `["host"]`) — header names to
  check, in priority order, for the host used to build an absolute URL from
  `req.url` (Node hands you a relative path). A reverse proxy typically
  wants `["x-forwarded-host", "host"]` so it reflects the original
  client-facing host, not its own.

Throws an `Error` tagged with `.status = 400` (not a raw `URL` parse error)
if `req.url` survives Node's HTTP parser but isn't a valid URL, so callers
can turn it into a real 400 response instead of a 500 or a process crash.

### `toWebResponse(nodeRes, body?)`

Converts the response object Node hands back from an **outbound client**
request (`http.request(url, (res) => ...)`'s `res`) into a Web `Response`.
Does not read `nodeRes` itself — pass a buffered body, a `Readable`-derived
`ReadableStream`, or omit it for a bodyless response.

### `writeWebResponse(response, res, options?)`

Writes a Web `Response` out through a Node `ServerResponse`. Handles status,
multi-value headers (`Set-Cookie` isn't comma-joined by the Fetch spec — sent
as separate header lines), trailers (via `setTrailers()`/`getTrailers()`,
since Fetch `Response` has no native trailers concept), and every body shape
a handler might return (string, `Uint8Array`, `ReadableStream`, a Node
`Readable`, or anything else via `String()`).

`response.status === 101` (WebSocket upgrade) is a special case: a real
`Response` can't hold status 101 at all (the Fetch spec's constructor throws
for any status outside `[200, 599]`), so pass a plain
`Object.freeze({ status: 101 })` instead — `writeWebResponse()` returns
immediately without touching `res`, leaving the upgrade to whatever handled
it already.

- `options.onError` (`(error: Error) => void`) — called (not thrown) if
  writing a streamed body fails after headers are already sent, since
  there's no response left at that point to send an error status on.
  Defaults to `console.error`.

### `toNodeRequestOptions(requestOrUrl, options?)`

Converts a Web `Request` (or a bare URL + `{ method, headers }`, for callers
without a full `Request` object handy) into the pieces needed to make the
equivalent outbound call with Node's raw client API:

```js
{ url: URL, isHTTPS: boolean, requestOptions: { hostname, port, path, method, headers } }
```

Deliberately returns plain data, not a live request — callers stay in
control of actually issuing it, attaching socket-event hooks, writing the
body, etc.

### `setTrailers(response, trailers)` / `getTrailers(response)`

HTTP trailers aren't part of the Fetch `Response` model — there's no
`response.trailers` to set. `setTrailers()` attaches trailers to a
`Response` a handler is about to return (a value computed *from* the
streamed body — a running checksum, `Server-Timing` — can be a `Promise`);
`writeWebResponse()` checks for them via `getTrailers()` after the body
finishes streaming and transmits them via `res.addTrailers()`.

## Family

Four packages actually motivated this one, in order:

- **[`@johnhenry/leserve`](https://github.com/johnhenry/leserve)** — had
  `toWebRequest`/`toWebResponse` as its own `node-request.mjs`/`node-to-web.mjs`,
  and `writeWebResponse`'s logic inlined directly in `serve.mjs`. Now
  depends on this package and re-exports the first two from their original
  subpaths for backward compatibility (`@johnhenry/servant` already depends
  on `leserve/node-request` specifically).
- **[`@johnhenry/servant`](https://github.com/johnhenry/servant)** —
  depends on `@johnhenry/leserve` *just* for `toWebRequest` (via
  `leserve/node-request`), not for `serve()` itself — the original evidence
  that this conversion logic had reuse value independent of "being a
  server."
- **[`@johnhenry/dialback`](https://github.com/johnhenry/dialback)** — its
  `Server` had independently reimplemented both `toWebRequest` (with one
  real, deliberate difference: `X-Forwarded-Host` priority, now expressible
  via `hostHeaders`) and `writeWebResponse` (whose
  `Object.fromEntries(response.headers)` silently collapsed multi-value
  headers like `Set-Cookie` — a real bug this package's version doesn't
  have). This duplication, alongside servant's dependency on leserve for
  the same logic, was the actual trigger for extracting a shared package
  rather than leaving the logic to keep drifting.
- **[`@johnhenry/prism`](https://github.com/johnhenry/prism)** — its
  `timed-fetch.mjs` had a version of `toNodeRequestOptions` (headers
  normalization only) entangled with its own per-socket timing
  instrumentation. Disentangled: `timed-fetch.mjs` now calls
  `toNodeRequestOptions()` for the connection details and keeps the timing
  hooks, which are its own genuine, unrelated value.

## License

MIT
