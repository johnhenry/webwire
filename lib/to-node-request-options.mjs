/**
 * Convert a Web API `Request` (or a bare URL + Fetch-shaped options) into
 * the pieces needed to make the equivalent outbound call with Node's raw
 * `http.request()`/`https.request()` client API.
 *
 * This is the last of the four Node<->Web HTTP conversion directions:
 * inbound Node request -> Web `Request` (`toWebRequest`), outbound Node
 * client-response -> Web `Response` (`toWebResponse`), Web `Response` ->
 * written-out Node `ServerResponse` (`writeWebResponse`), and this one --
 * Web `Request`-shaped input -> Node client `http.request()` options.
 * Deliberately returns plain data (not a live request) so callers stay in
 * control of actually issuing the request, attaching socket-event hooks,
 * writing the body, etc. -- see `@johnhenry/prism`'s `timed-fetch.mjs` for
 * a real caller that layers per-socket timing instrumentation on top.
 *
 * @param {Request | string | URL} requestOrUrl - A `Request` object, or a
 *   bare URL to pair with `options` below (for callers that don't have a
 *   full `Request` handy -- mirrors `leserve`'s own two-call-shape
 *   ergonomics).
 * @param {Object} [options] - Only used when `requestOrUrl` is a bare URL.
 *   Ignored (a `Request` is already fully-formed) if `requestOrUrl` is a
 *   `Request`.
 * @param {string} [options.method="GET"]
 * @param {HeadersInit} [options.headers]
 * @returns {{
 *   url: URL,
 *   isHTTPS: boolean,
 *   requestOptions: { hostname: string, port: number, path: string, method: string, headers: Record<string, string> },
 * }}
 */
export const toNodeRequestOptions = (requestOrUrl, options = {}) => {
  const isRequest = requestOrUrl instanceof Request;
  const url = new URL(isRequest ? requestOrUrl.url : requestOrUrl);
  const method = isRequest ? requestOrUrl.method : options.method || "GET";
  const headersInit = isRequest ? requestOrUrl.headers : options.headers;

  // Node's `http.request()` wants a plain object, not a `Headers`
  // instance -- `Headers` entries live behind an iterator, not
  // own-enumerable properties, so handing one directly silently sends no
  // headers at all.
  const headers = {};
  if (headersInit) {
    new Headers(headersInit).forEach((value, key) => {
      headers[key] = value;
    });
  }

  const isHTTPS = url.protocol === "https:";

  return {
    url,
    isHTTPS,
    requestOptions: {
      // `URL#hostname` keeps IPv6 brackets ("[::1]"); `http.request()` wants
      // the bare address and tries to DNS-resolve the bracketed form.
      hostname: url.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: url.port ? Number(url.port) : isHTTPS ? 443 : 80,
      path: url.pathname + url.search,
      method,
      headers,
    },
  };
};

export default toNodeRequestOptions;
