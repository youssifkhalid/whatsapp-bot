/**
 * UNVERIFIED: Express adapter. `express` is not installable in the build sandbox, so this file is excluded from
 * the typecheck (see tsconfig "exclude") and has never been executed. The API itself (`createApi`) is
 * framework-agnostic and fully tested over real HTTP through `server.ts`; this adapter only translates
 * Express requests into `ApiRequest` and writes the `ApiResponse` back.
 *
 * Install on a networked machine:  npm i express && npm i -D @types/express
 */
import express, { type Request, type Response } from 'express';
import type { Api } from './app.ts';

export function createExpressApp(api: Api): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false); // proxy trust is decided inside the API (TRUST_PROXY), not by Express
  app.use(express.json({ limit: '256kb', type: 'application/json' }));

  app.use(async (req: Request, res: Response) => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string') query[k] = v;
    const out = await api.handle({
      method: req.method, path: req.path, query, headers,
      body: req.body && Object.keys(req.body as object).length > 0 ? req.body : undefined,
      remoteAddress: req.socket.remoteAddress ?? '',
    });
    res.status(out.status).set(out.headers).end(out.body);
  });
  return app;
}
