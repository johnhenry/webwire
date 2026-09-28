/**
 * HTTP trailers aren't part of the Fetch `Response` model at all -- they're
 * an HTTP/1.1 chunked-transfer-specific concept the Fetch spec doesn't
 * represent, so there's no `response.trailers` to set. This is how a
 * handler attaches trailers to a `Response` it's returning; `writeWebResponse()`
 * checks for them after the body finishes streaming and transmits them via
 * Node's own `res.addTrailers()`.
 */
const pendingTrailers = new WeakMap();

/**
 * @param {Response} response
 * @param {HeadersInit | Promise<HeadersInit>} trailers - resolved after the
 *   body finishes, so a value computed *from* the streamed body (a running
 *   checksum, `Server-Timing`) can be passed as a Promise.
 */
export const setTrailers = (response, trailers) => {
  pendingTrailers.set(response, Promise.resolve(trailers));
};

/** @param {Response} response @returns {Promise<HeadersInit> | undefined} */
export const getTrailers = (response) => pendingTrailers.get(response);
