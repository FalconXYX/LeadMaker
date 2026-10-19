import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '@/api/errors';
import { cn } from '@/lib/cn';

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  variant?: ToastVariant;
  /** ms; 0 keeps it until dismissed. Default 5000 (errors 8000). */
  duration?: number;
  action?: { label: string; onClick: () => void };
  /** Same id replaces an existing toast (e.g. repeated live updates). */
  id?: string;
}

interface ToastItem extends ToastOptions {
  id: string;
}

export interface ToastApi {
  (opts: ToastOptions): string;
  success: (title: ReactNode, description?: ReactNode) => string;
  info: (title: ReactNode, description?: ReactNode) => string;
  warning: (title: ReactNode, description?: ReactNode) => string;
  /** Pass a caught error to show its user-facing message. */
  error: (errOrTitle: unknown, description?: ReactNode) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => setItems((xs) => xs.filter((t) => t.id !== id)), []);

  const api = useMemo<ToastApi>(() => {
    const show = (opts: ToastOptions) => {
      const id = opts.id ?? `t${++seq}`;
      setItems((xs) => [...xs.filter((t) => t.id !== id), { ...opts, id }].slice(-4));
      return id;
    };
    const fn = show as ToastApi;
    fn.success = (title, description) => show({ title, description, variant: 'success' });
    fn.info = (title, description) => show({ title, description, variant: 'info' });
    fn.warning = (title, description) => show({ title, description, variant: 'warning' });
    fn.error = (err, description) =>
      show({
        title: typeof err === 'string' ? err : errorMessage(err),
        description,
        variant: 'error',
      });
    fn.dismiss = dismiss;
    return fn;
  }, [dismiss]);

  return (
    <ToastContext value={api}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions"
        className="pointer-events-none fixed top-16 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2.5"
      >
        {items.map((t) => <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />)}
      </div>
    </ToastContext>
  );
}

const ICONS = { success: CheckCircle2, error: AlertCircle, info: Info, warning: TriangleAlert };
const TONES = { success: 'text-success', error: 'text-danger', info: 'text-accent', warning: 'text-warning' };

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const variant = toast.variant ?? 'info';
  const duration = toast.duration ?? (variant === 'error' ? 8000 : 5000);
  const [paused, setPaused] = useState(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!duration || paused) return;
    const t = setTimeout(() => dismissRef.current(), duration);
    return () => clearTimeout(t);
  }, [duration, paused, toast]);

  const Icon = ICONS[variant];
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="pointer-events-auto flex gap-3 rounded-xl border border-border bg-surface p-4 shadow-lg animate-[lm-pop-in_140ms_ease-out]"
    >
      <Icon className={cn('mt-0.5 size-[18px] shrink-0', TONES[variant])} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-fg">{toast.title}</div>
        {toast.description && <div className="mt-0.5 text-sm text-muted">{toast.description}</div>}
        {toast.action && (
          <button
            type="button"
            className="mt-1.5 text-sm font-semibold text-accent hover:underline"
            onClick={() => {
              toast.action!.onClick();
              onDismiss();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification" className="-m-1 self-start rounded p-1 text-subtle hover:text-fg">
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/** const toast = useToast(); toast.success('Saved'); toast.error(err); toast({ title, action }). */
export function useToast(): ToastApi {
  const ctx = use(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
