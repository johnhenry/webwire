# Changelog

All notable changes to this project will be documented in this file.

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
