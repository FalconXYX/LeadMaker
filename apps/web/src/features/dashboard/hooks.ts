import { useCallback, useEffect, useRef, useState } from 'react';
import { safeStorage } from '@/lib/storage';

/** Current time, re-read every `intervalMs` (relative timestamps, timing badges that follow the clock). */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** A per-viewer preference kept in localStorage (falls back to memory when storage is unavailable). */
export function useStoredState<T extends string | boolean>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = safeStorage.getJson<T>(key);
    return stored !== null && typeof stored === typeof initial ? stored : initial;
  });
  const set = useCallback((v: T) => {
    setValue(v);
    safeStorage.setJson(key, v);
  }, [key]);
  return [value, set];
}

/** True once the element has scrolled near the viewport (always true without IntersectionObserver). */
export function useInView<E extends Element>(rootMargin = '120px'): [(el: E | null) => void, boolean] {
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((el: E | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    observer.current = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setInView(true);
        observer.current?.disconnect();
      }
    }, { rootMargin });
    observer.current.observe(el);
  }, [rootMargin]);
  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, inView];
}
