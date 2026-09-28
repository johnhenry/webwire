/**
 * Convert a Node.js `http`/`https` client-response `IncomingMessage` into a
 * standard Web API `Response`.
 *
 * This is the response-side mirror of `toWebRequest()`: it converts the
 * response Node hands back when *making* an outbound request with
 * `http.request()`/`https.request()` -- i.e. the `res` in
 * `http.request(url, (res) => ...)` -- into a Web `Response`. This is the
 * shape a proxy or any other code that speaks to another server via Node's
 * client APIs needs in order to re-express that response using the Fetch
 * API.
 *
 * @param {import('http').IncomingMessage} nodeRes - The response object
 *   Node hands back from `http.request()`/`https.request()` (the `res` in
 *   `http.request(url, (res) => ...)`) -- a client-side response, not a
 *   server-side request.
 * @param {BodyInit | null} [body] - The response body. `toWebResponse()`
 *   does not read `nodeRes` itself -- `IncomingMessage` is a `Readable`,
 *   and the caller is best placed to decide whether to buffer it, stream it
 *   through unchanged, or transform it before handing it to the `Response`
 *   constructor. Pass a `Buffer`/`Uint8Array`/`string` for a buffered body,
 *   or omit it (or pass `null`) for a bodyless response.
 * @returns {Response}
 */
export const toWebResponse = (nodeRes, body) => {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeRes.headers)) {
    if (Array.isArray(value)) {
      value.forEach((v) => headers.append(key, v));
    } else if (value != null) {
      headers.set(key, value);
    }
  }

  return new Response(body, {
    status: nodeRes.statusCode,
    statusText: nodeRes.statusMessage,
    headers,
  });
};

export default toWebResponse;
