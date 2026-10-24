export interface ToWebRequestOptions {
  /** Attach the original IncomingMessage as a non-enumerable `raw` property. */
  attachRaw?: boolean;
  /**
   * Header names to check, in priority order, for the request's host.
   * Defaults to ["host"]. Matched case-insensitively. A comma-chained value
   * ("a.com, b.com") is not split and throws an Error with `status = 400`.
   * The URL scheme is https: when `req.socket.encrypted` is true, else http:;
   * X-Forwarded-Proto is not consulted.
   */
  hostHeaders?: string[];
  /**
   * The matching ServerResponse. When given, `request.signal` also aborts
   * if the response closes before finishing (the client disconnected).
   * Without it the signal only aborts while the request body is still
   * arriving.
   */
  res?: import("http").ServerResponse | import("http2").Http2ServerResponse;
}

export declare function toWebRequest(
  req: import("http").IncomingMessage | import("http2").Http2ServerRequest,
  options?: ToWebRequestOptions
): Request;

export declare function toWebResponse(
  nodeRes: import("http").IncomingMessage,
  body?: BodyInit | null
): Response;

export interface WriteWebResponseOptions {
  /**
   * Called (not thrown) when the response body fails. Client disconnects
   * are not reported. Defaults to console.error.
   */
  onError?: (error: Error) => void;
  /** Request method; HEAD skips (cancels) the body. Defaults to `res.req?.method`. */
  method?: string;
  /**
   * Buffer up to this many bytes of a streamed body; if it ends within the
   * limit, send it with `content-length` instead of chunked. Default 0 (off).
   */
  bufferLimit?: number;
}

export declare function writeWebResponse(
  response: Response | { status: 101 },
  res: import("http").ServerResponse | import("http2").Http2ServerResponse,
  options?: WriteWebResponseOptions
): Promise<void>;

export interface NodeListenerInfo {
  remoteAddress: string | undefined;
  remotePort: number | undefined;
  localAddress: string | undefined;
  localPort: number | undefined;
  encrypted: boolean;
}

export interface ToNodeListenerOptions {
  /** Called for a bad request URL (400), a handler error (500) or a body error. Defaults to console.error. */
  onError?: (error: Error) => void;
  hostHeaders?: string[];
  attachRaw?: boolean;
  bufferLimit?: number;
}

export declare function toNodeListener(
  handler: (request: Request, info: NodeListenerInfo) => Response | { status: 101 } | Promise<Response | { status: 101 }>,
  options?: ToNodeListenerOptions
): (
  req: import("http").IncomingMessage | import("http2").Http2ServerRequest,
  res: import("http").ServerResponse | import("http2").Http2ServerResponse
) => Promise<void>;

export interface ToNodeRequestOptionsInit {
  method?: string;
  headers?: HeadersInit;
}

export interface NodeRequestOptions {
  url: URL;
  isHTTPS: boolean;
  requestOptions: {
    hostname: string;
    port: number;
    path: string;
    method: string;
    headers: Record<string, string | string[]>;
  };
}

export declare function toNodeRequestOptions(
  requestOrUrl: Request | string | URL,
  options?: ToNodeRequestOptionsInit
): NodeRequestOptions;

export declare function setTrailers(
  response: Response,
  trailers: HeadersInit | Promise<HeadersInit>
): void;

export declare function getTrailers(
  response: Response
): Promise<HeadersInit> | undefined;
