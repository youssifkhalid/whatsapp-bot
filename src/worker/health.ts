import { createServer, type Server } from 'node:http';
import type { WorkerRuntime } from './runtime.ts';

/**
 * Tiny health endpoint for the worker. /healthz is liveness (used by Docker): it stays 200 while
 * WhatsApp is disconnected or waiting for a QR, so an unpaired worker is not restart-looped.
 * /readyz reports whether WhatsApp is connected. Neither endpoint leaks the QR or any config.
 */
export function startHealthServer(worker: WorkerRuntime, port: number, host = '127.0.0.1'): Promise<Server> {
  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    if (req.url === '/healthz') return send(worker.isLive() ? 200 : 503, { live: worker.isLive(), state: worker.getState() });
    if (req.url === '/readyz') return send(worker.isReady() ? 200 : 503, { ready: worker.isReady(), state: worker.getState() });
    return send(404, { error: 'not_found' });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
