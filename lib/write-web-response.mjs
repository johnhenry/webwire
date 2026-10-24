import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getTrailers } from "./trailers.mjs";

// Statuses that never carry a body (RFC 9110). A real `Response` can't be
// built with a body for 204/205/304, but a duck-typed object can.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

const cancelBody = async (body) => {
  try {
    if (body instanceof ReadableStream) await body.cancel();
    else if (typeof body?.destroy === "function") body.destroy();
  } catch {
    // Already locked/errored: nothing more to release.
  }
};

/**
 * Write a Web API `Response` out through a Node.js `http`/`https` server's
 * `ServerResponse`.
 *
 * Handles: status (and `statusText`, written as the HTTP reason phrase when
 * non-empty), multi-value headers (`Set-Cookie` isn't comma-joined by
 * the Fetch spec, so same-named headers are collected and handed to Node as
 * an array rather than overwriting each other one `setHeader()` call at a
 * time), trailers (via `setTrailers()`/`getTrailers()` -- Fetch `Response`
 * has no native trailers concept), and the body. A real `Response`'s
 * `.body` is always a `ReadableStream` (or `null`), and that is the path a
 * real `Response` takes. The `string`, `Uint8Array`, Node `Readable` and
 * `String()` fallback branches exist only for duck-typed response-like
 * objects (e.g. `{ status, headers, body: "text" }`); a real `Response`
 * never reaches them.
 *
 * Body handling:
 *
 * - For a HEAD request (`options.method`, else `res.req.method`) and for
 *   status 204/205/304 the body is cancelled, not read.
 * - If the client disconnects mid-body, the body is cancelled and nothing
 *   is reported: a client abort is not an error. `onError` is only called
 *   for failures of the body itself.
 * - If the body fails before any byte has been written (headers not yet
 *   sent), a plain `500 Internal Server Error` is sent instead. After that
 *   point the connection is destroyed rather than left half-written.
 * - With `options.bufferLimit` > 0, a body that ends within that many
 *   bytes (or one whose size is already known, for duck-typed string/bytes
 *   bodies) is sent with a `content-length` instead of chunked encoding,
 *   unless the response already has one or carries trailers.
 *
 * Caveats: trailers are silently dropped when the response has a
 * `content-length` header (HTTP requires chunked encoding for trailers).
 * Hop-by-hop headers (`connection`, `transfer-encoding`, `keep-alive`, ...)
 * are passed through untouched; a proxy must strip them itself.
 *
 * `response.status === 101` (WebSocket upgrade) is a special case: a real
 * `Response` can't actually hold status 101 at all (the Fetch spec's
 * constructor throws for any status outside [200, 599]), so a caller
 * signaling "this was a WebSocket upgrade, handled elsewhere" passes a
 * plain duck-typed `{ status: 101 }` object instead of a real `Response` --
 * writeWebResponse() returns immediately without touching `res`.
 *
 * Works with `node:http2` compatibility-API responses
 * (`Http2ServerResponse`) too; HTTP/2 has no reason phrase, so
 * `statusText` is not written there.
 *
 * @param {Response | { status: 101 }} response
 * @param {import('http').ServerResponse} res
 * @param {Object} [options]
 * @param {(error: Error) => void} [options.onError] - Called (not thrown)
 *   when the response body fails. Not called for client disconnects.
 *   Defaults to `console.error`.
 * @param {string} [options.method] - The request method, used to skip the
 *   body for HEAD. Defaults to `res.req?.method`.
 * @param {number} [options.bufferLimit=0] - Buffer up to this many bytes
 *   of a streamed body; if it ends within the limit, send it with a
 *   `content-length`. 0 (the default) streams chunked as soon as data
 *   arrives.
 * @returns {Promise<void>}
 */
