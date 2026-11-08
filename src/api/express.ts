/**
 * UNVERIFIED: Express adapter. `express` is not installable in the build sandbox, so this file is excluded from
 * the typecheck (see tsconfig "exclude") and has never been executed. All behaviour lives in `createApi`, which has
 * 36 integration tests (tests/api.test.ts), including over real HTTP through the dependency-free adapter in
 * `server.ts`. This file only translates Express requests into `ApiRequest` and writes the `ApiResponse` back, and
 * must reproduce the same transport rules as server.ts: 256 KB body limit (413), JSON-only bodies (415), invalid JSON
 * (400), and JSON (never HTML) error bodies.
 *
 * Install on a networked machine:  npm i express && npm i -D @types/express
 * Then run the API tests against it by pointing tests/api.test.ts' real-HTTP case at createExpressApp (manual step).
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Api } from './app.ts';
import { errorResponse, ApiError } from './http.ts';

export function createExpressApp(api: Api): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false); // proxy trust is decided inside the API (TRUST_PROXY), not by Express
  app.use(express.json({ limit: '256kb', type: () => true, strict: true }));

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      const query: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string' && !(k in query)) query[k] = v;

      const hasBody = Number(headers['content-length'] ?? 0) > 0 || headers['transfer-encoding'] !== undefined;
      if (hasBody && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !(headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        throw new ApiError(415, 'unsupported_media_type', 'content-type must be application/json');
      }
      const body = req.body && typeof req.body === 'object' && Object.keys(req.body as object).length === 0 ? undefined : req.body;
      const out = await api.handle({ method: req.method, path: req.path, query, headers, body, remoteAddress: req.socket.remoteAddress ?? '' });
      res.status(out.status).set(out.headers).end(req.method === 'HEAD' ? undefined : out.body);
    } catch (err) {
      next(err);
    }
  });

  // Body-parser failures and anything thrown above. Always JSON, never an HTML stack page.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const type = (err as { type?: string } | null)?.type;
    const mapped =
      type === 'entity.too.large' ? new ApiError(413, 'payload_too_large', 'request body too large')
      : type === 'entity.parse.failed' ? new ApiError(400, 'invalid_json', 'request body is not valid JSON')
      : err;
    const out = errorResponse(mapped);
    res.status(out.status).set({ ...out.headers, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }).end(out.body);
  });
  return app;
}
