import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';

/** An optional link shown on the toast, e.g. "View cart". */
export interface ToastAction {
  label: string;
  to: string;
}

interface Toast {
  id: number;
  message: string;
  action?: ToastAction;
}

const ToastContext = createContext<(message: string, action?: ToastAction) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);

  const show = useCallback(
    (message: string, action?: ToastAction) => {
      const id = nextId.current++;
      setToasts((all) => [...all.slice(-2), { id, message, action }]);
      // A toast with a button stays a little longer, so there is time to use it.
      window.setTimeout(() => dismiss(id), action ? 6000 : 4000);
    },
    [dismiss],
  );

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.message}</span>
            {t.action && (
              <Link to={t.action.to} className="btn btn-toast-action btn-sm" onClick={() => dismiss(t.id)}>
                {t.action.label}
              </Link>
            )}
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <Icon name="x" size={16} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