export const writeWebResponse = async (response, res, options = {}) => {
  const onError = options.onError ?? ((err) => console.error("Error streaming response body:", err));
  const bufferLimit = options.bufferLimit > 0 ? options.bufferLimit : 0;

  // Skip writing for WebSocket upgrades (status 101) -- the socket has
  // already been handed off elsewhere.
  if (response.status === 101) {
    return;
  }

  const method = (options.method ?? res.req?.method ?? "").toUpperCase();
  const isHttp2 = res.stream !== undefined && typeof res.stream?.respond === "function";

  res.statusCode = response.status;

  const headersByName = new Map();
  for (const [key, value] of response.headers) {
    if (headersByName.has(key)) {
      headersByName.get(key).push(value);
    } else {
      headersByName.set(key, [value]);
    }
  }
  for (const [key, values] of headersByName) {
    res.setHeader(key, values.length === 1 ? values[0] : values);
  }

  // `statusMessage` is the HTTP reason phrase. Assigned rather than passed
  // to `writeHead()`, which would mark the headers as sent and rule out a
  // 500 if the body fails before its first byte. Left alone when empty so
  // Node's default phrase for the status is used. HTTP/2 has no reason
  // phrase.
  if (response.statusText && !isHttp2) {
    res.statusMessage = response.statusText;
  }

  // Trailers are only meaningful once the body is fully written, and
  // `res.addTrailers()` must run before `res.end()`. `finishOk()` is the
  // *success*-path completion for every body shape below -- separate from
  // error handling, which destroys the connection and deliberately does
  // not attempt to write trailers or call `res.end()` on an already-broken
  // stream.
  const trailersPromise = getTrailers(response);
  const finishOk = async (data) => {
    if (trailersPromise) {
      const trailers = await trailersPromise;
      // res.addTrailers() reads own-enumerable object keys -- a Headers
      // instance has none (its entries live behind an iterator, not plain
      // properties), so it must be converted to a plain object first or
      // every trailer silently vanishes.
      if (data !== undefined) res.write(data);
      res.addTrailers(Object.fromEntries(new Headers(trailers).entries()));
      res.end();
      return;
    }
    res.end(data);
  };
  const mayAddLength = bufferLimit > 0 && !trailersPromise && !res.hasHeader("content-length");

  const send500 = () => {
    for (const name of res.getHeaderNames()) res.removeHeader(name);
    res.statusCode = 500;
    if (!isHttp2) res.statusMessage = "Internal Server Error";
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("Internal Server Error");
  };

  const body = response.body;
  if (body == null) {
    await finishOk();
    return;
  }
  if (method === "HEAD" || NULL_BODY_STATUSES.has(response.status)) {
    await cancelBody(body);
    await finishOk();
    return;
  }

  // Known-size bodies (duck-typed objects only).
  if (
    typeof body === "string" ||
    body instanceof Uint8Array ||
    !(body instanceof ReadableStream || typeof body.pipe === "function")
  ) {
    const data =
      body instanceof Uint8Array ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : Buffer.from(String(body));
    if (mayAddLength) res.setHeader("content-length", data.byteLength);
    await finishOk(data);
    return;
  }

  // Streamed bodies: a real Response's ReadableStream, or a duck-typed
  // Node Readable (converted so both take one path).
  let reader;
  try {
    reader = (body instanceof ReadableStream ? body : Readable.toWeb(body)).getReader();
  } catch (err) {
    // e.g. a body that was already read (locked).
    onError(err);
    send500();
    return;
  }

  // A client disconnect cancels the reader, which also unblocks a pending
  // read() on a slow body.
  let clientGone = false;
  const onClose = () => {
    if (!(res.writableFinished ?? res.finished)) {
      clientGone = true;
      reader.cancel().catch(() => {});
    }
  };
  res.once("close", onClose);
  if (res.destroyed) onClose();

  const toBuffer = (chunk) =>
    typeof chunk === "string"
      ? Buffer.from(chunk)
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

  let sourceError;
  const read = async () => {
    try {
      return await reader.read();
    } catch (err) {
      sourceError = err;
      throw err;
    }
  };

  const fail = (err) => {
    res.off("close", onClose);
    if (clientGone) return;
    onError(err);
    if (!res.headersSent && !res.destroyed) {
      // Nothing has reached the client yet: send a real error response.
      send500();
    } else {
      res.destroy(err);
    }
  };

  // Read ahead until the first non-empty chunk (so a body that fails
  // immediately can still become a 500), and while within bufferLimit.
  const head = [];
  let headBytes = 0;
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await read();
      if (done) {
        ended = true;
        break;
      }
      const chunk = toBuffer(value);
      if (chunk.byteLength === 0) continue;
      head.push(chunk);
      headBytes += chunk.byteLength;
      if (headBytes > bufferLimit) break;
    }
  } catch (err) {
    fail(err);
    return;
  }
  if (clientGone) {
    res.off("close", onClose);
    return;
  }

  if (ended) {
    res.off("close", onClose);
    if (mayAddLength) res.setHeader("content-length", headBytes);
    await finishOk(head.length ? Buffer.concat(head) : undefined);
    return;
  }

  async function* rest() {
    yield Buffer.concat(head);
    for (;;) {
      const { done, value } = await read();
      if (done) return;
      yield toBuffer(value);
    }
  }

  // `pipeline()` handles backpressure and destroys both sides on error.
  // `{ end: false }` (only supported by the Promise-returning
  // `stream/promises` version) so `finishOk()` controls `res.end()`,
  // giving trailers a chance to attach first.
  try {
    await pipeline(rest(), res, { end: false });
  } catch (err) {
    reader.cancel().catch(() => {});
    // An error that did not come from the body is the destination going
    // away (ERR_STREAM_PREMATURE_CLOSE, EPIPE, ...): a client abort.
    if (sourceError === undefined) clientGone = true;
    fail(sourceError ?? err);
    return;
  }
  res.off("close", onClose);
  if (clientGone) return;
  await finishOk();
};

export default writeWebResponse;
