import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (data: T) => void;
}

/** Runs a request when the dependencies change and keeps only the latest answer. */
export function useAsync<T>(load: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>();
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const call = ++latest.current;
    setLoading(true);
    setError(undefined);
    load()
      .then((result) => {
        if (call === latest.current) setData(result);
      })
      .catch((e) => {
        if (call === latest.current) setError(e);
      })
      .finally(() => {
        if (call === latest.current) setLoading(false);
      });
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, loading, reload, setData };
}
