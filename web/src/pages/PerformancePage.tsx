import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import {
  benchmarkApi,
  type BenchmarkCase,
  type CaseId,
  type CasesResponse,
  type Comparison,
  type Metrics,
  type ProfileId,
  type ProofMode,
  type ProofResult,
  type Run,
  type RunDetails,
  type SavedResult,
} from '../api/benchmark';
import { Icon } from '../components/Icon';
import { CompareChart, LatencyChart, SERIES_COLORS, formatMs, type CompareSeries } from '../components/PerfCharts';
import { useToast } from '../components/Toasts';
import { EmptyState, Notice, PageHeader, ProblemNotice, Segmented, Spinner, TextField } from '../components/ui';
import { formatDateTime, timeAgo } from '../lib/format';
import { useAsync } from '../lib/useAsync';

/**
 * Requirement 3: measure, change one thing, measure again. Everything here goes through the benchmark
 * service (benchmark/), which runs the team's k6 workloads from api-tests/task3 and keeps their results.
 */

type Tab = 'run' | 'compare' | 'proofs' | 'history';
const TABS: { value: Tab; label: string }[] = [
  { value: 'run', label: 'Run' },
  { value: 'compare', label: 'Compare' },
  { value: 'proofs', label: 'Proofs' },
  { value: 'history', label: 'History' },
];

// The stages in api-tests/task3/README.md, in the order they are usually measured.
const SUGGESTED_LABELS = ['before', 'after-index', 'after-replica', 'after-redis', 'after-etag'];

const count = (value: number | null | undefined) => (value == null ? '—' : value.toLocaleString('en-US'));
const bytes = (value: number) => (value < 1024 ? `${Math.round(value)} B` : `${(value / 1024).toFixed(1)} KB`);
const seconds = (value: string) => Number.parseFloat(value) * (value.endsWith('m') ? 60 : 1);

function duration(totalSeconds: number) {
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

/** The service is not there at all (not started, or a website built before it existed). */
function serviceMissing(error: unknown) {
  if (!(error instanceof ApiError)) return true;
  return [502, 503, 504].includes(error.status) && !error.problem.detail;
}

export function PerformancePage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.some((t) => t.value === params.get('tab')) ? (params.get('tab') as Tab) : 'run';
  const setTab = (next: Tab) => {
    const search = new URLSearchParams(params);
    search.set('tab', next);
    setParams(search, { replace: true });
  };

  const health = useAsync(() => benchmarkApi.health(), []);
  const meta = useAsync(() => benchmarkApi.cases(), []);
  const up = health.data && typeof health.data === 'object' && health.data.status === 'ok';

  return (
    <main className="main">
      <PageHeader
        title="Performance."
        lead="Requirement 3: measure, change one thing, measure again. Each run sends 20 requests per second to the shop API with k6 and records p50, p95 and p99."
        actions={up ? <Segmented label="Section" options={TABS} value={tab} onChange={setTab} /> : undefined}
      />

      {health.loading && !health.data ? (
        <Spinner label="Looking for the benchmark service" />
      ) : !up || (health.error && serviceMissing(health.error)) ? (
        <ServiceDown stale={Boolean(health.data) && !up} onRetry={health.reload} />
      ) : health.error ? (
        <ProblemNotice error={health.error} />
      ) : meta.error ? (
        <ProblemNotice error={meta.error} />
      ) : !meta.data ? (
        <Spinner />
      ) : (
        <>
          {tab === 'run' && <RunTab meta={meta.data} runningRunId={health.data!.runningRunId} />}
          {tab === 'compare' && <CompareTab meta={meta.data} onRun={() => setTab('run')} />}
          {tab === 'proofs' && <ProofsTab />}
          {tab === 'history' && <HistoryTab meta={meta.data} />}
          <p className="caption muted" style={{ marginTop: 'var(--space-xl)' }}>
            {health.data!.k6} · calls {health.data!.appUrl} inside Docker · results in task3-results/, readable by{' '}
            <span className="mono">node api-tests/task3/report.mjs</span>
          </p>
        </>
      )}
    </main>
  );
}

