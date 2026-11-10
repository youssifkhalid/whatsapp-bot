import { useEffect, useState } from 'react';

/** Hash router: no server fallback rules needed, works behind any reverse proxy path. Routes look like #/logs?senderId=x */
export interface Route { path: string; params: Record<string, string> }

function parse(): Route {
  const raw = (typeof location === 'undefined' ? '' : location.hash).replace(/^#/, '') || '/';
  const [path = '/', query = ''] = raw.split('?');
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  return { path: path || '/', params };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function href(path: string, params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return `#${path}${s ? `?${s}` : ''}`;
}

export function navigate(path: string, params: Record<string, string | undefined> = {}): void {
  location.hash = href(path, params).slice(1);
}
