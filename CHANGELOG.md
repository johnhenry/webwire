# Changelog

All notable changes to this project will be documented in this file.

## [0.0.0] - 2026-09-28

Initial release. Extracted from `@johnhenry/leserve` (`toWebRequest`,
`toWebResponse`, and `writeWebResponse`'s logic, previously inlined in
`serve.mjs`) and `@johnhenry/prism` (`toNodeRequestOptions`, disentangled
from `timed-fetch.mjs`'s own socket-timing instrumentation), once a real
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
