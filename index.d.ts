export interface ToWebRequestOptions {
  /** Attach the original IncomingMessage as a non-enumerable `raw` property. */
  attachRaw?: boolean;
  /** Header names to check, in priority order, for the request's host. Defaults to ["host"]. */
  hostHeaders?: string[];
}

export declare function toWebRequest(
  req: import("http").IncomingMessage,
  options?: ToWebRequestOptions
): Request;

export declare function toWebResponse(
  nodeRes: import("http").IncomingMessage,
  body?: BodyInit | null
): Response;

export interface WriteWebResponseOptions {
  /** Called (not thrown) if writing a streamed body fails after headers are already sent. */
  onError?: (error: Error) => void;
}

export declare function writeWebResponse(
  response: Response | { status: 101 },
  res: import("http").ServerResponse,
  options?: WriteWebResponseOptions
): Promise<void>;

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
