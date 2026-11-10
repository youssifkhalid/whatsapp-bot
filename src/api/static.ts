import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import type { ApiResponse } from './http.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serve the built dashboard. Path traversal is rejected, only regular files inside `root` are served,
 * and extension-less paths fall back to index.html (client-side routing).
 */
export function serveStatic(root: string, rawPath: string): ApiResponse | null {
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (path.includes('\0')) return null;
  const base = resolve(root);
  let target = resolve(base, `.${path.startsWith('/') ? path : `/${path}`}`);
  if (target !== base && !target.startsWith(base + sep)) return null;
  if (path.endsWith('/') || !extname(path)) target = resolve(base, 'index.html');
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  const ext = extname(target).toLowerCase();
  const type = TYPES[ext];
  if (!type) return null;
  const isIndex = target === resolve(base, 'index.html');
  return {
    status: 200,
    headers: {
      'content-type': type,
      'cache-control': isIndex ? 'no-cache' : 'public, max-age=3600',
    },
    body: readFileSync(target),
  };
}
