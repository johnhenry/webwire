import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getTrailers } from "./trailers.mjs";

/**
 * Write a Web API `Response` out through a Node.js `http`/`https` server's
 * `ServerResponse`.
 *
 * Handles: status, multi-value headers (`Set-Cookie` isn't comma-joined by
 * the Fetch spec, so same-named headers are collected and handed to Node as
 * an array rather than overwriting each other one `setHeader()` call at a
 * time), trailers (via `setTrailers()`/`getTrailers()` -- Fetch `Response`
 * has no native trailers concept), and every body shape a handler might
 * return (string, `Uint8Array`, `ReadableStream`, a Node `Readable`, or
 * anything else via `String()`). Streaming-body errors are reported via
 * `onError` and the connection is destroyed rather than left half-written;
 * they are NOT rethrown, since by the time a stream errors the response has
 * already started (headers sent), so there's no response left to send an
 * error status on.
 *
 * `response.status === 101` (WebSocket upgrade) is a special case: a real
 * `Response` can't actually hold status 101 at all (the Fetch spec's
 * constructor throws for any status outside [200, 599]), so a caller
 * signaling "this was a WebSocket upgrade, handled elsewhere" passes a
 * plain duck-typed `{ status: 101 }` object instead of a real `Response` --
 * writeWebResponse() returns immediately without touching `res`.
 *
 * @param {Response | { status: 101 }} response
 * @param {import('http').ServerResponse} res
 * @param {Object} [options]
 * @param {(error: Error) => void} [options.onError] - Called (not thrown)
 *   if writing a streamed body fails after headers are already sent.
 *   Defaults to `console.error`.
 * @returns {Promise<void>}
 */
export const writeWebResponse = async (response, res, options = {}) => {
  const onError = options.onError ?? ((err) => console.error("Error streaming response body:", err));

  // Skip writing for WebSocket upgrades (status 101) -- the socket has
  // already been handed off elsewhere.
  if (response.status === 101) {
    return;
  }

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

  // Trailers are only meaningful once the body is fully written, and
  // `res.addTrailers()` must run before `res.end()`. `finishOk()` is the
  // *success*-path completion for every body shape below -- separate from
  // error handling, which destroys the connection and deliberately does
  // not attempt to write trailers or call `res.end()` on an already-broken
  // stream.
  const trailersPromise = getTrailers(response);
  const finishOk = async () => {
    if (trailersPromise) {
      const trailers = await trailersPromise;
      // res.addTrailers() reads own-enumerable object keys -- a Headers
      // instance has none (its entries live behind an iterator, not plain
      // properties), so it must be converted to a plain object first or
      // every trailer silently vanishes.
      res.addTrailers(Object.fromEntries(new Headers(trailers).entries()));
    }
    res.end();
  };

  if (response.body) {
    if (typeof response.body === "string") {
      res.write(response.body);
      await finishOk();
    } else if (response.body instanceof Uint8Array) {
      res.write(Buffer.from(response.body));
      await finishOk();
    } else if (response.body instanceof ReadableStream) {
      // `.pipe()` does not forward source errors to the destination -- if
      // the stream errors mid-response (e.g. an upstream fetch failing
      // after the response already started), the unhandled 'error' event
      // on the Readable crashes the whole process. `pipeline()` wires up
      // error propagation and destroys both sides for us. `{ end: false }`
      // (only supported by the Promise-returning `stream/promises` version
      // -- the callback version's last positional argument must be the
      // callback itself, not an options object) so `finishOk()` controls
      // `res.end()`, giving trailers a chance to attach first.
      try {
        await pipeline(Readable.fromWeb(response.body), res, { end: false });
        await finishOk();
      } catch (err) {
        onError(err);
        res.destroy(err);
      }
    } else if (typeof response.body.pipe === "function") {
      try {
        await pipeline(response.body, res, { end: false });
        await finishOk();
      } catch (err) {
        onError(err);
        res.destroy(err);
      }
    } else {
      res.write(String(response.body));
      await finishOk();
    }
  } else {
    await finishOk();
  }
};

export default writeWebResponse;
