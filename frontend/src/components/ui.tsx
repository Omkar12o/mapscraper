/* ------------------------------------------------------------------ */
/* Design system — Lead Finder                                        */
/* Tokens:                                                            */
/*   Accent: brand-600 (blue)                                         */
/*   Spacing: 8px scale (p-2 = 8px, p-4 = 16px, p-6 = 24px)           */
/*   Radius: 12px (rounded-xl)                                        */
/*   Borders: thin slate-200 / dark: slate-700                        */
/*   Shadows: soft                                                    */
/* ------------------------------------------------------------------ */

import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ForwardedRef,
} from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  X,
} from 'lucide-react';

/* ================================================================== */
/* Button                                                             */
/* ================================================================== */

type ButtonProps = ComponentPropsWithoutRef<'button'> & {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  asChild?: boolean;
};

const variantClasses: Record<string, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm',
  secondary: 'bg-slate-100 text-slate-800 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700',
  outline: 'border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800',
  ghost: 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
};

const sizeClasses: Record<string, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'primary', size = 'md', loading, children, ...props }, ref) => {
    const base = 'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all disabled:opacity-60 disabled:pointer-events-none focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2';
    const v = variantClasses[variant];
    const s = sizeClasses[size];
    const load = loading ? 'pr-9' : '';
    return (
      <button ref={ref} disabled={loading} className={[base, v, s, load, className].filter(Boolean).join(' ')} {...props}>
        {loading && <span className="absolute left-3 flex items-center gap-1"><Loader className="w-4 h-4 animate-spin" /></span>}
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';

/* ================================================================== */
/* Input                                                              */
/* ================================================================== */

export function Input({ className = '', ...props }: ComponentPropsWithoutRef<'input'>) {
  return (
    <input
      {...props}
      className={`block w-full rounded-xl border px-4 py-3 text-sm outline-none transition-colors
        border-slate-300 bg-white text-slate-900 placeholder-slate-400
        focus:ring-2 focus:ring-brand-500 focus:border-brand-500
        dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:placeholder-slate-500
        ${className}`}
    />
  );
}

/* ================================================================== */
/* Select                                                             */
/* ================================================================== */

export function Select({ className = '', ...props }: ComponentPropsWithoutRef<'select'>) {
  return (
    <select
      {...props}
      className={`block w-full rounded-xl border px-4 py-3 text-sm outline-none transition-colors
        border-slate-300 bg-white text-slate-900
        focus:ring-2 focus:ring-brand-500 focus:border-brand-500
        dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100
        ${className}`}
    />
  );
}

/* ================================================================== */
/* Card                                                               */
/* ================================================================== */

type CardProps = { children: React.ReactNode; className?: string; padding?: 'none' | 'sm' | 'md' | 'lg' };

export function Card({ children, className = '', padding = 'md' }: CardProps) {
  const pad = { none: '', sm: 'p-4', md: 'p-6', lg: 'p-8' }[padding];
  return (
    <div className={`rounded-xl border border-slate-200 bg-white shadow-sm ${pad} dark:border-slate-700 dark:bg-slate-900 ${className}`}>
      {children}
    </div>
  );
}

/* ================================================================== */
/* Badge / Status pill                                                */
/* ================================================================== */

export type StatusVariant = 'done' | 'running' | 'partly' | 'failed' | 'stopped' | 'queued';

const statusStyles: Record<StatusVariant, { bg: string; border: string; text: string }> = {
  done: { bg: 'bg-green-50', border: 'border-green-200', text: 'text-green-700 dark:text-green-400' },
  running: { bg: 'bg-brand-50', border: 'border-brand-200', text: 'text-brand-700 dark:text-brand-400' },
  partly: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700 dark:text-amber-400' },
  failed: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700 dark:text-red-400' },
  stopped: { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700 dark:text-slate-400' },
  queued: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700 dark:text-amber-400' },
};

const statusLabels: Record<StatusVariant, string> = {
  done: 'Done',
  running: 'Running',
  partly: 'Partly done',
  failed: 'Failed',
  stopped: 'Stopped',
  queued: 'Queued',
};

export function Badge({
  children,
  variant = 'done',
  className = '',
  size = 'md',
}: {
  children?: React.ReactNode;
  variant?: StatusVariant;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const s = statusStyles[variant];
  const label = children ?? statusLabels[variant];
  const sz = size === 'sm' ? 'px-2.5 py-0.5 text-[10px]' : 'px-3 py-1 text-xs';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full font-medium border ${sz} ${s.bg} ${s.border} ${s.text} ${className}`}>
      {label}
    </span>
  );
}

/* ================================================================== */
/* Skeleton                                                           */
/* ================================================================== */

export function Skeleton({ className = '', h = '1em', w = '100%' }: { className?: string; h?: string; w?: string }) {
  return <div className={`animate-pulse rounded-xl bg-slate-200 dark:bg-slate-800 ${className}`} style={{ height: h, width: w }} />;
}

export function SkeletonRow({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center gap-3 py-2 ${className}`}>
      <Skeleton h="16px" w="20%" />
      <Skeleton h="16px" w="45%" />
      <Skeleton h="16px" w="30%" />
    </div>
  );
}

/* ================================================================== */
/* Empty state                                                        */
/* ================================================================== */

export function EmptyState({
  icon: Icon = SearchIcon,
  title,
  subtitle,
  action,
  className = '',
}: {
  icon?: React.ElementType;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900 ${className}`}>
      <div className="w-14 h-14 rounded-xl bg-brand-50 dark:bg-brand-900/20 flex items-center justify-center mx-auto mb-4">
        <Icon className="w-6 h-6 text-brand-600" />
      </div>
      <p className="text-slate-900 font-medium dark:text-slate-100">{title}</p>
      {subtitle && <p className="text-slate-500 text-sm mt-1 dark:text-slate-400">{subtitle}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

/* ================================================================== */
/* Table                                                              */
/* ================================================================== */

export function TableHeadCell({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <th scope="col" className={`px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider border-b border-slate-100 bg-slate-50 ${className} dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-400`}>
      {children}
    </th>
  );
}

export function TableBodyCell({ className = '', children }: { className?: string; children: React.ReactNode }) {
  return (
    <td className={`px-4 py-3 text-sm text-slate-700 border-b border-slate-100 ${className} dark:border-slate-800 dark:text-slate-300`}>
      {children}
    </td>
  );
}

export function Table({ children, className = '', minW }: { children: React.ReactNode; className?: string; minW?: string }) {
  return (
    <div className={`overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900 ${className}`}>
      <table className={`w-full text-left text-sm ${minW ? `min-w-[${minW}]` : 'min-w-full'}`}>
        {children}
      </table>
    </div>
  );
}

/* ================================================================== */
/* Toast system                                                       */
/* ================================================================== */

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

const toastIcons: Record<ToastType, React.ElementType> = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Bell,
  warning: AlertTriangle,
};

const toastColors: Record<ToastType, string> = {
  success: 'bg-green-50 border-green-200 text-green-800 dark:bg-green-900/20 dark:border-green-800 dark:text-green-300',
  error: 'bg-red-50 border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-800 dark:text-red-300',
  info: 'bg-brand-50 border-brand-200 text-brand-800 dark:bg-brand-900/20 dark:border-brand-800 dark:text-brand-300',
  warning: 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-900/20 dark:border-amber-800 dark:text-amber-300',
};

interface ToastContextType {
  toasts: Toast[];
  add: (toast: Omit<Toast, 'id'>) => void;
  remove: (id: string) => void;
}

const ToastContext = createContext<ToastContextType>({ toasts: [], add: () => {}, remove: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const add = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).slice(2, 9);
    const newToast: Toast = { id, duration: 5000, ...toast };
    setToasts((prev) => [...prev, newToast]);
    if (newToast.duration && newToast.duration > 0) {
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), newToast.duration);
    }
  }, []);

  const remove = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  return (
    <ToastContext.Provider value={{ toasts, add, remove }}>
      {children}
      <div className="fixed top-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => {
          const Icon = toastIcons[t.type];
          const color = toastColors[t.type];
          return (
            <div key={t.id} className={`pointer-events-auto flex w-full max-w-xs items-start gap-3 rounded-xl border p-4 shadow-lg ${color} animate-in fade-in slide-in-from-top-2 duration-300`}>
              <div className="shrink-0 mt-0.5"><Icon className="w-5 h-5" /></div>
              <div className="flex-1">
                <h4 className="font-semibold text-sm">{t.title}</h4>
                {t.message && <p className="text-xs text-opacity-80 mt-0.5">{t.message}</p>}
              </div>
              <button onClick={() => remove(t.id)} className="rounded-md p-1.5 text-opacity-60 hover:text-opacity-100 transition" aria-label="Dismiss">
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}

/* ================================================================== */
/* Confirm dialog                                                     */
/* ================================================================== */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, loading, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm"
        onClick={() => {
          if (!loading) onCancel();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-800"
      >
        <div className="flex items-start gap-3">
          <div
            className={`shrink-0 rounded-full p-2 ${
              danger
                ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400'
                : 'bg-brand-50 text-brand-600 dark:bg-brand-900/30 dark:text-brand-400'
            }`}
          >
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id="confirm-dialog-title" className="text-base font-semibold text-slate-900 dark:text-white">
              {title}
            </h3>
            {message && (
              <div className="mt-1.5 text-sm text-slate-600 dark:text-slate-400">{message}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50 dark:text-slate-500 dark:hover:bg-slate-700 dark:hover:text-slate-300"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-6 flex items-center justify-end gap-2">
          <Button variant="outline" size="md" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} size="md" onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Copy button                                                        */
/* ================================================================== */

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [value]);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  return (
    <button onClick={handleCopy} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-700 transition dark:hover:bg-slate-800 dark:text-slate-500 dark:hover:text-slate-300" title={copied ? 'Copied' : 'Copy'} aria-label="Copy">
      {copied ? <CheckCircle2 className="w-4 h-4 text-brand-600" /> : <Copy className="w-4 h-4" />}
    </button>
  );
}

/* ================================================================== */
/* Section header                                                     */
/* ================================================================== */

export function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h2 className="text-xl font-bold text-slate-900 dark:text-white">{title}</h2>
      {subtitle && <p className="text-slate-500 text-sm mt-1 dark:text-slate-400">{subtitle}</p>}
    </div>
  );
}

/* Minimal loader icon (avoid name clash with lucide Loader2) */
function Loader({ className }: { className?: string }) {
  return <svg className={`animate-spin h-5 w-5 ${className}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>;
}

function SearchIcon({ className }: { className?: string }) {
  return <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m21 21-5.197-5.197m0 0a7 7 0 11-9.9-9.9 7 7 0 019.9 9.9"></path></svg>;
}
