import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Api } from './app.ts';
import { errorResponse, ApiError, type ApiRequest } from './http.ts';

const MAX_BODY = 256 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'payload_too_large', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Translate a Node request into the framework-agnostic ApiRequest. Throws ApiError on bad input. */
export async function toApiRequest(req: IncomingMessage): Promise<ApiRequest> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query: Record<string, string> = {};
  for (const [k, v] of url.searchParams) if (!(k in query)) query[k] = v;
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;

  let body: unknown;
  if (req.method && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const raw = await readBody(req);
    if (raw.length > 0) {
      const type = (headers['content-type'] ?? '').toLowerCase();
      if (!type.startsWith('application/json')) throw new ApiError(415, 'unsupported_media_type', 'content-type must be application/json');
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new ApiError(400, 'invalid_json', 'request body is not valid JSON');
      }
    }
  }
  return { method: req.method ?? 'GET', path: url.pathname, query, headers, body, remoteAddress: req.socket.remoteAddress ?? '' };
}

export function createHttpServer(api: Api): Server {
  const server = createServer(async (req, res: ServerResponse) => {
    let out;
    try {
      out = await api.handle(await toApiRequest(req));
    } catch (err) {
      out = await api.handle({ method: 'GET', path: '/__error__', query: {}, headers: {}, body: undefined, remoteAddress: '' }).catch(() => null);
      out = { ...(out ?? { headers: {} }), ...errorResponse(err) };
    }
    res.writeHead(out.status, out.headers);
    res.end(req.method === 'HEAD' ? undefined : out.body);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
