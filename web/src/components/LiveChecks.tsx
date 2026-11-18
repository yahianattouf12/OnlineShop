import type { ReactNode } from 'react';
import { exchange, type Exchange } from '../api/client';
import { Icon } from './Icon';
import { Notice } from './ui';

/*
 * Shared by the live checks pages (Inventory checks, Performance checks): each check calls the real API,
 * logs every request with its status and time, and shows the result.
 */

export interface Step {
  label: string;
  ex: Pick<Exchange, 'method' | 'url' | 'status'> & { statusText?: string };
  ms: number;
}

export interface Outcome {
  pass: boolean;
  summary: ReactNode;
  steps: Step[];
  /** The one response worth reading in full (e.g. the 409 refusal). */
  body?: unknown;
}

export type Body = Record<string, unknown> | null;
type Options = Parameters<typeof exchange>[1];

/** One request, timed and added to the log. The body is returned as an object (or null) for easy reading. */
export async function timed(log: Step[], label: string, path: string, options?: Options) {
  const started = performance.now();
  const ex = await exchange(path, options);
  log.push({ label, ex, ms: performance.now() - started });
  return { ...ex, body: (ex.body && typeof ex.body === 'object' ? ex.body : null) as Body };
}

export const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

export type Result = { running: boolean; outcome?: Outcome; error?: string };

export function ResultView({ result }: { result: Result }) {
  if (result.running) {
    return (
      <div className="check-result">
        <span className="row gap-xs body-sm muted">
          <span className="spinner" /> Running…
        </span>
      </div>
    );
  }
  if (result.error) {
    return (
      <div className="check-result">
        <Notice tone="error" icon="alert" title="Could not run this check.">
          {result.error}
        </Notice>
      </div>
    );
  }
  const { pass, summary, steps, body } = result.outcome!;
  return (
    <div className="check-result">
      <div className="row gap-sm wrap">
        <span className={`badge ${pass ? 'badge-ink' : 'badge-error'}`}>
          <Icon name={pass ? 'check' : 'alert'} size={14} />
          {pass ? 'Passed' : 'Unexpected result'}
        </span>
        <span className="body-sm">{summary}</span>
      </div>
      <ol className="list stack gap-xxs body-sm">
        {steps.map((s, i) => (
          <li key={i} className="row gap-xs wrap">
            <span className="mono">
              {s.ex.method} {s.ex.url} → <span className="strong">{s.ex.status || '—'}</span>
            </span>
            <span className="muted">
              {s.label} · {s.ms < 1000 ? `${Math.round(s.ms)} ms` : seconds(s.ms)}
            </span>
          </li>
        ))}
      </ol>
      {body != null && <pre className="code">{JSON.stringify(body, null, 2)}</pre>}
    </div>
  );
}
