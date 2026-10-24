# Changelog

All notable changes to this project will be documented in this file.

## 0.1.0 (2026-10-24)

Fixes and additions from testing `0.0.1` as the Node adapter for p2pws
(johnhenry/p2pws#294). One new function (`toNodeListener()`), new options
(`toWebRequest()`'s `res`; `writeWebResponse()`'s `method` and
`bufferLimit`), and no removals. Some behaviour changes that callers can
see are listed below.

### Added

- **`toNodeListener(handler, options?)`.** Wraps a fetch-style
  `(request, info) => Response` handler as a Node `request` listener for
  `http`, `https` and `http2` (compatibility API). It sends a 400 when
  `toWebRequest()` rejects the URL, and a 500 when the handler throws or
  returns something that isn't a response. It wires up the client-abort
  signal and writes the response with `writeWebResponse()`. The second
  argument is `{ remoteAddress, remotePort, localAddress, localPort,
  encrypted }`, like Deno's `serve()` `info`, so handlers don't need
  `attachRaw`. Errors go to `onError`, which defaults to `console.error`.
  This is the one function that composes the others; the other four stay
  independent. Added in 4d99f19.
- **`writeWebResponse()` `bufferLimit` option (bytes, default `0`).** A
  streamed body that ends within the limit is sent with `content-length`
  instead of chunked encoding, as `res.end(string)` does. Skipped when the
  response already has a `content-length` or carries trailers. Added in
  a74ccbe.

### Fixed

- **`toWebRequest()`: `request.signal` never aborted.** It now aborts with
  an `AbortError` when the request is aborted before its body is complete.
  With the new `{ res }` option it also aborts when the response closes
  before finishing, which is the client disconnecting. For a GET, the
  request's own `close` fires at once, so pass `res` to cancel slow work.
  `toNodeListener()` passes it for you. Fixed in 4f9b7ea.
- **`writeWebResponse()` reported client disconnects as errors.**
  `ERR_STREAM_PREMATURE_CLOSE` / `ERR_STREAM_UNABLE_TO_PIPE` no longer
  reach `onError`. The body is cancelled instead, including a read still
  waiting on a slow body. Real body errors are still reported. Fixed in
  a74ccbe.
- **`writeWebResponse()` pulled the whole body for HEAD.** For HEAD
  (`options.method`, else `res.req.method`) and for 204/205/304, the body
  is now cancelled without being read. Fixed in a74ccbe.
- **`writeWebResponse()` dropped the connection when the body failed
  before any byte was written.** It now sends a plain
  `500 Internal Server Error` and reports the error, as it does for a body
  that was already read. A non-empty `statusText` is now assigned to
  `res.statusMessage` rather than written with `writeHead()`, so the
  headers stay unsent until the first byte. Fixed in a74ccbe.
- **`toWebRequest()` threw on `node:http2` compatibility requests**
  (`Symbol(sensitiveHeaders) … cannot be converted to a ByteString`).
  Symbol keys and `:` pseudo-headers are now dropped. The host falls back
  to `:authority` and the scheme comes from `:scheme`.
  `writeWebResponse()` works with `Http2ServerResponse`, which has no
  reason phrase. Fixed in 4f9b7ea and a74ccbe, with end-to-end
  `http2.createServer()` tests in 4d99f19.
- **`toWebRequest()` collapsed duplicate inbound headers.** Headers are now
  built from `req.rawHeaders`, so a repeated `Set-Cookie` comes back
  separately from `request.headers.getSetCookie()` instead of as
  `"q=1,r=2"`. Other repeated headers are joined with `", "` by `Headers`.
  A duplicate that Node used to drop, such as a second `Content-Type`, now
  shows up joined. Fixed in 4f9b7ea.

### Behaviour changes to know about

- Duck-typed string or `Uint8Array` bodies are now sent with
  `res.end(data)`, so Node adds a `content-length` header.
- `onError` is now also called for a body failure before the headers are
  sent, which is the new 500 case.

### Tests

36 -> 63. One test skips loudly, and only when IPv6 on `::1` or `openssl`
is unavailable. Every new behaviour is tested against a real
`http.createServer()`/`http.request()` pair, or a real
`http2.createServer()`/`http2.connect()` pair. The tests for each fixed bug were checked to fail against the
`0.0.1` `lib/`.

## 0.0.1 (2026-10-01)

Bug-fix release from a docs audit. All of the bugs below shipped in `0.0.0` on
the registry. Upgrade if you use any of these code paths. No API additions or
removals. The one visible type change is `toNodeRequestOptions()`'s
`requestOptions.headers`, now `Record<string, string | string[]>` because
`set-cookie` can be an array.

- **`toNodeRequestOptions()` returned `port` as a string when the URL had an explicit port.**
  `index.d.ts` promised `number`; `"http://x:8080/"` gave `"8080"`. It now
  always returns a number (`Number(url.port)`, else 80/443). Fixed in 7a27501.
- **`toNodeRequestOptions()` kept brackets on IPv6 hosts.** `hostname` was
  `"[::1]"`, which `http.request()` tried to DNS-resolve and failed with
  `ENOTFOUND`. Brackets are now stripped; tested against a real server on
  `::1`. Fixed in 27791ac.
- **`toNodeRequestOptions()` collapsed duplicate `set-cookie` headers.**
  They were comma-joined into one string, corrupting cookies. They are now
  emitted as an array via `Headers#getSetCookie()`, and Node writes one line
  per element. Fixed in 8b6fc7e.
- **`toWebRequest()` `hostHeaders` names were case-sensitive.**
  `["X-Forwarded-Host"]` silently fell back to `localhost`, because Node
  lower-cases incoming header names. Configured names are now lower-cased.
  A comma-chained `X-Forwarded-Host: a.com, b.com` still throws the tagged
  400; that is now documented. Fixed in 4c6b036.
- **`toWebRequest()` always built an `http://` URL.** It now uses `https:`
  when `req.socket.encrypted` is true; tested with a real `https.createServer`
  and a self-signed cert generated at test time with `openssl`.
  `X-Forwarded-Proto` is deliberately not consulted (documented; no
  `protoHeaders` option). Fixed in 5a78dd9.
- **`toWebResponse()` threw for status 204, 205 and 304 given any body,
  even an empty one.** The `Response` constructor rejects bodies for
  null-body statuses, and the usual buffer-then-convert pattern hands it an
  empty `Buffer`. The body is now passed as `null` for those statuses.
  Fixed in c815bf0.
- **`writeWebResponse()` did not write `statusText`.** A non-empty
  `statusText` is now written as the HTTP reason phrase via
  `res.writeHead(status, statusText)`. Fixed in 59e87a3.

### Documentation

Fixed in 6ad5bea. Documented, with no behaviour change:

- trailers are dropped when the response has a `content-length` (HTTP
  requires chunked encoding for trailers);
- a `//host/path` or absolute-form request target overrides the Host header
  in `toWebRequest()`;
- hop-by-hop headers pass through `writeWebResponse()` (a proxy must strip
  them itself);
- the string / `Uint8Array` / `Readable` / `String()` body branches in
  `writeWebResponse()` exist only for duck-typed objects, because a real
  `Response` body is always a `ReadableStream`. The JSDoc and README no
  longer imply otherwise.

The README `Family` section is reworded to match reality: `leserve`
(published `0.1.0` depends on `^0.0.0`) is the consumer, `servant` reaches
this package only through it, published `dialback@0.0.3` does not depend on
it, and the remaining user is a private app.

`engines` stays at Node `>=26.0.0` (family policy). The suite is verified on
Node 26; on Node 24.9 `npm test` (`node --test test/`) does not start. The
README now says so.

### Tests

24 -> 36, none skipped. Each fix has a regression test that failed before it;
they use real `http`/`https` servers and clients. The IPv6 and https tests skip
loudly (a warning plus a skip reason) if `::1` or `openssl` is unavailable.

## [0.0.0] - 2026-09-28

Initial release. Extracted from `@johnhenry/leserve` (`toWebRequest`,
`toWebResponse`, and `writeWebResponse`'s logic, previously inlined in
`serve.mjs`) and a private app (`toNodeRequestOptions`, disentangled
from its `timed-fetch.mjs`'s own socket-timing instrumentation), once a real
independent duplicate of the first and third turned up in
`@johnhenry/dialback` — one with a genuine correctness gap (silently
dropped multi-value response headers). See README.md's Family section for
the full story and each consumer's specific relationship to this package.

### Added

- `toWebRequest(req, options?)` — Node inbound server request →
  Web `Request`. New `hostHeaders` option (not present in the original
  `leserve/node-request.mjs`) generalizes dialback's `X-Forwarded-Host`
  priority behavior into a reusable, opt-in list rather than a hardcoded
  special case.
- `toWebResponse(nodeRes, body?)` — Node outbound client response →
  Web `Response`.
- `writeWebResponse(response, res, options?)` — Web `Response` → written-out
  Node `ServerResponse`, including the `setTrailers`/`getTrailers` pair
  trailers depend on. New `onError` option makes the previously-hardcoded
  `console.error` on streaming-body failure overridable.
- `toNodeRequestOptions(requestOrUrl, options?)` — Web `Request`-shaped
  input → Node client `http.request()` options.
