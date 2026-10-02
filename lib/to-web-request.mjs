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
 * @returns {Request}
 *
 * The URL scheme is `https:` when `req.socket.encrypted` is true (a real
 * `https.createServer()` request), otherwise `http:`. `X-Forwarded-Proto`
 * is NOT consulted -- behind a TLS-terminating proxy the URL is `http:`
 * unless you rebuild it yourself.
 *
 * `req.url` is resolved against the host above with `new URL()`, so a
 * `//host/path` request target or an absolute-form target
 * (`GET http://other.example/path`) overrides the Host header entirely.
 *
 * Throws an `Error` with `.status = 400` if the resulting URL is invalid.
 */
export const toWebRequest = (req, { attachRaw = false, hostHeaders = ["host"] } = {}) => {
  let host = "localhost";
  for (const name of hostHeaders) {
    // Node lower-cases incoming header names, so match case-insensitively.
    const value = req.headers[name.toLowerCase()];
    const first = Array.isArray(value) ? value[0] : value;
    if (first) {
      host = first;
      break;
    }
  }

  let url;
  try {
    url = new URL(req.url, `${req.socket?.encrypted ? "https" : "http"}://${host}`);
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

  const requestInit = {
    method: req.method,
    headers: req.headers,
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
