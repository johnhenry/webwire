# Agent playbook

`@johnhenry/webwire` — converts between Node.js's raw `http`/`https`
objects and the standard Web Fetch API (`Request`/`Response`). Single
package, Node >= 26, `node --test test/` (`npm test`), ships source
directly — no build step. Four small, dependency-free functions; see
README.md's table for which is which.

`CLAUDE.md` in this directory is a symlink to this file.

## The verification loop (before every push)

1. `npm test` — no test here should SKIP. Most tests spin up a real
   `http.createServer()`/`http.request()` pair rather than mocking Node's
   HTTP objects — real header/status/streaming semantics are exactly the
   thing this package exists to get right, and a mock that's wrong in the
   same way the code under test is wrong won't catch it.
2. `npm pack --dry-run` — read the file list, not just the exit code.
3. A genuinely fresh clone: `git clone . /tmp/webwire-verifyN && cd $_ && npm ci && npm test`.
4. Commit, push, close the issue with a comment naming the commit SHA.

## Repo-specific gotchas

- **A real `Response` cannot hold status 101.** The Fetch spec's
  constructor throws for any status outside `[200, 599]` — `new
  Response(null, { status: 101 })` throws immediately, it does not
  silently produce a weird Response. `writeWebResponse()`'s WebSocket-
  upgrade case expects a plain `Object.freeze({ status: 101 })` duck-typed
  object instead (matching `@johnhenry/leserve`'s own
  `WEBSOCKET_UPGRADE_RESPONSE` precedent) — don't "fix" a test or caller
  that does this by trying to construct a real `Response`; it can't be
  done.
- **When testing `toWebRequest()` against a real server, read the request
  body before responding, not after.** Responding first can race the
  client still sending its body over the same connection, especially over
  keep-alive — a test that reads `request.text()` after the client's
  response promise already resolved can flakily see an empty body. Read
  the body inside the request handler, store the result, assert on it
  after.
- **`toNodeRequestOptions()` returns plain data, not a live request.**
  Deliberate — callers (like `@johnhenry/prism`'s `timed-fetch.mjs`) need
  to attach their own socket-event hooks, pick `http` vs `https`, and write
  the body themselves. Don't fold request-issuing into this function; that
  would make it unusable for exactly the caller that motivated it.

## Definition of done

- `npm test` passes clean.
- A new function follows the existing four's shape: pure, no dependency on
  the others, real end-to-end test against a genuine `http.createServer`/
  `http.request` where the behavior being tested is about real Node HTTP
  object semantics (not just a unit test against a hand-built fake).
- README.md's API table and Family section updated for anything
  user-visible or that adds/changes a consumer relationship.

## Non-goals

- This package converts objects; it does not run a server or make
  requests on your behalf (`toNodeRequestOptions()` stops at "here are the
  options," it doesn't call `http.request()` itself) or provide routing,
  middleware, or a fetch-polyfill. That's `@johnhenry/leserve`
  (server) and whatever HTTP client abstraction a consumer wants to build
  on top of `toNodeRequestOptions()`.

## Releases

Bump `version` in `package.json` in a PR, add a `CHANGELOG.md` entry,
merge, then `gh release create v<version>` (fires
`.github/workflows/publish.yml`, gated on `npm test`).
