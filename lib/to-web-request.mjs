/**
 * Convert a Node.js `http`/`https` server-side `IncomingMessage` into a
 * standard Web API `Request`.
 *
 * @param {import('http').IncomingMessage} req
 * @param {Object} [options]
 * @param {boolean} [options.attachRaw=false] - If true, attach the original
 *   `IncomingMessage` to the returned `Request` as a non-enumerable `raw`
 *   property (e.g. so middleware can reach the underlying socket for
 *   WebSocket upgrades).
 * @param {string[]} [options.hostHeaders=["host"]] - Header names to check,
 *   in priority order, for the host used to build an absolute URL from
 *   `req.url` (which Node hands you as a relative path). The first present
 *   header wins; falls back to `"localhost"` if none are set. Names are
 *   matched case-insensitively (they are lower-cased internally, because
 *   Node lower-cases incoming header names). A reverse proxy typically
 *   wants `["x-forwarded-host", "host"]` so it reflects the original
 *   client-facing host, not its own. A comma-chained value such as
 *   `X-Forwarded-Host: a.com, b.com` is not split: it is not a valid host,
 *   so the call throws the tagged 400 error described below.
 * @param {import('http').ServerResponse} [options.res] - The matching
 *   `ServerResponse`. When given, `request.signal` also aborts if the
 *   response closes before it finishes (the client disconnected). Without
 *   it, the signal only aborts while the request body is still arriving
 *   -- for a GET (no body) that window is already over, so pass `res` if
 *   you want to cancel slow work when the client goes away.
 * @returns {Request}
 *
 * `request.signal` is always a live signal: it aborts (with an
 * `AbortError` `DOMException`) when the request is aborted before its
 * body is complete, or -- with `options.res` -- when the response closes
 * before finishing.
 *
 * Headers are built from `req.rawHeaders` (falling back to `req.headers`),
 * so repeated headers such as an inbound `Set-Cookie` stay separate
 * (`request.headers.getSetCookie()` returns each) instead of being
 * collapsed into one comma-joined value by Node. HTTP/2 pseudo-headers
 * (`:method`, `:path`, ...) and symbol keys are dropped.
 *
 * `node:http2` compatibility-API requests (`Http2ServerRequest`) work too:
 * the host falls back to `:authority` when no `hostHeaders` header is
 * present, and the scheme comes from `:scheme` (`http` or `https`).
 *
 * The URL scheme is `https:` when `req.socket.encrypted` is true (a real
 * `https.createServer()` request), otherwise `http:` (for HTTP/2, the
 * `:scheme` pseudo-header). `X-Forwarded-Proto`
 * is NOT consulted -- behind a TLS-terminating proxy the URL is `http:`
 * unless you rebuild it yourself.
 *
 * `req.url` is resolved against the host above with `new URL()`, so a
 * `//host/path` request target or an absolute-form target
 * (`GET http://other.example/path`) overrides the Host header entirely.
 *
 * Throws an `Error` with `.status = 400` if the resulting URL is invalid.
 */
const isPseudoOrSymbol = (name) => typeof name !== "string" || name.startsWith(":");

const buildHeaders = (req) => {
  const headers = new Headers();
  const raw = req.rawHeaders;
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (!isPseudoOrSymbol(raw[i])) headers.append(raw[i], raw[i + 1]);
    }
    return headers;
  }
  // No rawHeaders (a hand-built IncomingMessage-like object): fall back to
  // `req.headers`. Object.keys() skips symbol keys such as http2's
  // Symbol(sensitiveHeaders).
  for (const name of Object.keys(req.headers ?? {})) {
    if (isPseudoOrSymbol(name)) continue;
    const value = req.headers[name];
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
};

const firstValue = (value) => (Array.isArray(value) ? value[0] : value);

export const toWebRequest = (req, { attachRaw = false, hostHeaders = ["host"], res } = {}) => {
  const reqHeaders = req.headers ?? {};
  let host;
  for (const name of hostHeaders) {
    // Node lower-cases incoming header names, so match case-insensitively.
    const first = firstValue(reqHeaders[name.toLowerCase()]);
    if (first) {
      host = first;
      break;
    }
  }
  // HTTP/2 carries the host in the :authority pseudo-header.
  host ??= firstValue(reqHeaders[":authority"]) || "localhost";

  const h2Scheme = firstValue(reqHeaders[":scheme"]);
  const scheme =
    h2Scheme === "http" || h2Scheme === "https"
      ? h2Scheme
      : req.socket?.encrypted
        ? "https"
        : "http";

  let url;
  try {
    url = new URL(req.url, `${scheme}://${host}`);
  } catch (cause) {
    // `req.url` comes straight off the wire -- a client can send a
    // request-target that survives Node's HTTP parser but isn't a valid
    // URL (e.g. an absolute-form target with malformed IPv6 brackets).
    // Without this, `new URL()` throws synchronously *outside* of
    // callers' try/catch (they call this before entering their request
    // try block), which crashes the whole process on a single bad
    // request. Tag the error so callers can turn it into a 400 instead.
    throw Object.assign(new Error(`Invalid request URL: ${req.url}`), {
      status: 400,
      cause,
    });
  }

  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new DOMException("The client disconnected", "AbortError"));
    }
  };
  // Node fires the request's 'close' as soon as its body has been consumed
  // (immediately, for a GET), so 'close' only means "aborted" while the
  // body is still incomplete. After that, only the response can tell us
  // the client went away.
  if (typeof req.once === "function") {
    if (req.destroyed && !req.complete) abort();
    else req.once("close", () => { if (!req.complete) abort(); });
  }
  if (res && typeof res.once === "function") {
    const finished = () => res.writableFinished ?? res.finished;
    if (res.destroyed && !finished()) abort();
    else res.once("close", () => { if (!finished()) abort(); });
  }

  const requestInit = {
    method: req.method,
    headers: buildHeaders(req),
    signal: controller.signal,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    requestInit.body = req;
    requestInit.duplex = "half";
  }

  const request = new Request(url.toString(), requestInit);

  if (attachRaw) {
    Object.defineProperty(request, "raw", { value: req, enumerable: false });
  }

  return request;
};

export default toWebRequest;
