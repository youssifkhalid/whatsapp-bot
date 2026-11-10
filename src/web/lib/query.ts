import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiFailure } from './api.ts';

export interface QueryResult<T> {
  data: T | undefined;
  error: ApiFailure | undefined;
  /** True only while nothing has loaded yet for the current key. */
  loading: boolean;
  /** True while a request is in flight (including background refreshes). */
  fetching: boolean;
  refetch: () => Promise<void>;
}

const toFailure = (e: unknown) => (e instanceof ApiFailure ? e : new ApiFailure(0, 'unknown', e instanceof Error ? e.message : String(e)));

/**
 * Small data hook (stands in for React Query, which cannot be installed offline).
 * - refetches whenever `key` changes, keeping the previous data on screen meanwhile
 * - optional polling, paused while the tab is hidden
 * - drops responses that arrive out of order
 */
export function useQuery<T>(key: string | null, fn: () => Promise<T>, opts: { interval?: number } = {}): QueryResult<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiFailure | undefined>(undefined);
  const [fetching, setFetching] = useState(key !== null);
  const [loaded, setLoaded] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const run = useCallback(async () => {
    const id = ++seq.current;
    setFetching(true);
    try {
      const d = await fnRef.current();
      if (id !== seq.current) return;
      setData(d);
      setError(undefined);
      setLoaded(true);
    } catch (e) {
      if (id !== seq.current) return;
      setError(toFailure(e));
      setLoaded(true);
    } finally {
      if (id === seq.current) setFetching(false);
    }
  }, []);

  useEffect(() => {
    if (key === null) return undefined;
    void run();
    if (!opts.interval) return undefined;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void run();
    }, opts.interval);
    return () => clearInterval(t);
  }, [key, opts.interval, run]);

  return { data, error, loading: key !== null && !loaded, fetching, refetch: run };
}
