import { ZodError } from 'zod';

export interface ApiRequest {
  method: string;
  /** Path without query string, still percent-encoded. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  /** Parsed JSON body, or undefined when the request had none. */
  body: unknown;
  /** Socket peer address as seen by the adapter. */
  remoteAddress: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extraHeaders: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const json = (status: number, data: unknown, headers: Record<string, string> = {}): ApiResponse => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body: JSON.stringify(data),
});

export function errorResponse(err: unknown, onUnexpected?: (e: unknown) => void): ApiResponse {
  if (err instanceof ApiError) return json(err.status, { error: err.code, message: err.message }, err.extraHeaders);
  if (err instanceof ZodError) {
    return json(400, {
      error: 'validation_error',
      message: 'request validation failed',
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  onUnexpected?.(err);
  return json(500, { error: 'internal_error', message: 'unexpected server error' });
}
