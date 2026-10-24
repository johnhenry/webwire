import { toWebRequest } from "./to-web-request.mjs";
import { writeWebResponse } from "./write-web-response.mjs";

const plainResponse = (res, status, text) => {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(text);
};

/**
 * Wrap a fetch-style handler, `(request, info) => Response`, as a Node
 * `request` listener for `http.createServer()`, `https.createServer()` or
 * `http2.createServer()`/`createSecureServer()` (compatibility API).
 *
 * The listener composes `toWebRequest()` and `writeWebResponse()`:
 *
 * - a request whose URL `toWebRequest()` rejects (its tagged 400 error)
 *   gets a `400 Bad Request`, and is reported to `onError`;
 * - `request.signal` aborts when the client disconnects (the `res` is
 *   wired in for you);
 * - a handler that throws or rejects gets a `500 Internal Server Error`
 *   (reported to `onError`), unless the request was already aborted and
 *   the error is that abort -- the client is gone and nobody is waiting;
 * - a handler that returns something that isn't a response gets a 500;
 * - the returned `Response` is written with `writeWebResponse()`, which
 *   skips the body for HEAD and reports only real body errors.
 *
 * The handler's second argument is connection info, in the spirit of
 * Deno's `serve()` `info`, so handlers don't need `attachRaw`:
 * `{ remoteAddress, remotePort, localAddress, localPort, encrypted }`.
 *
 * @param {(request: Request, info: object) => Response | Promise<Response>} handler
 * @param {Object} [options]
 * @param {(error: Error) => void} [options.onError] - Called for a bad
 *   request URL, a handler error, or a response-body error. Defaults to
 *   `console.error`.
 * @param {string[]} [options.hostHeaders] - Passed to `toWebRequest()`.
 * @param {boolean} [options.attachRaw] - Passed to `toWebRequest()`.
 * @param {number} [options.bufferLimit] - Passed to `writeWebResponse()`.
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 */
export const toNodeListener = (handler, options = {}) => {
  const onError = options.onError ?? ((err) => console.error("Error handling request:", err));
  const { hostHeaders, attachRaw, bufferLimit } = options;

  return async (req, res) => {
    let request;
    try {
      request = toWebRequest(req, { hostHeaders, attachRaw, res });
    } catch (err) {
      onError(err);
      plainResponse(res, err?.status === 400 ? 400 : 500, err?.status === 400 ? "Bad Request" : "Internal Server Error");
      return;
    }

    const socket = req.socket ?? {};
    const info = {
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
      localAddress: socket.localAddress,
      localPort: socket.localPort,
      encrypted: Boolean(socket.encrypted),
    };

    let response;
    try {
      response = await handler(request, info);
    } catch (err) {
      // The client went away and the handler gave up because of it: not
      // an error anyone needs to hear about.
      if (request.signal.aborted && (err === request.signal.reason || err?.name === "AbortError")) {
        res.destroy();
        return;
      }
      onError(err);
      plainResponse(res, 500, "Internal Server Error");
      return;
    }

    if (
      response == null ||
      typeof response.status !== "number" ||
      (response.status !== 101 && typeof response.headers?.[Symbol.iterator] !== "function")
    ) {
      onError(new TypeError(`Handler did not return a Response (got ${response === null ? "null" : typeof response})`));
      plainResponse(res, 500, "Internal Server Error");
      return;
    }

    await writeWebResponse(response, res, { onError, method: req.method, bufferLimit });
  };
};

export default toNodeListener;
