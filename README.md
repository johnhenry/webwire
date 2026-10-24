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
package is all four, plus one convenience that composes the server-side
pair:

| Direction | Function |
|---|---|
| Node inbound server request → Web `Request` | [`toWebRequest()`](#towebrequestreq-options) |
| Node outbound client response → Web `Response` | [`toWebResponse()`](#towebresponsenoderes-body) |
| Web `Response` → written-out Node `ServerResponse` | [`writeWebResponse()`](#writewebresponseresponse-res-options) |
| Web `Request`-shaped input → Node client `http.request()` options | [`toNodeRequestOptions()`](#tonoderequestoptionsrequestorurl-options) |
| Fetch-style handler `(request, info) => Response` → Node `request` listener | [`toNodeListener()`](#tonodelistenerhandler-options) |

> **Provenance:** extracted from [`@johnhenry/leserve`](https://github.com/johnhenry/leserve)
> (which had the first two functions as `node-request.mjs`/`node-to-web.mjs`,
> and the third inlined in `serve.mjs`) and a private HTTP-inspector app
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

Or let `toNodeListener()` do that wiring (400/500 handling, client-abort
signal, HEAD) for you:

```js
import { toNodeListener } from "@johnhenry/webwire";
import http from "node:http";

http
  .createServer(
    toNodeListener(async (request, info) => {
      // Cancelled if the client disconnects.
      const upstream = await fetch("https://api.example.com/slow", { signal: request.signal });
      return Response.json({ upstream: await upstream.json(), from: info.remoteAddress });
    })
  )
  .listen(8000);
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
  client-facing host, not its own. Names are case-insensitive
  (`["X-Forwarded-Host"]` works; they are lower-cased internally because
  Node lower-cases incoming header names).
- `options.res` (`ServerResponse`) — the matching response. When given,
  `request.signal` also aborts if the response closes before it finishes
  (the client disconnected). Without it, the signal only aborts while the
  request body is still arriving; for a GET that window is already over, so
  pass `res` if you want to cancel slow work when the client goes away.

`request.signal` aborts with an `AbortError` `DOMException` when the client
disconnects (see `options.res`), so handlers can pass it on to `fetch()`,
timers, database calls and so on.

Headers are built from `req.rawHeaders`, so repeated inbound headers such as
`Set-Cookie` stay separate (`request.headers.getSetCookie()` returns each)
instead of Node's comma-joined `req.headers` value. Other repeated headers
are joined with `", "` by `Headers`, so a duplicate that Node would drop (a
second `Content-Type`, say) shows up joined.

`node:http2` compatibility-API requests (`Http2ServerRequest`) work too:
pseudo-headers (`:method`, `:path`, ...) and symbol keys are dropped from
the headers, the host falls back to `:authority` when no `hostHeaders`
header is present, and the scheme comes from `:scheme`.

The URL scheme is `https:` when `req.socket.encrypted` is true (a request
received by a real `https.createServer()`), otherwise `http:`
(HTTP/2: `:scheme`). `X-Forwarded-Proto` is **not** consulted: behind a TLS-terminating proxy you
get `http:` URLs unless you rebuild the URL yourself.

Throws an `Error` tagged with `.status = 400` (not a raw `URL` parse error)
if `req.url` survives Node's HTTP parser but isn't a valid URL, so callers
can turn it into a real 400 response instead of a 500 or a process crash.
A comma-chained host such as `X-Forwarded-Host: a.com, b.com` is not split;
it is not a valid host, so it throws that same tagged 400.

Behaviour to know about: `req.url` is resolved against the host with
`new URL()`, so a `//host/path` request target or an absolute-form target
(`GET http://other.example/path HTTP/1.1`) **overrides the Host header**.
Don't trust the resulting URL's host for access decisions without
validating it.

### `toWebResponse(nodeRes, body?)`

Converts the response object Node hands back from an **outbound client**
request (`http.request(url, (res) => ...)`'s `res`) into a Web `Response`.
Does not read `nodeRes` itself — pass a buffered body, a `Readable`-derived
`ReadableStream`, or omit it for a bodyless response. For status 204, 205 and 304 any body
(even an empty `Buffer`) is ignored and passed to `Response` as `null`, since
the constructor would otherwise throw.

### `writeWebResponse(response, res, options?)`

Writes a Web `Response` out through a Node `ServerResponse`. Handles status
(and a non-empty `statusText`, written as the HTTP reason phrase),
multi-value headers (`Set-Cookie` isn't comma-joined by the Fetch spec — sent
as separate header lines), trailers (via `setTrailers()`/`getTrailers()`,
since Fetch `Response` has no native trailers concept), and the body.

A real `Response`'s `.body` is always a `ReadableStream` (or `null`), and
that is the path it takes. The string, `Uint8Array`, Node `Readable` and
`String()` fallback branches exist only for duck-typed response-like objects
(for example `{ status: 200, headers: new Headers(), body: "text" }`); a real
`Response` never reaches them.

Body handling:

- For a HEAD request and for status 204/205/304 the body is cancelled, not
  read. The method comes from `options.method`, else `res.req.method`.
- A client disconnecting mid-body cancels the body and is **not** reported
  to `onError`; only failures of the body itself are.
- A body that fails before its first byte is written (headers not yet sent)
  gets a plain `500 Internal Server Error` instead of a dropped connection.
  After the first byte, the connection is destroyed.
- `options.bufferLimit` (bytes, default `0`) buffers that much of a streamed
  body; if it ends within the limit it is sent with `content-length`
  instead of chunked, like `res.end(string)`. Skipped when the response
  already has a `content-length` or carries trailers. Leave it at `0` for
  streams that must flush immediately (server-sent events).

Works with `node:http2` compatibility-API responses too; HTTP/2 has no
reason phrase, so `statusText` is not written there.

Caveats:

- Trailers are dropped when the response has a `content-length` header: HTTP
  requires chunked encoding for trailers, and Node does not send them
  otherwise.
- Hop-by-hop headers (`connection`, `transfer-encoding`, `keep-alive`, ...)
  pass through untouched. Stripping them is the caller's job when building a
  proxy; this package has no opt-in strip.

`response.status === 101` (WebSocket upgrade) is a special case: a real
`Response` can't hold status 101 at all (the Fetch spec's constructor throws
for any status outside `[200, 599]`), so pass a plain
`Object.freeze({ status: 101 })` instead — `writeWebResponse()` returns
immediately without touching `res`, leaving the upgrade to whatever handled
it already.

- `options.onError` (`(error: Error) => void`) — called (not thrown) when
  the response body fails (before or after headers are sent). Client
  disconnects are not reported. Defaults to `console.error`.
- `options.method` (`string`) — the request method; `HEAD` skips the body.
  Defaults to `res.req?.method`.
- `options.bufferLimit` (`number`, default `0`) — see above.

### `toNodeRequestOptions(requestOrUrl, options?)`

Converts a Web `Request` (or a bare URL + `{ method, headers }`, for callers
without a full `Request` object handy) into the pieces needed to make the
equivalent outbound call with Node's raw client API:

```js
{ url: URL, isHTTPS: boolean, requestOptions: { hostname, port, path, method, headers } }
```

`port` is always a number (the URL's explicit port, else 80/443). `hostname`
has IPv6 brackets stripped (`[::1]` becomes `::1`) so `http.request()` can
connect. Repeated `set-cookie` headers come back as an array (one element
per header); all other headers are strings.

Deliberately returns plain data, not a live request — callers stay in
control of actually issuing it, attaching socket-event hooks, writing the
body, etc.

### `toNodeListener(handler, options?)`

Wraps a fetch-style handler as a Node `request` listener for
`http.createServer()`, `https.createServer()`, or `http2.createServer()` /
`createSecureServer()` (compatibility API). It composes `toWebRequest()`
and `writeWebResponse()`, and returns a listener; it does not start a
server.

- A request URL that `toWebRequest()` rejects gets `400 Bad Request`.
- `request.signal` aborts when the client disconnects (`res` is wired in).
- A handler that throws, rejects, or returns something that isn't a
  response gets `500 Internal Server Error`. An `AbortError` thrown after
  the client disconnected is not reported; the connection is just closed.
- The response is written by `writeWebResponse()`, so HEAD skips the body
  and client aborts aren't reported.

The handler's second argument is connection info, in the spirit of Deno's
`serve()` `info`, so handlers don't need `attachRaw`:
`{ remoteAddress, remotePort, localAddress, localPort, encrypted }`.

Options: `onError` (called for the 400 case, handler errors and body errors;
defaults to `console.error`), and `hostHeaders`, `attachRaw` (passed to
`toWebRequest()`) and `bufferLimit` (passed to `writeWebResponse()`).

### `setTrailers(response, trailers)` / `getTrailers(response)`

HTTP trailers aren't part of the Fetch `Response` model — there's no
`response.trailers` to set. `setTrailers()` attaches trailers to a
`Response` a handler is about to return (a value computed *from* the
streamed body — a running checksum, `Server-Timing` — can be a `Promise`);
`writeWebResponse()` checks for them via `getTrailers()` after the body
finishes streaming and transmits them via `res.addTrailers()`.

## Runtime requirements

`engines` declares Node `>=26.0.0`, which is family policy. The test suite is
run and verified on Node 26. Don't assume older Nodes work: for example, on
Node 24.9 the `npm test` script (`node --test test/`) fails to start, because
that Node treats the `test/` directory as a module path.

## Family

How these packages actually relate to webwire, as of the published versions:

- **[`@johnhenry/leserve`](https://github.com/johnhenry/leserve)** — the
  real consumer. Published `@johnhenry/leserve@0.1.0` depends on
  `@johnhenry/webwire@^0.0.0`. It originally had `toWebRequest`/`toWebResponse`
  as its own `node-request.mjs`/`node-to-web.mjs`, with `writeWebResponse`'s
  logic inlined in `serve.mjs`, which is where this code was extracted from.
- **[`@johnhenry/servant`](https://github.com/johnhenry/servant)** — reaches
  webwire only transitively, through `leserve` (it uses `toWebRequest` via
  `leserve/node-request`). It has no direct dependency on this package. It
  was the original evidence that this conversion logic had reuse value
  independent of "being a server."
- **[`@johnhenry/dialback`](https://github.com/johnhenry/dialback)** — the
  published `@johnhenry/dialback@0.0.3` does **not** depend on webwire (its
  only dependency is `ws`); the dialback repo's `main` branch lists
  `@johnhenry/webwire@^0.0.0`, but that is not yet released. Its `Server` had
  independently reimplemented both `toWebRequest` (with one deliberate
  difference: `X-Forwarded-Host` priority, which `hostHeaders` can now
  express) and `writeWebResponse` (whose `Object.fromEntries(response.headers)`
  silently collapsed multi-value headers like `Set-Cookie`, a bug this
  package does not have). That duplication, alongside servant's reliance on
  leserve for the same logic, was the trigger for extracting a shared
  package.

## License

MIT