function ServiceDown({ stale, onRetry }: { stale: boolean; onRetry: () => void }) {
  return (
    <div className="card stack gap-md">
      <Notice tone="error" icon="alert" title={stale ? 'This website was built before the benchmark service existed.' : 'The benchmark service isn’t running.'}>
        {stale
          ? 'Rebuild the website so it can reach the service.'
          : 'It runs only with the benchmark project, so the normal shop stays light. Start it from the project folder:'}
      </Notice>
      <pre className="code">
        {stale
          ? 'docker compose -p onlineshop-bench --profile benchmark up -d --build web benchmark'
          : `docker compose stop                 # free ports 8080 and 5432 if the normal shop is running
docker compose -p onlineshop-bench --profile benchmark up -d --build
node seed/benchmark-all.mjs 200000  # once: 200,000 orders and the benchmark product`}
      </pre>
      <button type="button" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}

/* ---------- Small pieces ---------- */

function RunStatusBadge({ status }: { status: Run['status'] }) {
  if (status === 'running') {
    return (
      <span className="badge badge-soft">
        <span className="spinner spinner-sm" />
        Running
      </span>
    );
  }
  if (status === 'passed') {
    return (
      <span className="badge badge-ink">
        <Icon name="check" size={14} />
        Passed
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="badge badge-error">
        <Icon name="alert" size={14} />
        Failed
      </span>
    );
  }
  return <span className="badge badge-outline">{status === 'cancelled' ? 'Cancelled' : 'Interrupted'}</span>;
}

// Two runs of the same code differ by a few percent: under this, a change is noise, not a result.
const NOISE_PERCENT = 3;

/** A latency change against the baseline: faster is good, slower is shown as an error. */
function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="caption muted">—</span>;
  if (Math.abs(value) < NOISE_PERCENT) {
    return (
      <span className="badge badge-soft" title={`Within ${NOISE_PERCENT}%: the normal difference between two runs`}>
        ≈ same ({value > 0 ? '−' : '+'}
        {Math.abs(value)}%)
      </span>
    );
  }
  return value > 0 ? (
    <span className="badge badge-ink" title={`${value}% less time than the baseline`}>
      −{value}% · faster
    </span>
  ) : (
    <span className="badge badge-error" title={`${-value}% more time than the baseline`}>
      +{-value}% · slower
    </span>
  );
}

function MetricLine({ metrics }: { metrics: Metrics }) {
  return (
    <span className="body-sm tabular">
      p50 <span className="strong">{formatMs(metrics.p50)}</span> · p95 <span className="strong">{formatMs(metrics.p95)}</span> · p99{' '}
      <span className="strong">{formatMs(metrics.p99)}</span> · {metrics.requestsPerSecond.toFixed(1)} req/s
    </span>
  );
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.max(0, Math.min(100, value * 100));
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      <span style={{ width: `${percent}%` }} />
    </div>
  );
}

function SectionTitle({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="row between wrap gap-sm">
      <div className="stack gap-xxs">
        <h2 className="title">{title}</h2>
        {children && <p className="body-sm muted">{children}</p>}
      </div>
      {actions && <div className="row gap-xs wrap">{actions}</div>}
    </div>
  );
}

/* ---------- Run ---------- */

