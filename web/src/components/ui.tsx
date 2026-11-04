import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/client';
import type { OrderStatus } from '../api/types';
import { Icon, type IconName } from './Icon';

/* ---------- Page header ---------- */
export function PageHeader({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1 className="h2">{title}</h1>
        {lead && <p className="lead">{lead}</p>}
      </div>
      {actions && <div className="row gap-sm wrap">{actions}</div>}
    </header>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="btn btn-soft btn-sm" style={{ alignSelf: 'flex-start', marginBottom: 'var(--space-lg)' }}>
      <Icon name="arrowLeft" size={16} />
      {children}
    </Link>
  );
}

/* ---------- Form fields ---------- */
interface FieldProps {
  label: string;
  error?: string[];
  hint?: ReactNode;
  className?: string;
}

function FieldShell({
  label,
  error,
  hint,
  className,
  id,
  children,
}: FieldProps & { id: string; children: ReactNode }) {
  const invalid = Boolean(error?.length);
  return (
    <div className={`field ${invalid ? 'field-invalid' : ''} ${className ?? ''}`}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children}
      {invalid ? (
        <div className="field-error" id={`${id}-error`}>
          <Icon name="alert" size={14} />
          <span>{error!.join(' ')}</span>
        </div>
      ) : (
        hint && <div className="field-hint">{hint}</div>
      )}
    </div>
  );
}

export function TextField({ label, error, hint, className, ...input }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const invalid = Boolean(error?.length);
  return (
    <FieldShell label={label} error={error} hint={hint} className={className} id={id}>
      <input
        id={id}
        className="input"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        {...input}
      />
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  error,
  hint,
  className,
  ...input
}: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const invalid = Boolean(error?.length);
  return (
    <FieldShell label={label} error={error} hint={hint} className={className} id={id}>
      <textarea
        id={id}
        className="textarea"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        {...input}
      />
    </FieldShell>
  );
}

/* ---------- Status ---------- */
export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span className={`badge status-${status.toLowerCase()}`}>
      <span className="badge-dot" />
      {status}
    </span>
  );
}

/* ---------- Notices ---------- */
export function Notice({
  icon = 'info',
  title,
  children,
  tone = 'soft',
}: {
  icon?: IconName;
  title?: ReactNode;
  children?: ReactNode;
  tone?: 'soft' | 'error';
}) {
  return (
    <div className={`notice ${tone === 'error' ? 'notice-error' : ''}`} role={tone === 'error' ? 'alert' : undefined}>
      <Icon name={icon} size={18} />
      <div className="stack gap-xxs">
        {title && <div className="notice-title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

/** Shows any API error in plain words, with the status code for the curious. */
export function ProblemNotice({ error }: { error: unknown }) {
  if (!error) return null;
  if (error instanceof ApiError) {
    const { status, problem } = error;
    return (
      <Notice tone="error" icon="alert" title={problem.title ?? 'Something went wrong.'}>
        {problem.detail && <span>{problem.detail} </span>}
        <span className="muted">({status})</span>
      </Notice>
    );
  }
  return (
    <Notice tone="error" icon="alert" title="Could not reach the server.">
      Check that the API is running (docker compose up) and try again.
    </Notice>
  );
}

/* ---------- Empty and full-page states ---------- */
export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="squircle squircle-soft" style={{ width: 64, height: 64 }}>
        <Icon name={icon} size={28} />
      </span>
      <h2 className="h4">{title}</h2>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

/** A 403/404 from the API rendered as a page, instead of a broken screen. */
export function ErrorPage({ error, notFoundTitle, notFoundText }: { error: unknown; notFoundTitle?: string; notFoundText?: string }) {
  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        icon="search"
        title={notFoundTitle ?? 'Not found.'}
        action={
          <Link to="/" className="btn btn-primary">
            Back to the shop
          </Link>
        }
      >
        {notFoundText ?? error.problem.detail}
      </EmptyState>
    );
  }
  if (error instanceof ApiError && error.status === 403) {
    return (
      <EmptyState icon="lock" title="You don’t have access to this." action={<Link to="/" className="btn btn-primary">Back to the shop</Link>}>
        {error.problem.detail ?? 'Your account is not allowed to open this page.'}
      </EmptyState>
    );
  }
  return <ProblemNotice error={error} />;
}

/* ---------- Pagination ---------- */
export function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  if (totalPages <= 1) return null;
  return (
    <nav className="pagination" aria-label="Pagination">
      <button type="button" className="btn btn-soft btn-icon" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page">
        <Icon name="chevronLeft" />
      </button>
      <span className="body-sm muted tabular" style={{ minWidth: 110, textAlign: 'center' }}>
        Page <span className="strong" style={{ color: 'var(--color-ink)' }}>{page}</span> of {totalPages}
      </span>
      <button type="button" className="btn btn-soft btn-icon" disabled={page >= totalPages} onClick={() => onChange(page + 1)} aria-label="Next page">
        <Icon name="chevronRight" />
      </button>
    </nav>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="row gap-xs muted" role="status">
      <span className="spinner" />
      <span className="body-sm">{label}…</span>
    </span>
  );
}