function RunTab({ meta, runningRunId }: { meta: CasesResponse; runningRunId: string | null }) {
  const toast = useToast();
  const [productInput, setProductInput] = useState('');
  const [productId, setProductId] = useState('');
  const preflight = useAsync(() => benchmarkApi.preflight(productId || undefined), [productId]);
  const saved = useAsync(() => benchmarkApi.results(), []);

  const [password, setPassword] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<unknown>();

  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState<CaseId[] | null>(null);
  const [profile, setProfile] = useState<ProfileId>('standard');
  const [etag, setEtag] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<unknown>();
  const [watchId, setWatchId] = useState<string | null>(runningRunId);

  const labels = saved.data?.labels ?? [];
  const savedHere = new Set(Object.keys(labels.find((l) => l.label === label)?.cases ?? {}) as CaseId[]);
  const ready = (id: CaseId) => preflight.data?.cases[id]?.ready ?? false;
  const available = (id: CaseId) => ready(id) && !savedHere.has(id);
  // Until the person picks, every workload that can run is selected.
  const chosen = (selected ?? meta.cases.map((c) => c.id)).filter(available);
  const plan = meta.profiles[profile];
  const hasEtag = Boolean(preflight.data?.dataset.etag);

  // Suggest the first stage that has not been measured yet.
  const firstLabel = useRef(false);
  useEffect(() => {
    if (firstLabel.current || !saved.data) return;
    firstLabel.current = true;
    setLabel(SUGGESTED_LABELS.find((l) => !saved.data!.labels.some((s) => s.label === l)) ?? '');
  }, [saved.data]);

  const toggle = (id: CaseId) => {
    const current = selected ?? chosen;
    setSelected(current.includes(id) ? current.filter((c) => c !== id) : [...current, id]);
  };

  const logIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoggingIn(true);
    setLoginError(undefined);
    try {
      await benchmarkApi.customerSession(password);
      setPassword('');
      toast('Benchmark customer logged in.');
      preflight.reload();
    } catch (error) {
      setLoginError(error);
    } finally {
      setLoggingIn(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setStartError(undefined);
    try {
      const run = await benchmarkApi.start({
        label,
        cases: chosen,
        profile,
        etag: etag && chosen.includes('product-etag'),
        productId: productId || undefined,
      });
      setWatchId(run.id);
      toast(`Run “${run.label}” started.`);
    } catch (error) {
      setStartError(error);
    } finally {
      setStarting(false);
    }
  };

  const checks = preflight.data?.checks ?? [];
  const tiles = preflight.data && [
    { name: 'Orders', value: preflight.data.dataset.orders, expected: preflight.data.expected.orders },
    { name: 'Customer orders', value: preflight.data.dataset.customerOrders, expected: preflight.data.expected.customerOrders },
    { name: 'Product stock', value: preflight.data.dataset.productStock, expected: preflight.data.expected.productStock },
  ];

  return (
    <div className="stack gap-lg">
      {watchId && (
        <RunPanel
          key={watchId}
          id={watchId}
          meta={meta}
          onFinished={() => {
            saved.reload();
            preflight.reload();
          }}
          onClose={() => setWatchId(null)}
        />
      )}

      <section className="card stack gap-lg" aria-label="Before you run">
        <SectionTitle
          title="1. Check the data."
          actions={
            <button type="button" className="btn btn-soft btn-sm" onClick={preflight.reload} disabled={preflight.loading}>
              Check again
            </button>
          }
        >
          Every response is checked against the seeded fixtures, so a run on other data fails. This checks them first.
        </SectionTitle>

        {preflight.error ? (
          <ProblemNotice error={preflight.error} />
        ) : !preflight.data ? (
          <Spinner label="Checking the benchmark data" />
        ) : (
          <>
            <div className="perf-tiles">
              {tiles!.map((tile) => (
                <div key={tile.name} className={`stat-tile ${tile.value !== null && tile.value !== tile.expected ? 'stat-tile-bad' : ''}`}>
                  <span className="caption muted">{tile.name}</span>
                  <span className="stat-value">{count(tile.value)}</span>
                  <span className="caption muted">expected {count(tile.expected)}</span>
                </div>
              ))}
              <div className="stat-tile">
                <span className="caption muted">ETag</span>
                <span className="stat-value">{hasEtag ? 'Yes' : 'Not yet'}</span>
                <span className="caption muted mono" title={preflight.data.dataset.etag ?? undefined}>
                  {preflight.data.dataset.etag ? preflight.data.dataset.etag.slice(0, 18) : 'product-etag measures 200'}
                </span>
              </div>
            </div>

            <ul className="list stack gap-sm">
              {checks.map((check) => (
                <li key={check.id} className={`preflight-row preflight-${check.status}`}>
                  <span className="preflight-icon">
                    <Icon name={check.status === 'pass' ? 'check' : check.status === 'fail' ? 'alert' : 'info'} size={16} />
                  </span>
                  <div className="stack gap-xxs grow">
                    <span className="strong body-sm">{check.title}</span>
                    <span className="body-sm muted">{check.detail}</span>
                    {check.hint && <code className="mono caption">{check.hint}</code>}
                  </div>
                </li>
              ))}
            </ul>

            <div className="form-grid">
              <TextField
                label="Benchmark product"
                value={productInput}
                placeholder={preflight.data.productId ?? 'Not found'}
                onChange={(e) => setProductInput(e.target.value)}
                onBlur={() => setProductId(productInput.trim())}
                onKeyDown={(e) => e.key === 'Enter' && setProductId(productInput.trim())}
                hint={`Found by name (${preflight.data.expected.productName}). Paste another ID to override.`}
              />
              {preflight.data.customerReady ? (
                <div className="field">
                  <span className="field-label">Benchmark customer</span>
                  <span className="row gap-xs body-sm" style={{ minHeight: 'var(--control-height)' }}>
                    <Icon name="check" size={16} />
                    {preflight.data.customerEmail} is logged in.
                  </span>
                </div>
              ) : (
                <form className="stack gap-xs" onSubmit={logIn}>
                  <TextField
                    label="Benchmark customer password"
                    type="password"
                    autoComplete="off"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    hint={`For orders-customer. The seeder printed it for ${preflight.data.customerEmail}.`}
                  />
                  <button type="submit" className="btn btn-outline btn-sm" style={{ alignSelf: 'flex-start' }} disabled={!password || loggingIn}>
                    {loggingIn ? 'Logging in…' : 'Log in the customer'}
                  </button>
                  {loginError != null && <ProblemNotice error={loginError} />}
                </form>
              )}
            </div>
          </>
        )}
      </section>

      <section className="card stack gap-lg" aria-label="New run">
        <SectionTitle title="2. Run.">
          For each workload in turn: a {plan.warmup} warm-up that is not saved, then {plan.duration} measured. A saved result is never overwritten: one label
          per stage.
        </SectionTitle>

        <div className="form-grid">
          <div className="stack gap-xs">
            <TextField
              label="Label"
              value={label}
              maxLength={40}
              onChange={(e) => setLabel(e.target.value.trim())}
              placeholder="before"
              hint="Letters, numbers, - and _. Name the stage you just changed."
            />
            <div className="row gap-xs wrap" role="group" aria-label="Suggested labels">
              {SUGGESTED_LABELS.map((suggestion) => {
                const used = labels.some((l) => l.label === suggestion);
                return (
                  <button
                    key={suggestion}
                    type="button"
                    className="chip"
                    aria-pressed={label === suggestion}
                    onClick={() => setLabel(suggestion)}
                    title={used ? 'Has saved results' : undefined}
                  >
                    {used && <Icon name="check" size={12} />}
                    {suggestion}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="field">
            <span className="field-label">Length</span>
            <Segmented
              label="Length"
              options={[
                { value: 'standard', label: `Standard · ${meta.profiles.standard.warmup} + ${meta.profiles.standard.duration}` },
                { value: 'quick', label: `Quick · ${meta.profiles.quick.warmup} + ${meta.profiles.quick.duration}` },
              ]}
              value={profile}
              onChange={setProfile}
            />
            <span className="field-hint">Standard is the one to report. Only runs of the same length are compared.</span>
          </div>
        </div>

        <fieldset className="case-list">
          <legend className="field-label">Workloads</legend>
          {meta.cases.map((c) => {
            const reasons = preflight.data?.cases[c.id]?.reasons ?? [];
            const disabled = !available(c.id);
            return (
              <label key={c.id} className={`case-option ${disabled ? 'is-disabled' : ''}`}>
                <input type="checkbox" checked={chosen.includes(c.id)} disabled={disabled} onChange={() => toggle(c.id)} />
                <div className="stack gap-xxs grow">
                  <span className="row gap-xs wrap">
                    <span className="strong">{c.title}</span>
                    <span className="badge badge-soft">{c.layer}</span>
                  </span>
                  <span className="mono caption">{c.request}</span>
                  <span className="body-sm muted">{c.measures}</span>
                  {savedHere.has(c.id) ? (
                    <span className="caption strong">Already saved as “{label}”. Pick a new label to run it again.</span>
                  ) : (
                    reasons.length > 0 && (
                      <span className="caption text-error">
                        <Icon name="alert" size={12} /> {reasons.join(' ')}
                      </span>
                    )
                  )}
                </div>
                <span className="mono caption muted case-id">{c.id}</span>
              </label>
            );
          })}
        </fieldset>

        <label className={`row gap-xs body-sm ${!hasEtag || !chosen.includes('product-etag') ? 'muted' : ''}`}>
          <input type="checkbox" checked={etag} disabled={!hasEtag || !chosen.includes('product-etag')} onChange={(e) => setEtag(e.target.checked)} />
          Send the current ETag with product-etag (after ETags are implemented: every answer must be an empty 304)
        </label>

        {startError != null && <ProblemNotice error={startError} />}

        <div className="row between wrap gap-sm">
          <span className="body-sm muted">
            {chosen.length
              ? `${chosen.length} workload${chosen.length === 1 ? '' : 's'} · about ${duration(chosen.length * (plan.seconds + 3))} · ${meta.rate} requests per second`
              : 'Pick at least one workload that is ready.'}
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={start}
            disabled={starting || !label || chosen.length === 0 || Boolean(runningRunId && watchId === runningRunId)}
          >
            <Icon name="play" size={16} />
            {starting ? 'Starting…' : `Run “${label || '…'}”`}
          </button>
        </div>
      </section>
    </div>
  );
}

/** One run: its steps, live progress while it goes, and the latency of each second. */
function RunPanel({ id, meta, onFinished, onClose }: { id: string; meta: CasesResponse; onFinished?: () => void; onClose?: () => void }) {
  const toast = useToast();
  const run = useAsync(() => benchmarkApi.run(id), [id]);
  const [cancelling, setCancelling] = useState(false);
  const [chartCase, setChartCase] = useState<string | null>(null);
  const status = run.data?.status;
  const { reload } = run;

  useEffect(() => {
    if (status !== 'running') return;
    const timer = window.setInterval(reload, 1000);
    return () => window.clearInterval(timer);
  }, [status, reload]);

  const wasRunning = useRef(false);
  useEffect(() => {
    if (status === 'running') wasRunning.current = true;
    else if (status && wasRunning.current) {
      wasRunning.current = false;
      toast(status === 'passed' ? 'Run finished: every workload passed.' : `Run ${status}.`);
      onFinished?.();
    }
  }, [status, toast, onFinished]);

  if (run.error && !run.data) return <ProblemNotice error={run.error} />;
  if (!run.data) return <Spinner label="Loading the run" />;
  const r: RunDetails = run.data;
  const caseOf = (c: string) => meta.cases.find((x) => x.id === c);

  const stepSeconds = seconds(r.plan.warmup) + seconds(r.plan.duration);
  const doneSteps = r.steps.filter((s) => ['passed', 'failed', 'cancelled'].includes(s.status)).length;
  const inStep = r.live ? (r.live.phase === 'measure' ? seconds(r.plan.warmup) : 0) + r.live.elapsedSeconds : 0;
  const overall = (doneSteps * stepSeconds + Math.min(inStep, stepSeconds)) / (r.steps.length * stepSeconds);

  const withData = r.steps.filter((s) => r.timelines[s.case] || r.live?.case === s.case).map((s) => s.case);
  const shownCase = chartCase && withData.includes(chartCase as CaseId) ? chartCase : r.live?.case ?? withData[withData.length - 1] ?? null;
  const live = r.live && r.live.case === shownCase ? r.live : null;
  const points = live ? live.points : shownCase ? r.timelines[shownCase] ?? [] : [];

  const cancel = async () => {
    setCancelling(true);
    try {
      await benchmarkApi.cancel(r.id);
      reload();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Could not cancel the run.');
    } finally {
      setCancelling(false);
    }
  };

  return (
    <section className="card stack gap-lg" aria-label={`Run ${r.label}`}>
      <div className="row between wrap gap-sm">
        <div className="stack gap-xxs">
          <span className="row gap-sm wrap">
            <h2 className="title">Run “{r.label}”</h2>
            <RunStatusBadge status={r.status} />
          </span>
          <span className="caption muted">
            {r.profile === 'standard' ? 'Standard' : 'Quick'} · {r.plan.warmup} warm-up + {r.plan.duration} at {r.plan.rate}/s ·{' '}
            {r.etag ? 'with the current ETag · ' : ''}started {timeAgo(r.createdAt)} by {r.startedBy}
          </span>
        </div>
        <div className="row gap-xs">
          {r.status === 'running' && (
            <button type="button" className="btn btn-outline btn-sm" onClick={cancel} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel run'}
            </button>
          )}
          {onClose && r.status !== 'running' && (
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close this run" title="Close">
              <Icon name="x" size={16} />
            </button>
          )}
        </div>
      </div>

      {r.status === 'running' && <ProgressBar value={overall} label="Run progress" />}
      {r.error && (
        <Notice tone="error" icon="alert" title="The run stopped.">
          {r.error}
        </Notice>
      )}

      <ol className="list stack gap-xs">
        {r.steps.map((step) => {
          const current = r.live?.case === step.case ? r.live : null;
          const phaseSeconds = current ? seconds(current.phase === 'warmup' ? r.plan.warmup : r.plan.duration) : 0;
          return (
            <li key={step.case} className={`step-row step-${step.status}`}>
              <span className="step-icon" aria-hidden="true">
                {step.status === 'passed' ? (
                  <Icon name="check" size={14} />
                ) : step.status === 'failed' ? (
                  <Icon name="alert" size={14} />
                ) : step.status === 'warmup' || step.status === 'measuring' ? (
                  <span className="spinner spinner-sm" />
                ) : (
                  <span className="step-dot" />
                )}
              </span>
              <div className="stack gap-xxs grow">
                <span className="row between wrap gap-xs">
                  <span className="body-sm">
                    <span className="strong">{caseOf(step.case)?.title ?? step.case}</span> <span className="mono caption muted">{step.case}</span>
                  </span>
                  <span className="caption muted">
                    {current
                      ? `${current.phase === 'warmup' ? 'Warming up (not saved)' : 'Measuring'} · ${Math.min(Math.round(current.elapsedSeconds), phaseSeconds)} / ${phaseSeconds} s`
                      : { waiting: 'Waiting', skipped: 'Skipped', cancelled: 'Cancelled', passed: 'Saved', failed: 'Failed, not saved', warmup: 'Starting', measuring: 'Starting' }[step.status]}
                  </span>
                </span>
                {current && <ProgressBar value={current.elapsedSeconds / phaseSeconds} label={`${step.case} progress`} />}
                {step.metrics && step.status !== 'cancelled' && <MetricLine metrics={step.metrics} />}
                {step.error && <span className="caption text-error">{step.error}</span>}
              </div>
            </li>
          );
        })}
      </ol>

      {shownCase && (
        <div className="stack gap-sm">
          <div className="row between wrap gap-sm">
            <span className="body-sm">
              <span className="strong">Response time per second</span>{' '}
              <span className="muted">
                · {shownCase}
                {live ? (live.phase === 'warmup' ? ' · warm-up, live' : ' · live') : ''}
              </span>
            </span>
            {withData.length > 1 && (
              <Segmented
                label="Workload"
                options={withData.map((c) => ({ value: c, label: c }))}
                value={shownCase as CaseId}
                onChange={(value) => setChartCase(value)}
              />
            )}
          </div>
          <LatencyChart
            points={points}
            seconds={live ? seconds(live.phase === 'warmup' ? r.plan.warmup : r.plan.duration) : seconds(r.plan.duration)}
          />
        </div>
      )}
    </section>
  );
}

/* ---------- Compare ---------- */

function CompareTab({ meta, onRun }: { meta: CasesResponse; onRun: () => void }) {
  const toast = useToast();
  const saved = useAsync(() => benchmarkApi.results(), []);
  const labels = useMemo(() => saved.data?.labels.map((l) => l.label) ?? [], [saved.data]);
  const [baselineChoice, setBaselineChoice] = useState('');
  const [picked, setPicked] = useState<string[] | null>(null);

  const baseline = labels.includes(baselineChoice) ? baselineChoice : labels.includes('before') ? 'before' : labels[0] ?? '';
  const others = labels.filter((l) => l !== baseline);
  const comparisons = (picked ?? others).filter((l) => others.includes(l));
  const compare = useAsync(
    () => (baseline ? benchmarkApi.compare(baseline, comparisons) : Promise.resolve(null)),
    [baseline, comparisons.join(',')],
  );
  // A label keeps its color whatever else is shown, so the same stage looks the same in every chart.
  const colorOf = (label: string) => SERIES_COLORS[Math.max(0, labels.indexOf(label)) % SERIES_COLORS.length];

  if (saved.error) return <ProblemNotice error={saved.error} />;
  if (!saved.data) return <Spinner label="Loading the results" />;
  if (!labels.length) {
    return (
      <EmptyState
        icon="search"
        title="No results yet."
        action={
          <button type="button" className="btn btn-primary" onClick={onRun}>
            Run the “before” measurements
          </button>
        }
      >
        Measure first, then change one thing, then measure again under a new label.
      </EmptyState>
    );
  }

  const copyMarkdown = async () => {
    if (!compare.data) return;
    const head = `| Workload | Metric | ${[compare.data.baseline, ...compare.data.labels].join(' | ')} |`;
    const lines = [head, `|${' --- |'.repeat(compare.data.labels.length + 3)}`];
    for (const row of compare.data.cases) {
      if (!row.baseline && row.comparisons.every((c) => !c.result)) continue;
      for (const metric of ['p50', 'p95', 'p99'] as const) {
        const cells = [
          row.baseline?.metrics ? formatMs(row.baseline.metrics[metric]) : '—',
          ...row.comparisons.map((c) =>
            c.result?.metrics ? `${formatMs(c.result.metrics[metric])}${c.change?.[metric] != null ? ` (${c.change[metric]! > 0 ? '−' : '+'}${Math.abs(c.change[metric]!)}%)` : ''}` : '—',
          ),
        ];
        lines.push(`| ${row.case} | ${metric} | ${cells.join(' | ')} |`);
      }
      const rps = [row.baseline, ...row.comparisons.map((c) => c.result)].map((r) => (r?.metrics ? r.metrics.requestsPerSecond.toFixed(1) : '—'));
      lines.push(`| ${row.case} | requests/s | ${rps.join(' | ')} |`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      toast('Copied the comparison as a Markdown table.');
    } catch {
      toast('Could not copy: the browser blocked the clipboard.');
    }
  };

  return (
    <div className="stack gap-lg">
      <section className="card stack gap-md" aria-label="What to compare">
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor="baseline">
              Baseline
            </label>
            <select id="baseline" className="select" value={baseline} onChange={(e) => setBaselineChoice(e.target.value)}>
              {labels.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
            <span className="field-hint">Usually “before”: the numbers every change is measured against.</span>
          </div>
          <div className="field">
            <span className="field-label">Compare with</span>
            <div className="row gap-xs wrap" role="group" aria-label="Compare with">
              {others.length === 0 && <span className="body-sm muted">Only one label so far. Run another stage to compare.</span>}
              {others.map((l) => (
                <button
                  key={l}
                  type="button"
                  className="chip"
                  aria-pressed={comparisons.includes(l)}
                  onClick={() => setPicked(comparisons.includes(l) ? comparisons.filter((x) => x !== l) : [...comparisons, l])}
                >
                  <span className="chart-key-square" style={{ background: colorOf(l) }} />
                  {l}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="row gap-xs wrap">
          <button type="button" className="btn btn-soft btn-sm" onClick={saved.reload}>
            Refresh
          </button>
          <button type="button" className="btn btn-outline btn-sm" onClick={copyMarkdown} disabled={!compare.data}>
            Copy as a Markdown table
          </button>
        </div>
      </section>

      {compare.error ? (
        <ProblemNotice error={compare.error} />
      ) : !compare.data ? (
        <Spinner label="Comparing" />
      ) : (
        compare.data.cases
          .filter((row) => row.baseline || row.comparisons.some((c) => c.result))
          .map((row) => (
            <CaseComparison
              key={row.case}
              meta={meta.cases.find((c) => c.id === row.case)!}
              baselineLabel={compare.data!.baseline}
              baseline={row.baseline}
              comparisons={row.comparisons}
              colorOf={colorOf}
            />
          ))
      )}
    </div>
  );
}

function CaseComparison({
  meta,
  baselineLabel,
  baseline,
  comparisons,
  colorOf,
}: {
  meta: BenchmarkCase;
  baselineLabel: string;
  baseline: SavedResult | null;
  comparisons: Comparison[];
  colorOf: (label: string) => string;
}) {
  const columns: { label: string; result: SavedResult | null; comparison?: Comparison }[] = [
    { label: baselineLabel, result: baseline },
    ...comparisons.map((c) => ({ label: c.label, result: c.result, comparison: c })),
  ];
  const series: CompareSeries[] = columns.map((c) => ({
    label: c.label,
    color: colorOf(c.label),
    values: c.result?.metrics ? { p50: c.result.metrics.p50, p95: c.result.metrics.p95, p99: c.result.metrics.p99 } : null,
  }));
  const notComparable = comparisons.filter((c) => c.result && !c.comparable);
  const headline = comparisons.filter((c) => c.comparable && c.change);

  const cell = (result: SavedResult | null, render: (m: Metrics, r: SavedResult) => ReactNode) =>
    result?.metrics ? render(result.metrics, result) : <span className="muted">{result?.problem ?? '—'}</span>;

  return (
    <section className="card stack gap-md" aria-label={meta.title}>
      <div className="row between wrap gap-sm">
        <div className="stack gap-xxs">
          <h2 className="title">{meta.title}</h2>
          <span className="mono caption muted">
            {meta.id} · {meta.request}
          </span>
        </div>
        <span className="badge badge-soft">{meta.layer}</span>
      </div>

      {headline.length > 0 && (
        <div className="row gap-xs wrap">
          {headline.map((c) => (
            <span key={c.label} className="row gap-xs body-sm">
              <span className="chart-key-square" style={{ background: colorOf(c.label) }} />
              {c.label}: p95 <Delta value={c.change!.p95} />
            </span>
          ))}
        </div>
      )}

      <CompareChart series={series} />

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Metric</th>
              {columns.map((c, i) => (
                <th key={c.label} className="num">
                  <span className="row gap-xs" style={{ justifyContent: 'flex-end' }}>
                    <span className="chart-key-square" style={{ background: colorOf(c.label) }} />
                    {c.label}
                    {i === 0 && <span className="muted">(baseline)</span>}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(['p50', 'p95', 'p99'] as const).map((metric) => (
              <tr key={metric}>
                <td className="strong">{metric}</td>
                {columns.map((c) => (
                  <td key={c.label} className="num">
                    {cell(c.result, (m) => (
                      <span className="stack gap-xxs" style={{ alignItems: 'flex-end' }}>
                        {formatMs(m[metric])}
                        {c.comparison?.comparable && <Delta value={c.comparison.change![metric]} />}
                      </span>
                    ))}
                  </td>
                ))}
              </tr>
            ))}
            <tr>
              <td className="strong">Requests per second</td>
              {columns.map((c) => (
                <td key={c.label} className="num">
                  {cell(c.result, (m) => m.requestsPerSecond.toFixed(1))}
                </td>
              ))}
            </tr>
            <tr>
              <td className="strong">Received per request</td>
              {columns.map((c) => (
                <td key={c.label} className="num">
                  {cell(c.result, (m) => bytes(m.bytesReceived / m.requests))}
                </td>
              ))}
            </tr>
            <tr>
              <td className="strong">Answers</td>
              {columns.map((c) => (
                <td key={c.label} className="num">
                  {cell(c.result, (m) =>
                    [m.status200 && `${count(m.status200)} × 200`, m.status304 && `${count(m.status304)} × 304`].filter(Boolean).join(' · ') || '—',
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <td className="strong">Result</td>
              {columns.map((c) => (
                <td key={c.label} className="num">
                  {cell(c.result, (m, r) =>
                    r.passed ? (
                      <span className="badge badge-ink">
                        <Icon name="check" size={12} /> Passed
                      </span>
                    ) : (
                      <span className="badge badge-error" title={`checks ${((m.checkRate ?? 0) * 100).toFixed(1)}%, dropped ${m.dropped}`}>
                        <Icon name="alert" size={12} /> Failed checks
                      </span>
                    ),
                  )}
                </td>
              ))}
            </tr>
            <tr>
              <td className="strong">Measured</td>
              {columns.map((c) => (
                <td key={c.label} className="num caption muted">
                  {cell(c.result, (_, r) => (
                    <span title={r.savedAt ? formatDateTime(r.savedAt) : undefined}>
                      {r.workload?.duration} · {r.runner === 'cli' ? 'CLI' : 'dashboard'}
                      {r.savedAt ? ` · ${timeAgo(r.savedAt)}` : ''}
                    </span>
                  ))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {notComparable.map((c) => (
        <Notice key={c.label} icon="info" title={`${c.label} is not compared with ${baselineLabel}.`}>
          {c.reason}
        </Notice>
      ))}
    </section>
  );
}

/* ---------- Proofs ---------- */

const PROOFS: { mode: ProofMode; title: string; proves: string; expected: string; changesData: boolean }[] = [
  {
    mode: 'etag-stock',
    title: 'A stock change shows up at once, even with the old ETag.',
    proves:
      'Reads the product and its ETag and checks that the same tag gets an empty 304. Then changes the stock and asks again with the old tag: it must get 200 with the new stock and a new ETag, with no wait. Puts the stock back afterwards.',
    expected: 'PASS: old tag → 200 with the new stock, new tag → 304',
    changesData: false,
  },
  {
    mode: 'read-after-write',
    title: 'A new order is visible at once to the customer who placed it.',
    proves:
      'Places a real order as the benchmark customer, then reads its detail and the first page of their orders immediately, with no wait or retry. This is what a read replica must not break.',
    expected: 'PASS: both reads return the new order',
    changesData: true,
  },
];

function ProofsTab() {
  const history = useAsync(() => benchmarkApi.proofs(), []);
  const preflight = useAsync(() => benchmarkApi.preflight(), []);
  return (
    <div className="stack gap-lg">
      <Notice icon="shield" title="Faster must not mean stale.">
        These two checks prove that caching and the read replica never show old data. They run api-tests/task3/verify.mjs, the same script as the terminal.
      </Notice>
      {PROOFS.map((proof) => (
        <ProofCard
          key={proof.mode}
          proof={proof}
          customerReady={preflight.data?.customerReady ?? false}
          customerEmail={preflight.data?.customerEmail}
          history={(history.data?.proofs ?? []).filter((p) => p.mode === proof.mode)}
          onDone={() => {
            history.reload();
            preflight.reload();
          }}
        />
      ))}
    </div>
  );
}

function ProofCard({
  proof,
  customerReady,
  customerEmail,
  history,
  onDone,
}: {
  proof: (typeof PROOFS)[number];
  customerReady: boolean;
  customerEmail?: string;
  history: ProofResult[];
  onDone: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<ProofResult | null>(null);
  const needsCustomer = proof.mode === 'read-after-write' && !customerReady;
  const shown = result ?? history[0] ?? null;

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (needsCustomer) await benchmarkApi.customerSession(password);
      setResult(await benchmarkApi.proof(proof.mode, { acceptDatasetChange: proof.changesData ? accepted : undefined }));
      setPassword('');
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card check" aria-label={proof.title}>
      <div className="check-head">
        <span className="squircle" style={{ width: 36, height: 36 }}>
          <Icon name="shield" size={18} />
        </span>
        <div className="stack gap-xs grow">
          <h2 className="title">{proof.title}</h2>
          <p className="body-sm muted">{proof.proves}</p>
          <span className="caption muted">
            Expected: <span className="strong" style={{ color: 'var(--color-ink)' }}>{proof.expected}</span>
          </span>
        </div>
        <button
          type="button"
          className="btn btn-soft btn-sm"
          onClick={run}
          disabled={busy || (proof.changesData && !accepted) || (needsCustomer && !password)}
        >
          {busy ? 'Running…' : 'Run'}
        </button>
      </div>

      {proof.changesData && (
        <div className="stack gap-sm">
          <Notice icon="alert" title="Run it after your last timed run.">
            It adds one real order and takes one unit of stock, so the order and product workloads no longer match their fixtures until you seed a fresh benchmark volume.
          </Notice>
          <label className="row gap-xs body-sm">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />I understand: place a real order.
          </label>
          {needsCustomer && (
            <TextField
              label="Benchmark customer password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              hint={`The seeder printed it for ${customerEmail ?? 'the benchmark customer'}.`}
            />
          )}
        </div>
      )}

      {error != null && <ProblemNotice error={error} />}

      {shown && (
        <div className="check-result">
          <div className="row gap-sm wrap">
            <span className={`badge ${shown.passed ? 'badge-ink' : 'badge-error'}`}>
              <Icon name={shown.passed ? 'check' : 'alert'} size={14} />
              {shown.passed ? 'Passed' : 'Failed'}
            </span>
            <span className="caption muted">
              {formatDateTime(shown.startedAt)} · {(shown.durationMs / 1000).toFixed(1)} s · {shown.startedBy}
            </span>
          </div>
          <pre className="code">{shown.output || '(no output)'}</pre>
        </div>
      )}

      {history.length > 1 && (
        <details>
          <summary className="body-sm text-link">Earlier runs ({history.length - 1})</summary>
          <ul className="list stack gap-xxs" style={{ marginTop: 'var(--space-xs)' }}>
            {history.slice(1, 11).map((p) => (
              <li key={p.id} className="row gap-xs body-sm">
                <span className={`badge ${p.passed ? 'badge-ink' : 'badge-error'}`}>{p.passed ? 'Passed' : 'Failed'}</span>
                <span className="muted">
                  {formatDateTime(p.startedAt)} · {p.startedBy}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/* ---------- History ---------- */

function HistoryTab({ meta }: { meta: CasesResponse }) {
  const runs = useAsync(() => benchmarkApi.runs(), []);
  const [open, setOpen] = useState<string | null>(null);

  if (runs.error) return <ProblemNotice error={runs.error} />;
  if (!runs.data) return <Spinner label="Loading the runs" />;
  if (!runs.data.runs.length) {
    return <EmptyState icon="receipt" title="No runs yet.">Runs started from this page are listed here, newest first.</EmptyState>;
  }

  return (
    <div className="stack gap-lg">
      {open && <RunPanel key={open} id={open} meta={meta} onFinished={runs.reload} onClose={() => setOpen(null)} />}
      <section className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Started</th>
                <th>Label</th>
                <th>Workloads</th>
                <th>Length</th>
                <th>Status</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.runs.map((r) => (
                <tr
                  key={r.id}
                  className="clickable"
                  onClick={() => setOpen(r.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen(r.id)}
                  tabIndex={0}
                  aria-label={`Open run ${r.label}`}
                >
                  <td className="body-sm" title={formatDateTime(r.createdAt)}>
                    {timeAgo(r.createdAt)}
                  </td>
                  <td className="strong">{r.label}</td>
                  <td className="body-sm">
                    {r.steps.map((s) => (
                      <span key={s.case} className={`mono caption step-tag step-${s.status}`}>
                        {s.case}
                      </span>
                    ))}
                  </td>
                  <td className="body-sm">{r.profile === 'standard' ? 'Standard' : 'Quick'}</td>
                  <td>
                    <RunStatusBadge status={r.status} />
                  </td>
                  <td className="body-sm muted">{r.startedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
