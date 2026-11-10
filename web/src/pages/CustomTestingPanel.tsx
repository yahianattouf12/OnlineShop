import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client';
import { labApi, type DataConfig, type DataManifest, type DataState, type Inspection, type LabComparison, type LabMetrics, type LabRequest, type LabRun, type MetricKey, type RequestRecord, type Scenario, type Telemetry } from '../api/lab';
import { CompareChart, LatencyChart, formatMs } from '../components/PerfCharts';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { Notice, Segmented, Spinner, TextAreaField, TextField } from '../components/ui';
import { formatDateTime } from '../lib/format';
import '../styles/custom-testing.css';

const clone = <T,>(value: T): T => structuredClone(value);
const uid = () => 'r-' + crypto.randomUUID().slice(0, 8);
const enabled = (scenario: Scenario) => scenario.requests.filter((r) => r.enabled);
const writes = (scenario: Scenario) => enabled(scenario).some((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));
const formatNumber = (value: number | null | undefined, digits = 1) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits });
const json = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const errorText = (error: unknown) => error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'The request could not be completed.';
const percent = (value: number | null | undefined) => value == null ? '—' : `${formatNumber(value * 100, 2)}%`;
const bytes = (value: number | null | undefined) => value == null ? '—' : value >= 1048576 ? `${formatNumber(value / 1048576)} MB` : value >= 1024 ? `${formatNumber(value / 1024)} KB` : `${formatNumber(value, 0)} B`;
const metricOptions: { key: MetricKey; name: string; help: string }[] = [
  { key: 'p50', name: 'P50 · typical response', help: 'Half the requests finished within this time.' },
  { key: 'p95', name: 'P95 · slower responses', help: '95% of requests finished within this time.' },
  { key: 'p99', name: 'P99 · slowest tail', help: '99% of requests finished within this time.' },
  { key: 'throughput', name: 'Throughput', help: 'Completed HTTP requests per second.' },
  { key: 'errors', name: 'HTTP error rate', help: 'Responses outside the expected status codes, including network failures.' },
  { key: 'checks', name: 'Checks passed', help: 'The share of response checks that passed.' },
  { key: 'requests', name: 'Requests completed', help: 'Actual HTTP requests during measurement; excludes warm-up.' },
  { key: 'dropped', name: 'Dropped iterations', help: 'Scheduled scenario iterations that the available workers could not start.' },
  { key: 'bytesReceived', name: 'Bytes received', help: 'Response traffic measured by k6.' },
  { key: 'cpu', name: 'API CPU', help: 'Sampled shop API process CPU. 100% means one CPU core.' },
  { key: 'memory', name: 'API memory', help: 'Sampled working memory of the shop API process.' },
  { key: 'database', name: 'Database activity', help: 'App database transactions, cache hits, and active connections. Includes other database traffic.' },
];
const defaultMetrics: MetricKey[] = ['p50', 'p95', 'p99', 'throughput', 'errors', 'requests'];

function newRequest(preset = 'orders'): LabRequest {
  const base: LabRequest = { id: uid(), name: 'Order list', method: 'GET', path: '/api/v1/orders', role: 'admin', headers: {}, query: { page: '1', pageSize: '10' }, body: '', expectedStatuses: [200], assertions: [], enabled: true };
  if (preset === 'products') return { ...base, name: 'Product catalog', path: '/api/v1/products', role: 'anonymous' };
  if (preset === 'detail') return { ...base, name: 'Product detail', path: '/api/v1/products/{{productId}}', role: 'anonymous', query: {} };
  if (preset === 'stock') return { ...base, name: 'Change stock', method: 'PUT', path: '/api/v1/products/{{productId}}/stock', query: {}, headers: { 'Content-Type': 'application/json' }, body: '{"quantity": {{stock}}}' };
  if (preset === 'blank') return { ...base, name: 'New request', path: '/api/v1/products', query: {}, role: 'anonymous' };
  return base;
}
function newScenario(): Scenario {
  return { name: 'Order list baseline', requests: [newRequest()], data: { rows: [], ranges: [] }, load: { mode: 'iterations', iterations: 100, duration: 60, warmup: 5, concurrency: 5, rate: 10, repeat: 1, pauseMs: 0 }, thresholds: { p95: 1000, errorRate: 0, checks: 1 }, metrics: defaultMetrics, datasetTag: '' };
}

function SelectField({ label, children, value, onChange, hint, disabled }: { label: string; children: ReactNode; value: string; onChange: (value: string) => void; hint?: ReactNode; disabled?: boolean }) {
  const id = useId();
  return <div className="field"><label className="field-label" htmlFor={id}>{label}</label><select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>{children}</select>{hint && <span className="field-hint">{hint}</span>}</div>;
}
function NumberField({ label, value, onChange, min = 0, max, step = 1, hint }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; hint?: ReactNode }) {
  return <TextField type="number" label={label} min={min} max={max} step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} hint={hint} />;
}
function InlineError({ error }: { error: unknown }) {
  return error ? <div className="studio-error" role="alert"><Icon name="alert" size={17} /><span>{errorText(error)}</span></div> : null;
}
function Status({ status }: { status: string }) {
  return <span className={`badge ${status === 'failed' ? 'badge-error' : status === 'passed' ? 'badge-ink' : 'badge-soft'}`}>{status === 'running' && <span className="spinner spinner-sm" />}{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}
function SectionTitle({ number, title, children, action }: { number?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="studio-section-title"><div className="row gap-sm">{number && <span className="studio-number">{number}</span>}<div><h3>{title}</h3>{children && <p className="caption muted">{children}</p>}</div></div>{action}</div>;
}

export function CustomTestingPanel() {
  const toast = useToast();
  const [view, setView] = useState<'configure' | 'data' | 'results'>('configure');
  const [scenario, setScenario] = useState<Scenario>(newScenario);
  const [selectedRequest, setSelectedRequest] = useState(scenario.requests[0].id);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [history, setHistory] = useState<LabRun[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [run, setRun] = useState<LabRun | null>(null);
  const [label, setLabel] = useState('before');
  const [sourceNote, setSourceNote] = useState('');
  const [customerPassword, setCustomerPassword] = useState('');
  const [acceptWrites, setAcceptWrites] = useState(false);
  const [displayMetrics, setDisplayMetrics] = useState<string[]>(defaultMetrics);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const data = await labApi.runs();
        if (!mounted.current) return;
        setHistory(data.runs);
        setActiveId(data.runningRunId);
        setSelectedRunId((id) => id ?? data.runningRunId ?? data.runs[0]?.id ?? null);
        setLoaded(true);
      } catch (e) { if (mounted.current) { setError(e); setLoaded(true); } }
      if (mounted.current) timer = setTimeout(load, 2000);
    }
    load();
    labApi.scenarios().then((data) => { if (mounted.current) setScenarios(data.scenarios); }).catch((e) => { if (mounted.current) setError(e); });
    return () => { mounted.current = false; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setRun(null);
    if (!selectedRunId) return;
    async function load() {
      try {
        const data = await labApi.run(selectedRunId!);
        if (!alive) return;
        setRun(data);
        if (data.status === 'running') timer = setTimeout(load, 1500);
      } catch (e) { if (alive) setError(e); }
    }
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [selectedRunId]);

  function changeScenario(value: Scenario) {
    setScenario(clone(value));
    setSelectedRequest(value.requests[0]?.id ?? '');
    setDisplayMetrics(value.metrics);
    setAcceptWrites(false);
    setInspection(null);
    setDraftErrors({});
    setError(undefined);
    setView('configure');
  }
  const draftError = (key: string, value: string) => setDraftErrors((all) => ({ ...all, [key]: value }));
  const updateRequest = (request: LabRequest) => setScenario((s) => ({ ...s, requests: s.requests.map((r) => r.id === request.id ? request : r) }));
  const request = scenario.requests.find((r) => r.id === selectedRequest) ?? scenario.requests[0];
  const requestCount = enabled(scenario).length;
  const hasWrites = writes(scenario);
  const needsCustomer = enabled(scenario).some((r) => r.role === 'customer');
  const invalidDraft = Object.values(draftErrors).find(Boolean);
  const blocked = Boolean(busy || activeId);

  async function action(name: string, task: () => Promise<void>) {
    setBusy(name); setError(undefined);
    try { await task(); } catch (e) { setError(e); } finally { setBusy(null); }
  }
  function assertDraft() {
    if (invalidDraft) throw new Error(invalidDraft);
    if (!requestCount) throw new Error('Enable at least one request in your scenario.');
    if (!scenario.name.trim()) throw new Error('Give this scenario a name.');
  }
  async function save(copy = false) {
    await action('save', async () => {
      assertDraft();
      const saved = await labApi.saveScenario({ ...scenario, id: copy ? undefined : scenario.id });
      setScenario(saved);
      setScenarios((all) => [saved, ...all.filter((s) => s.id !== saved.id)]);
      toast('Scenario saved. Run it again with the same settings at any time.');
    });
  }
  async function start() {
    await action('start', async () => {
      assertDraft();
      const started = await labApi.start({ label, scenario, sourceNote, customerPassword: customerPassword || undefined, acceptWrites });
      setCustomerPassword(''); setRun(started); setActiveId(started.id); setSelectedRunId(started.id);
      setHistory((all) => [started, ...all]); setView('results');
      toast(`“${started.label}” is running.`);
    });
  }
  async function inspect() {
    await action('inspect', async () => {
      if (invalidDraft) throw new Error(invalidDraft);
      const result = await labApi.inspect({ scenario, requestId: request.id, customerPassword: customerPassword || undefined, acceptWrites });
      setInspection(result);
    });
  }
  function addRequest(kind = 'blank') {
    const value = newRequest(kind);
    setScenario((s) => ({ ...s, requests: [...s.requests, value] }));
    setSelectedRequest(value.id); setInspection(null);
  }
  function useDataset(manifest: DataManifest) {
    const rows = manifest.samples.productIds.slice(0, 100).map((productId) => ({ productId }));
    setScenario((s) => ({ ...s, datasetTag: manifest.fingerprint, data: { ...s.data, rows: rows.length ? rows : s.data.rows } }));
    toast('Fixture identity and sample product IDs added to your scenario.');
  }
  function selectMetrics(values: string[]) {
    setDisplayMetrics(values);
    setScenario((s) => ({ ...s, metrics: values }));
  }

  return <div className="studio">
    <div className="studio-intro">
      <div><span className="studio-kicker">YOUR PERFORMANCE WORKSPACE</span><h2>Configure. Measure. Understand.</h2><p>Build a repeatable test, watch real responses, and compare saved runs after each change.</p></div>
      <div className="studio-intro-stat"><strong>{formatNumber(history.length, 0)}</strong><span>saved runs</span></div>
    </div>
    <div className="studio-navigation">
      <Segmented label="Test studio view" value={view} onChange={setView} options={[{ value: 'configure', label: 'Configure test' }, { value: 'data', label: 'Prepare data' }, { value: 'results', label: 'Results & comparison' }]} />
      {activeId && <button type="button" className="btn btn-soft btn-sm" onClick={() => { setSelectedRunId(activeId); setView('results'); }}><span className="spinner spinner-sm" /> A test is running · View</button>}
    </div>
    <InlineError error={error} />
    {!loaded && <Spinner label="Connecting to the test studio" />}

    {view === 'configure' && <div className="studio-builder">
      <section className="card studio-section">
        <SectionTitle number="01" title="Build your scenario" action={<div className="row gap-xs wrap"><button className="btn btn-soft btn-sm" onClick={() => changeScenario(newScenario())}>New scenario</button><button className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={() => save()}>{busy === 'save' ? 'Saving…' : 'Save scenario'}</button></div>}>A scenario is an ordered set of requests. Enable only the requests you want to test.</SectionTitle>
        <div className="studio-grid-2">
          <TextField label="Scenario name" value={scenario.name} maxLength={100} onChange={(e) => setScenario({ ...scenario, name: e.target.value })} placeholder="Customer order browsing" />
          <SelectField label="Saved scenarios" value={scenario.id ?? ''} onChange={(id) => { const found = scenarios.find((s) => s.id === id); if (found) changeScenario(found); }}><option value="">Choose a saved scenario</option>{scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</SelectField>
        </div>
        {scenario.id && <div className="row gap-sm"><span className="caption muted">Editing a saved scenario does not change past runs.</span><button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => save(true)}>Save as new</button><button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => action('delete', async () => { await labApi.deleteScenario(scenario.id!); setScenarios((all) => all.filter((s) => s.id !== scenario.id)); setScenario({ ...scenario, id: undefined }); toast('Scenario removed from the library. Saved runs are kept.'); })}>Remove from library</button></div>}
        <div className="studio-requests">
          <div className="studio-request-list">
            <div className="studio-list-heading"><strong>Requests</strong><span className="caption muted">{requestCount} enabled</span></div>
            {scenario.requests.map((r, i) => <div key={r.id} className={`studio-request-item ${request.id === r.id ? 'selected' : ''}`}>
              <input aria-label={`Enable ${r.name}`} type="checkbox" checked={r.enabled} onChange={(e) => updateRequest({ ...r, enabled: e.target.checked })} />
              <button type="button" onClick={() => { setSelectedRequest(r.id); setInspection(null); }}><span><small>{String(i + 1).padStart(2, '0')}</small><span className="studio-method">{r.method}</span></span><strong>{r.name || 'Untitled request'}</strong><small className="studio-path">{r.path}</small></button>
            </div>)}
            <button type="button" className="btn btn-soft btn-sm studio-add" disabled={scenario.requests.length >= 20} onClick={() => addRequest()}>+ Add request</button>
            <details className="studio-presets"><summary>Add from a template</summary><div className="stack gap-xs">{[['orders', 'Admin order list'], ['products', 'Product catalog'], ['detail', 'Product detail'], ['stock', 'Update product stock']].map(([key, title]) => <button key={key} className="btn btn-ghost btn-sm" disabled={scenario.requests.length >= 20} onClick={() => addRequest(key)}>{title}</button>)}</div></details>
          </div>
          {request && <RequestEditor key={request.id} request={request} update={updateRequest} index={scenario.requests.indexOf(request)} count={scenario.requests.length}
            onMove={(direction) => { const all = [...scenario.requests]; const index = all.findIndex((r) => r.id === request.id); [all[index], all[index + direction]] = [all[index + direction], all[index]]; setScenario({ ...scenario, requests: all }); }}
            onRemove={() => { const all = scenario.requests.filter((r) => r.id !== request.id); setScenario({ ...scenario, requests: all }); setSelectedRequest(all[0].id); draftError(request.id, ''); }}
            onError={(message) => draftError(request.id, message)} />}
        </div>
        {hasWrites && <label className="studio-write-confirm"><input type="checkbox" checked={acceptWrites} onChange={(e) => setAcceptWrites(e.target.checked)} /><span><strong>Allow these requests to change benchmark data.</strong><small>Preview, warm-up, and measured write requests perform real changes. Restore your fixture before a like-for-like comparison.</small></span></label>}
        <div className="studio-preview-action"><div><strong>Try this request once</strong><p className="caption muted">Uses the first test-data row and range value. Shows the real HTTP response.</p></div><button type="button" className="btn btn-soft" disabled={blocked || Boolean(invalidDraft) || (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !acceptWrites)} onClick={inspect}>{busy === 'inspect' ? 'Sending…' : 'Send preview request'} <Icon name="arrowRight" size={16} /></button></div>
        {inspection && <HttpExchange result={inspection} />}
      </section>

      <section className="card studio-section">
        <SectionTitle number="02" title="Vary the request data">Use <code>{'{{name}}'}</code> in a path, query, header, or body. Rows and numeric ranges cycle once per scenario iteration.</SectionTitle>
        <DataVariables data={scenario.data} onChange={(data) => setScenario({ ...scenario, data })} onError={(message) => draftError('data', message)} />
        <TextField label="Dataset label or fingerprint" value={scenario.datasetTag} maxLength={120} onChange={(e) => setScenario({ ...scenario, datasetTag: e.target.value })} placeholder="For example: 100k-orders-v1" hint="Recorded with the run. Prepare data can fill this from the actual fixture. Use the same dataset when comparing optimizations." />
      </section>

      <section className="card studio-section">
        <SectionTitle number="03" title="Choose the workload">One iteration runs every enabled request, in order. Warm-up is separate from the measured results.</SectionTitle>
        <div className="studio-mode-grid">{([
          ['iterations', 'Repeat N times', 'Finish a fixed number of scenario iterations.'],
          ['duration', 'Run for a duration', 'Keep a fixed number of workers busy.'],
          ['rate', 'Maintain an arrival rate', 'Start a set number of scenario iterations each second.'],
        ] as const).map(([mode, title, detail]) => <button type="button" key={mode} className={`studio-mode ${scenario.load.mode === mode ? 'selected' : ''}`} aria-pressed={scenario.load.mode === mode} onClick={() => setScenario({ ...scenario, load: { ...scenario.load, mode } })}><span className="studio-radio" /><strong>{title}</strong><small>{detail}</small></button>)}</div>
        <div className="studio-grid-3">
          {scenario.load.mode === 'iterations' ? <NumberField label="Total scenario iterations" value={scenario.load.iterations} min={1} max={100000} onChange={(iterations) => setScenario({ ...scenario, load: { ...scenario.load, iterations } })} hint="Shared by all workers, not per worker." /> : <NumberField label="Measured duration · seconds" value={scenario.load.duration} min={1} max={3600} onChange={(duration) => setScenario({ ...scenario, load: { ...scenario.load, duration } })} />}
          <NumberField label="Concurrent workers" value={scenario.load.concurrency} min={1} max={200} onChange={(concurrency) => setScenario({ ...scenario, load: { ...scenario.load, concurrency } })} hint="Each worker sends one request at a time." />
          {scenario.load.mode === 'rate' ? <NumberField label="Scenario iterations / second" value={scenario.load.rate} min={1} max={1000} onChange={(rate) => setScenario({ ...scenario, load: { ...scenario.load, rate } })} hint={`${requestCount} requests per iteration ≈ ${formatNumber(scenario.load.rate * requestCount, 0)} requested HTTP requests/s.`} /> : <NumberField label="Pause between iterations · ms" value={scenario.load.pauseMs} min={0} max={60000} onChange={(pauseMs) => setScenario({ ...scenario, load: { ...scenario.load, pauseMs } })} />}
          <NumberField label="Warm-up per repetition · seconds" value={scenario.load.warmup} min={0} max={300} onChange={(warmup) => setScenario({ ...scenario, load: { ...scenario.load, warmup } })} hint="Use 0 to skip warm-up, especially for write tests." />
          <NumberField label="Repeat the complete test" value={scenario.load.repeat} min={1} max={10} onChange={(repeat) => setScenario({ ...scenario, load: { ...scenario.load, repeat } })} hint="Each repetition has its own warm-up and measurement." />
          {scenario.load.mode === 'iterations' && <NumberField label="Maximum run time · seconds" value={scenario.load.duration} min={1} max={3600} onChange={(duration) => setScenario({ ...scenario, load: { ...scenario.load, duration } })} hint="Stops a stalled iteration test; incomplete tests fail." />}
        </div>
        <div className="studio-workload-summary"><Icon name="info" size={18} /><span>{scenario.load.mode === 'iterations' ? `${formatNumber(scenario.load.iterations * requestCount * scenario.load.repeat, 0)} HTTP requests expected across ${scenario.load.repeat} measured repetition${scenario.load.repeat === 1 ? '' : 's'}, plus any warm-up requests.` : `${formatNumber(scenario.load.duration * scenario.load.repeat, 0)} seconds of measurement across ${scenario.load.repeat} repetition${scenario.load.repeat === 1 ? '' : 's'}, with ${scenario.load.concurrency} workers.`}</span></div>
        <details className="studio-details"><summary>Pass criteria <span className="muted">· latency, HTTP errors, response checks</span></summary><div className="studio-grid-3">
          <NumberField label="P95 response time at most · ms" value={scenario.thresholds.p95} min={1} max={300000} onChange={(p95) => setScenario({ ...scenario, thresholds: { ...scenario.thresholds, p95 } })} />
          <NumberField label="Maximum HTTP error rate · %" value={scenario.thresholds.errorRate * 100} min={0} max={100} step={0.1} onChange={(value) => setScenario({ ...scenario, thresholds: { ...scenario.thresholds, errorRate: value / 100 } })} />
          <NumberField label="Minimum response checks passed · %" value={scenario.thresholds.checks * 100} min={0} max={100} step={0.1} onChange={(value) => setScenario({ ...scenario, thresholds: { ...scenario.thresholds, checks: value / 100 } })} />
        </div></details>
      </section>

      <section className="card studio-section">
        <SectionTitle number="04" title="Record and run">Save a clear label for this implementation. Labels do not switch your source code.</SectionTitle>
        <div className="studio-grid-2"><TextField label="Result label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="before · after-index · after-cache" /><TextField label="Implementation note" value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} maxLength={500} placeholder="Git commit, optimization, or environment notes" hint="For example: commit abc123, added Orders(CreatedAt, Id) index." /></div>
        <MetricPicker selected={displayMetrics} onChange={selectMetrics} />
        {needsCustomer && <TextField type="password" autoComplete="off" label="Benchmark customer password" value={customerPassword} onChange={(e) => setCustomerPassword(e.target.value)} hint="Used to log in once before the test, then kept only in server memory. Leave blank to reuse its current session." />}
        {hasWrites && <label className="studio-write-confirm"><input type="checkbox" checked={acceptWrites} onChange={(e) => setAcceptWrites(e.target.checked)} /><span><strong>Allow this scenario to change benchmark data.</strong><small>POST, PUT, PATCH, and DELETE requests perform real writes, including preview and warm-up requests. Restore your fixture before a like-for-like comparison.</small></span></label>}
        <div className="studio-launch"><div><strong>{requestCount} enabled request{requestCount === 1 ? '' : 's'} · {scenario.load.repeat} repetition{scenario.load.repeat === 1 ? '' : 's'}</strong><span className="caption muted">Results include the exact scenario configuration used for the run.</span></div><button className="btn btn-primary" type="button" disabled={blocked || !requestCount || Boolean(invalidDraft) || !label.trim() || (hasWrites && !acceptWrites)} onClick={start}>{busy === 'start' ? 'Starting…' : 'Launch test'}<Icon name="arrowRight" size={18} /></button></div>
        {invalidDraft && <InlineError error={new Error(invalidDraft)} />}
      </section>
    </div>}

    {view === 'data' && <PrepareData onUse={useDataset} testRunning={Boolean(activeId)} />}

    {view === 'results' && <div className="studio-results">
      <MetricPicker selected={displayMetrics} onChange={selectMetrics} />
      <div className="studio-results-top"><SelectField label="Inspect a saved or active run" value={selectedRunId ?? ''} onChange={setSelectedRunId}><option value="">Select a run</option>{history.map((item) => <option value={item.id} key={item.id}>{item.label} · {item.scenario.name} · {item.status}</option>)}</SelectField><button className="btn btn-soft" onClick={() => setView('configure')}>Configure another test</button></div>
      {run ? <RunMonitor run={run} metrics={displayMetrics} onCancel={() => action('cancel', async () => { await labApi.cancel(run.id); toast('Stop requested. Partial results stay visible.'); })} cancelling={busy === 'cancel'} onRepeat={() => { changeScenario(run.scenario); setLabel(`${run.label.slice(0, 27)}-repeat`); setSourceNote(run.sourceNote); toast('Original settings loaded. Choose a new label, then launch.'); }} /> : <div className="studio-empty"><Icon name="play" size={32} /><h3>{selectedRunId ? 'Loading this run…' : 'Your measurements will appear here'}</h3><p>Launch a scenario to see response times, HTTP exchanges, and saved comparisons.</p></div>}
      <ComparisonPanel runs={history} selected={displayMetrics} before={before} after={after} setBefore={setBefore} setAfter={setAfter} />
      <section className="card studio-section"><SectionTitle title="Run history">Saved measurements stay unchanged when you edit a scenario or rebuild the application.</SectionTitle>{!history.length ? <p className="muted">No runs have been saved yet.</p> : <div className="studio-table-wrap"><table className="studio-table"><thead><tr><th>Label / implementation</th><th>Scenario</th><th>Started</th><th>Status</th><th>P95</th><th /></tr></thead><tbody>{history.map((item) => <tr key={item.id}><td><strong>{item.label}</strong><small>{item.sourceNote || 'No implementation note'}</small></td><td>{item.scenario.name}</td><td>{formatDateTime(item.createdAt)}</td><td><Status status={item.status} /></td><td>{item.metrics?.p95 == null ? '—' : formatMs(item.metrics.p95)}</td><td><button className="btn btn-soft btn-sm" onClick={() => setSelectedRunId(item.id)}>View</button></td></tr>)}</tbody></table></div>}</section>
    </div>}
  </div>;
}

function KeyValues({ label, value, onChange }: { label: string; value: Record<string, string>; onChange: (value: Record<string, string>) => void }) {
  const [rows, setRows] = useState(() => Object.entries(value).map(([key, val]) => ({ id: uid(), key, value: val })));
  const lastEmitted = useRef(JSON.stringify(value));
  useEffect(() => { if (JSON.stringify(value) !== lastEmitted.current) { setRows(Object.entries(value).map(([key, val]) => ({ id: uid(), key, value: val }))); lastEmitted.current = JSON.stringify(value); } }, [value]);
  function update(next: typeof rows) {
    setRows(next);
    const result = Object.fromEntries(next.filter((r) => r.key.trim()).map((r) => [r.key, r.value]));
    lastEmitted.current = JSON.stringify(result); onChange(result);
  }
  return <div className="studio-key-values"><div className="studio-list-heading"><strong className="field-label">{label}</strong><button className="btn btn-ghost btn-sm" type="button" onClick={() => update([...rows, { id: uid(), key: '', value: '' }])}>+ Add</button></div>{rows.length === 0 ? <p className="caption muted">No {label.toLowerCase()} configured.</p> : rows.map((row) => <div key={row.id} className="studio-key-row"><input className="input" aria-label={`${label} name`} placeholder="Name" value={row.key} onChange={(e) => update(rows.map((r) => r.id === row.id ? { ...r, key: e.target.value } : r))} /><input className="input" aria-label={`${label} value for ${row.key || 'new entry'}`} placeholder="Value or {{variable}}" value={row.value} onChange={(e) => update(rows.map((r) => r.id === row.id ? { ...r, value: e.target.value } : r))} /><button type="button" className="btn btn-ghost btn-icon btn-sm" aria-label={`Remove ${row.key || label}`} onClick={() => update(rows.filter((r) => r.id !== row.id))}><Icon name="x" size={16} /></button></div>)}</div>;
}

function RequestEditor({ request, update, index, count, onMove, onRemove, onError }: { request: LabRequest; update: (request: LabRequest) => void; index: number; count: number; onMove: (direction: number) => void; onRemove: () => void; onError: (message: string) => void }) {
  const [detail, setDetail] = useState<'parameters' | 'body' | 'checks'>('parameters');
  const [statuses, setStatuses] = useState(request.expectedStatuses.join(', '));
  const [statusError, setStatusError] = useState('');
  return <div className="studio-request-editor">
    <div className="studio-list-heading"><strong>Request {index + 1}</strong><div className="row gap-xxs"><button type="button" className="btn btn-ghost btn-sm" disabled={!index} onClick={() => onMove(-1)} aria-label="Move request earlier">↑</button><button type="button" className="btn btn-ghost btn-sm" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move request later">↓</button><button type="button" className="btn btn-ghost btn-sm" disabled={count === 1} onClick={onRemove}>Remove</button></div></div>
    <TextField label="Request name" value={request.name} onChange={(e) => update({ ...request, name: e.target.value })} maxLength={100} />
    <div className="studio-endpoint"><SelectField label="Method" value={request.method} onChange={(method) => update({ ...request, method, body: ['GET', 'HEAD'].includes(method) ? '' : request.body })}>{['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((method) => <option key={method}>{method}</option>)}</SelectField><TextField label="Endpoint path" value={request.path} onChange={(e) => update({ ...request, path: e.target.value })} placeholder="/api/v1/products/{{productId}}" hint="Requests go to this shop’s API. Use a path, not an external website." /></div>
    <SelectField label="Request identity" value={request.role} onChange={(role) => update({ ...request, role: role as LabRequest['role'] })}><option value="anonymous">Anonymous · no access token</option><option value="admin">Admin · your signed-in account</option><option value="customer">Benchmark customer</option></SelectField>
    <Segmented label="Request configuration" value={detail} onChange={setDetail} options={[{ value: 'parameters', label: 'Parameters & headers' }, { value: 'body', label: 'Request body' }, { value: 'checks', label: 'Response checks' }]} />
    {detail === 'parameters' && <div className="stack gap-md"><KeyValues label="Query parameters" value={request.query} onChange={(query) => update({ ...request, query })} /><KeyValues label="Request headers" value={request.headers} onChange={(headers) => update({ ...request, headers })} /><p className="caption muted">Authentication is set by Request identity. Use headers for content type, ETags, or other request options.</p></div>}
    {detail === 'body' && <TextAreaField className="studio-code-input" label="Request body" rows={8} value={request.body} onChange={(e) => update({ ...request, body: e.target.value })} disabled={['GET', 'HEAD'].includes(request.method)} placeholder={'{\n  "quantity": {{stock}}\n}'} hint={['GET', 'HEAD'].includes(request.method) ? 'GET and HEAD requests have no body.' : 'Enter JSON or plain text. Set the matching Content-Type header. Numeric variables can be unquoted.'} />}
    {detail === 'checks' && <div className="stack gap-md"><TextField label="Expected HTTP status codes" value={statuses} onChange={(e) => { const value = e.target.value; setStatuses(value); const parsed = value.split(',').map((s) => Number(s.trim())); const message = !value.trim() || parsed.some((n) => !Number.isInteger(n) || n < 100 || n > 599) ? 'Enter HTTP status codes separated by commas, such as 200, 304.' : ''; setStatusError(message); onError(message); if (!message) update({ ...request, expectedStatuses: parsed }); }} error={statusError ? [statusError] : undefined} hint="For example: 200 for a normal read; 304 for a matching ETag; 201 for a created order." />
      <div className="studio-list-heading"><strong className="field-label">JSON response checks</strong><button type="button" className="btn btn-ghost btn-sm" onClick={() => update({ ...request, assertions: [...request.assertions, { path: 'totalCount', operator: 'eq', value: 100000 }] })}>+ Add check</button></div>
      {!request.assertions.length && <p className="caption muted">Only HTTP status is checked. Add a field check when your scenario needs it.</p>}
      {request.assertions.map((check, i) => <div className="studio-assertion" key={i}><TextField label="JSON field path" value={check.path} onChange={(e) => update({ ...request, assertions: request.assertions.map((r, n) => n === i ? { ...r, path: e.target.value } : r) })} placeholder="totalCount or items.0.id" /><SelectField label="Condition" value={check.operator} onChange={(operator) => update({ ...request, assertions: request.assertions.map((r, n) => n === i ? { ...r, operator: operator as 'eq' } : r) })}><option value="eq">Equals</option><option value="exists">Exists</option><option value="contains">Contains</option></SelectField>{check.operator !== 'exists' && <AssertionValue value={check.value} onChange={(value) => update({ ...request, assertions: request.assertions.map((r, n) => n === i ? { ...r, value } : r) })} />}<button className="btn btn-ghost btn-icon" aria-label={`Remove check ${i + 1}`} onClick={() => update({ ...request, assertions: request.assertions.filter((_, n) => n !== i) })}><Icon name="x" size={16} /></button></div>)}
    </div>}
  </div>;
}

function AssertionValue({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }) {
  const [text, setText] = useState(typeof value === 'string' ? value : JSON.stringify(value ?? ''));
  const previous = useRef(value);
  useEffect(() => { if (value !== previous.current) { setText(typeof value === 'string' ? value : JSON.stringify(value ?? '')); previous.current = value; } }, [value]);
  return <TextField label="Expected value" value={text} onChange={(e) => { setText(e.target.value); let next: unknown = e.target.value; try { next = JSON.parse(e.target.value); } catch { /* Text is a valid expected value. */ } previous.current = next; onChange(next); }} hint="Numbers, true/false, or text." />;
}

function DataVariables({ data, onChange, onError }: { data: Scenario['data']; onChange: (data: Scenario['data']) => void; onError: (message: string) => void }) {
  const [rowsText, setRowsText] = useState(JSON.stringify(data.rows, null, 2));
  const last = useRef(JSON.stringify(data.rows));
  const [error, setError] = useState('');
  useEffect(() => { if (JSON.stringify(data.rows) !== last.current) { setRowsText(JSON.stringify(data.rows, null, 2)); last.current = JSON.stringify(data.rows); } }, [data.rows]);
  function editRows(value: string) {
    setRowsText(value);
    try {
      const rows: unknown = JSON.parse(value);
      if (!Array.isArray(rows) || rows.some((r) => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('Use an array of data rows, for example [{"productId":"..."}].');
      last.current = JSON.stringify(rows); onChange({ ...data, rows }); setError(''); onError('');
    } catch (e) { const message = e instanceof SyntaxError ? 'The test-data rows need valid JSON. Use [] when no rows are needed.' : errorText(e); setError(message); onError(message); }
  }
  return <div className="stack gap-md">
    <div className="studio-grid-2"><div><TextAreaField className="studio-code-input" label="Test-data rows · JSON" rows={6} value={rowsText} onChange={(e) => editRows(e.target.value)} error={error ? [error] : undefined} hint={'Example: [{"productId":"your-id","stock":20}, {"productId":"another-id","stock":100}]. These are request values, not new database records.'} /></div><div className="studio-variable-guide"><strong>A repeatable set of inputs</strong><ol><li>Each iteration takes the next row.</li><li>Use its column name as a variable, such as <code>{'{{productId}}'}</code>.</li><li>When the rows run out, the list starts again.</li></ol><p className="caption muted">To insert real products or orders, use <strong>Prepare data</strong>. That tab can also fill product IDs here.</p></div></div>
    <div className="studio-list-heading"><strong>Numeric ranges</strong><button className="btn btn-soft btn-sm" type="button" onClick={() => onChange({ ...data, ranges: [...data.ranges, { name: 'page', min: 1, max: 100, step: 1 }] })}>+ Add range</button></div>
    {!data.ranges.length && <p className="caption muted">Add a range to vary a page number, stock quantity, or another numeric request value.</p>}
    {data.ranges.map((range, i) => <div key={i} className="studio-range"><TextField label="Variable name" value={range.name} onChange={(e) => onChange({ ...data, ranges: data.ranges.map((r, n) => n === i ? { ...r, name: e.target.value } : r) })} /><NumberField label="From" value={range.min} onChange={(min) => onChange({ ...data, ranges: data.ranges.map((r, n) => n === i ? { ...r, min } : r) })} /><NumberField label="To" value={range.max} onChange={(max) => onChange({ ...data, ranges: data.ranges.map((r, n) => n === i ? { ...r, max } : r) })} /><NumberField label="Step" min={1} value={range.step} onChange={(step) => onChange({ ...data, ranges: data.ranges.map((r, n) => n === i ? { ...r, step } : r) })} /><button className="btn btn-ghost btn-icon" aria-label={`Remove ${range.name} range`} onClick={() => onChange({ ...data, ranges: data.ranges.filter((_, n) => n !== i) })}><Icon name="x" size={16} /></button></div>)}
  </div>;
}

function MetricPicker({ selected, onChange }: { selected: string[]; onChange: (values: string[]) => void }) {
  return <details className="studio-details studio-metric-picker"><summary>Choose visible metrics <span className="muted">· {selected.length} selected</span></summary><div className="studio-metric-options">{metricOptions.map((metric) => <label key={metric.key} title={metric.help}><input type="checkbox" checked={selected.includes(metric.key)} onChange={(e) => onChange(e.target.checked ? [...selected, metric.key] : selected.filter((key) => key !== metric.key))} /><span><strong>{metric.name}</strong><small>{metric.help}</small></span></label>)}</div></details>;
}

function HttpExchange({ result }: { result: Inspection }) {
  return <div className="studio-exchange"><div className="row gap-sm wrap"><span className={`badge ${result.checks.some((c) => !c.passed) || result.status === 0 ? 'badge-error' : 'badge-ink'}`}>HTTP {result.status || 'network error'}</span><strong>{formatMs(result.durationMs)}</strong><code>{result.method} {result.url}</code></div><div className="studio-grid-2"><div><h4>Response headers</h4><pre className="studio-code">{Object.entries(result.headers ?? {}).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\n') || '(no response headers)'}</pre></div><div><h4>Response body</h4><pre className="studio-code">{result.body === '' || result.body == null ? '(empty body)' : json(result.body)}</pre></div></div><div className="row wrap gap-xs">{result.checks?.map((check, i) => <span key={i} className={`badge ${check.passed ? 'badge-soft' : 'badge-error'}`}>{check.passed ? '✓' : '×'} {check.label}</span>)}</div>{result.note && <p className="caption muted">{result.note}</p>}<InlineError error={result.error ? new Error(result.error) : undefined} /></div>;
}

function metricValue(key: string, metrics: LabMetrics | null | undefined) {
  if (!metrics) return '—';
  const value = metrics[key as keyof LabMetrics];
  if (value == null || !Number.isFinite(value)) return '—';
  if (['p50', 'p95', 'p99'].includes(key)) return formatMs(value);
  if (['errors', 'checks'].includes(key)) return percent(value);
  if (key === 'throughput') return `${formatNumber(value)} req/s`;
  if (key === 'bytesReceived') return bytes(value);
  return formatNumber(value, 0);
}

function RunMonitor({ run, metrics, onCancel, cancelling, onRepeat }: { run: LabRun; metrics: string[]; onCancel: () => void; cancelling: boolean; onRepeat: () => void }) {
  const toast = useToast();
  const [error, setError] = useState<unknown>();
  const [exporting, setExporting] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (run.status !== 'running') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [run.status]);
  const elapsed = run.current ? Math.max(0, Math.round((now - Date.parse(run.current.startedAt)) / 1000)) : 0;
  const scheduled = run.current?.seconds ?? 0;
  const progress = scheduled ? Math.min(100, elapsed / scheduled * 100) : 0;
  const shown = metricOptions.filter((item) => metrics.includes(item.key) && !['cpu', 'memory', 'database'].includes(item.key));
  async function download() {
    setExporting(true); setError(undefined);
    try {
      const report = await labApi.report(run.id);
      const href = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = href; anchor.download = `${run.label}-report.txt`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000); toast('Text report downloaded.');
    } catch (e) { setError(e); } finally { setExporting(false); }
  }
  return <section className="card studio-section">
    <SectionTitle title={run.label} action={<div className="row gap-xs wrap"><Status status={run.status} />{run.status === 'running' ? <button type="button" className="btn btn-soft btn-sm" disabled={cancelling} onClick={onCancel}>{cancelling ? 'Stopping…' : 'Stop test'}</button> : <><button className="btn btn-soft btn-sm" onClick={onRepeat}>Repeat with these settings</button><button className="btn btn-primary btn-sm" disabled={exporting} onClick={download}>{exporting ? 'Preparing…' : 'Export report'}</button></>}</div>}>{run.scenario.name} · {formatDateTime(run.createdAt)}</SectionTitle>
    {run.sourceNote && <div className="studio-source-note"><span className="caption muted">Implementation</span><p>{run.sourceNote}</p></div>}
    <InlineError error={error || (run.error ? new Error(run.error) : undefined)} />
    {run.current && <div className="studio-live-progress"><div className="row gap-sm wrap"><span className="spinner spinner-sm" /><strong>{run.current.phase === 'warmup' ? 'Warming up' : 'Measuring'} · repetition {run.current.repeat} / {run.scenario.load.repeat}</strong><span className="caption muted">{elapsed}s elapsed{scheduled > 0 ? ` / ${scheduled}s ${run.scenario.load.mode === 'iterations' ? 'time limit' : 'scheduled'}` : ''}</span></div>{scheduled > 0 && <div className="progress" role="progressbar" aria-label="Phase elapsed time" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress}%` }} /></div>}<p className="caption muted">{run.current.phase === 'warmup' ? 'Warm-up responses prepare the application and are excluded from final measurements.' : 'The chart follows actual completed requests. Final percentiles appear when measurement finishes.'}</p></div>}
    <div className="studio-metrics">{shown.map((metric) => <article key={metric.key}><span>{metric.name}</span><strong>{metricValue(metric.key, run.metrics)}</strong><small>{metric.help}</small></article>)}</div>
    <div><SectionTitle title="Response time over the run">Hover over the chart for measured response times at each second.</SectionTitle><LatencyChart points={run.timeline ?? []} /></div>
    {run.requestMetrics?.length > 0 && <div><SectionTitle title="Which request takes the time?">Each endpoint is measured separately, so a fast request cannot hide a slow one in the overall average.</SectionTitle><div className="studio-table-wrap"><table className="studio-table"><thead><tr><th>Request</th><th>Completed</th><th>P50</th><th>P95</th><th>P99</th><th>HTTP errors</th><th>Checks passed</th></tr></thead><tbody>{run.requestMetrics.map((item) => <tr key={item.requestId}><td><strong>{item.name}</strong><small>{run.scenario.requests.find((request) => request.id === item.requestId)?.path}</small></td>{['requests', 'p50', 'p95', 'p99', 'errors', 'checks'].map((key) => <td key={key}>{metricValue(key, item)}</td>)}</tr>)}</tbody></table></div></div>}
    {run.repetitions?.length > 1 && <details className="studio-details"><summary>Results for each repetition</summary><div className="studio-table-wrap"><table className="studio-table"><thead><tr><th>Repetition</th><th>Status</th><th>Requests</th><th>P50</th><th>P95</th><th>P99</th><th>HTTP errors</th></tr></thead><tbody>{run.repetitions.map((rep) => <tr key={rep.repeat}><td>{rep.repeat}</td><td><Status status={rep.status} /></td>{['requests', 'p50', 'p95', 'p99', 'errors'].map((key) => <td key={key}>{metricValue(key, rep.metrics)}</td>)}</tr>)}</tbody></table></div></details>}
    {metrics.some((key) => ['cpu', 'memory', 'database'].includes(key)) && <ObservationPanel run={run} metrics={metrics} />}
    {run.monitoringNote && <p className="caption muted">{run.monitoringNote}</p>}
    {run.notes?.length ? <details className="studio-details"><summary>Measurement notes</summary><ul className="caption muted">{run.notes.map((note, i) => <li key={i}>{note}</li>)}</ul></details> : null}
    <RequestHistory run={run} />
    <details className="studio-details" open={run.status === 'failed' || run.status === 'interrupted'}><summary>Run output · k6 checks and errors</summary><pre className="studio-code">{run.logs || 'No output recorded yet.'}</pre></details>
    <details className="studio-details"><summary>Exact configuration used for this run</summary><p className="caption muted">This saved snapshot is independent of later scenario edits.</p><pre className="studio-code">{JSON.stringify(run.scenario, null, 2)}</pre></details>
  </section>;
}

function RequestHistory({ run }: { run: LabRun }) {
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<RequestRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<unknown>();
  const [selected, setSelected] = useState<RequestRecord | null>(null);
  useEffect(() => { setPage(1); setSelected(null); }, [run.id]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const data = await labApi.requests(run.id, page); if (alive) { setItems(data.items); setTotal(data.total); setError(undefined); } }
      catch (e) { if (alive) setError(e); }
      if (alive && run.status === 'running') timer = setTimeout(load, 2000);
    }
    load(); return () => { alive = false; clearTimeout(timer); };
  }, [run.id, page, run.status]);
  return <div className="studio-request-history"><SectionTitle title="HTTP exchanges">Status and response headers for each measured request. Warm-up traffic is excluded.</SectionTitle><InlineError error={error} />
    {!items.length ? <p className="muted caption">No measured HTTP exchanges on this page yet.</p> : <div className="studio-table-wrap"><table className="studio-table"><thead><tr><th>#</th><th>Request</th><th>HTTP status</th><th>Response time</th><th>Iteration / repetition</th><th>Response</th></tr></thead><tbody>{items.map((item) => <tr key={item.sequence}><td>{item.sequence}</td><td><strong>{item.name}</strong><small>{item.method} {item.url}</small></td><td><span className={`badge ${item.status >= 400 || !item.status ? 'badge-error' : 'badge-soft'}`}>{item.status || 'Network error'}</span></td><td>{formatMs(item.durationMs)}</td><td>{item.iteration} / {item.repeat}</td><td><button className="btn btn-soft btn-sm" onClick={() => setSelected(item)}>Inspect</button></td></tr>)}</tbody></table></div>}
    <div className="studio-pagination"><span className="caption muted">{formatNumber(total, 0)} measured exchanges · page {page} of {Math.max(1, Math.ceil(total / 25))}</span><div className="row gap-xs"><button className="btn btn-soft btn-sm" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>Previous</button><button className="btn btn-soft btn-sm" disabled={page * 25 >= total} onClick={() => setPage((n) => n + 1)}>Next</button></div></div>
    {selected && <div className="studio-exchange"><div className="studio-list-heading"><h4>Exchange #{selected.sequence} · {selected.name}</h4><button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>Close</button></div><div className="row gap-sm wrap"><strong>HTTP {selected.status || 'network error'}</strong><span>{formatMs(selected.durationMs)}</span><code>{selected.method} {selected.url}</code></div><pre className="studio-code">{Object.entries(selected.headers ?? {}).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : value}`).join('\n') || '(no response headers)'}</pre>{selected.error && <InlineError error={new Error(selected.error)} />}<div className="row wrap gap-xs">{selected.checks?.map((check, i) => <span key={i} className={`badge ${check.passed ? 'badge-soft' : 'badge-error'}`}>{check.passed ? '✓' : '×'} {check.label}</span>)}</div><p className="caption muted">Response bodies are shown by Preview. Load-test exchanges retain status, headers, timing, and checks to limit storage and overhead.</p></div>}
  </div>;
}

function ObservationPanel({ run, metrics }: { run: LabRun; metrics: string[] }) {
  const samples = run.observations as unknown as Telemetry[];
  const cpu = samples.map((s) => s.api?.cpuPercent).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const memory = samples.map((s) => s.api?.memoryBytes).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const database = samples.filter((s) => s.database?.available).at(-1)?.database;
  const average = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return <div className="studio-observations"><SectionTitle title="Backend observations">Samples from the API process and app database during this run; not load-generator CPU or memory.</SectionTitle><div className="studio-metrics">
    {metrics.includes('cpu') && <article><span>API CPU · sampled average</span><strong>{cpu.length ? `${formatNumber(average(cpu))}%` : 'Unavailable'}</strong><small>100% = one core. {cpu.length} samples.</small></article>}
    {metrics.includes('memory') && <article><span>API memory · sampled peak</span><strong>{memory.length ? bytes(Math.max(...memory)) : 'Unavailable'}</strong><small>Working set of the API process.</small></article>}
    {metrics.includes('database') && <><article><span>Database transactions · latest sample</span><strong>{database?.transactionsPerSecond == null ? 'Unavailable' : `${formatNumber(database.transactionsPerSecond)} /s`}</strong><small>Includes all activity in the app database.</small></article><article><span>Database cache hit rate · latest sample</span><strong>{database?.cacheHitRate == null ? 'Unavailable' : percent(database.cacheHitRate)}</strong><small>PostgreSQL buffer cache, not Redis.</small></article><article><span>Database active connections</span><strong>{formatNumber(database?.activeConnections, 0)}</strong><small>At the last available sample.</small></article></>}
  </div>{samples.at(-1)?.notes?.map((note, index) => <p className="caption muted" key={index}>{note}</p>)}{!samples.length && <p className="caption muted">No telemetry was available for this run. HTTP timings are still measured independently.</p>}</div>;
}

function ComparisonPanel({ runs, selected, before, after, setBefore, setAfter }: { runs: LabRun[]; selected: string[]; before: string; after: string; setBefore: (id: string) => void; setAfter: (id: string) => void }) {
  const [comparison, setComparison] = useState<LabComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>();
  const [exporting, setExporting] = useState(false);
  const finished = runs.filter((r) => r.status !== 'running');
  useEffect(() => {
    if (!before || !after || before === after) { setComparison(null); return; }
    let alive = true; setLoading(true); setError(undefined); setComparison(null);
    labApi.compare(before, after).then((result) => { if (alive) setComparison(result); }).catch((e) => { if (alive) setError(e); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [before, after]);
  const series = comparison ? [comparison.before, comparison.after].map((run, i) => ({ label: run.label, color: i ? '#1baf7a' : '#2a78d6', values: run.metrics && run.metrics.p50 != null && run.metrics.p95 != null && run.metrics.p99 != null ? { p50: run.metrics.p50, p95: run.metrics.p95, p99: run.metrics.p99 } : null })) : [];
  const displayValue = (value: number | null, key: string, unit: string) => value == null ? 'Unavailable' : unit === 'ratio' ? percent(value) : key === 'memory' || key === 'bytesReceived' ? bytes(value) : `${formatNumber(value, 2)}${unit ? ` ${unit}` : ''}`;
  async function downloadComparison() {
    if (!comparison) return;
    setExporting(true); setError(undefined);
    try {
      const report = await labApi.comparisonReport(comparison.before.id, comparison.after.id);
      const href = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = href; link.download = `${comparison.before.label}-vs-${comparison.after.label}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(href), 1000);
    } catch (e) { setError(e); } finally { setExporting(false); }
  }
  const databaseNames: Record<string, string> = { dbTransactions: 'Database transactions · sampled mean', dbCacheHit: 'Database cache hits · sampled mean', dbConnections: 'Database active connections · sampled mean' };
  return <section className="card studio-section"><SectionTitle title="Before & after" action={comparison && <button className="btn btn-soft btn-sm" disabled={exporting} onClick={downloadComparison}>{exporting ? 'Preparing…' : 'Export comparison'}</button>}>Compare saved measurements from the same workload and fixture. A label does not change the application.</SectionTitle>
    <div className="studio-grid-2"><SelectField label="Before · baseline run" value={before} onChange={setBefore}><option value="">Choose the baseline</option>{finished.map((r) => <option key={r.id} value={r.id}>{r.label} · {r.scenario.name}</option>)}</SelectField><SelectField label="After · optimized run" value={after} onChange={setAfter}><option value="">Choose the later run</option>{finished.filter((r) => r.id !== before).map((r) => <option key={r.id} value={r.id}>{r.label} · {r.scenario.name}</option>)}</SelectField></div>
    <InlineError error={error} />{loading && <Spinner label="Comparing saved measurements" />}
    {!comparison && !loading && <div className="studio-compare-empty"><span>01</span><p>Run your scenario as <strong>before</strong>.</p><span>02</span><p>Optimize the backend, then repeat the same scenario.</p><span>03</span><p>Choose both saved runs above to compare.</p></div>}
    {comparison && <><Notice title={comparison.comparable ? 'Matching test configurations.' : 'These runs are not a like-for-like comparison.'} tone={comparison.comparable ? 'soft' : 'error'}>{comparison.reasons.length ? comparison.reasons.join(' ') : comparison.before.datasetFingerprint && comparison.after.datasetFingerprint ? 'The request configuration, load settings, and recorded fixture match. Results are saved independently of your current source code.' : 'The requests and load settings match. No prepared dataset snapshot was recorded; verify that both runs used the same database contents.'}</Notice>
      {selected.some((key) => ['p50', 'p95', 'p99'].includes(key)) && <CompareChart series={series} />}
      <div className="studio-table-wrap"><table className="studio-table"><thead><tr><th>Metric</th><th>{comparison.before.label}</th><th>{comparison.after.label}</th><th>Change</th></tr></thead><tbody>{comparison.metrics.filter((m) => selected.includes(m.key) || (selected.includes('database') && m.key.startsWith('db'))).map((m) => { const positive = m.changePercent != null && m.changePercent > 0; const direction = m.before == null || m.after == null || m.before === m.after ? 'change' : m.after < m.before ? 'lower' : 'higher'; return <tr key={m.key}><td>{databaseNames[m.key] ?? metricOptions.find((item) => item.key === m.key)?.name ?? m.key}</td><td>{displayValue(m.before, m.key, m.unit)}</td><td>{displayValue(m.after, m.key, m.unit)}</td><td>{!comparison.comparable || m.changePercent == null ? '—' : <span className={`studio-delta ${positive ? 'good' : m.changePercent !== 0 ? 'bad' : ''}`}>{Math.abs(m.changePercent).toFixed(1)}% {direction}</span>}</td></tr>; })}</tbody></table></div>
      {comparison.notes?.map((note, index) => <p className="caption muted" key={index}>{note}</p>)}
    </>}
  </section>;
}

function PrepareData({ onUse, testRunning }: { onUse: (manifest: DataManifest) => void; testRunning: boolean }) {
  const [state, setState] = useState<DataState | null>(null);
  const [config, setConfig] = useState<DataConfig>({ orders: 100000, products: 1000, stockMin: 10, stockMax: 100, customers: 1000, customerEvery: 50 });
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const toast = useToast();
  const initial = useRef(true);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try { const result = await labApi.data(); if (alive) { setState(result); if (initial.current && result.manifest) setConfig(result.manifest.config); initial.current = false; } }
      catch (e) { if (alive) setError(e); }
      if (alive) timer = setTimeout(load, 2500);
    }
    load(); return () => { alive = false; clearTimeout(timer); };
  }, []);
  async function prepare() {
    setBusy(true); setError(undefined);
    try { await labApi.prepare({ ...config, customerPassword: password || undefined, acceptDatasetChange: accepted }); setPassword(''); setAccepted(false); setState(await labApi.data()); toast('Fixture preparation started. Progress appears below.'); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }
  const running = state?.job?.status === 'running';
  const manifest = state?.manifest;
  return <div className="studio-data">
    <section className="card studio-section"><SectionTitle number="01" title="Prepare a repeatable database fixture">Choose the volume and stock distribution. These records are inserted before testing, outside the measured run.</SectionTitle>
      <InlineError error={error} />
      {state && !state.enabled && <Notice title="Data preparation is unavailable in this environment.">{state.reason || 'Start the dedicated benchmark stack to enable fixture preparation.'}</Notice>}
      <div className="studio-data-presets"><span className="caption muted">Start with</span>{[50000, 100000, 150000].map((n) => <button type="button" className="btn btn-soft btn-sm" key={n} onClick={() => setConfig({ ...config, orders: n })}>{n / 1000}K orders</button>)}<span className="caption muted">or enter any supported volume below</span></div>
      <div className="studio-grid-3"><NumberField label="Studio fixture orders" value={config.orders} min={0} max={1000000} onChange={(orders) => setConfig({ ...config, orders })} hint="Exact fixture size, from 0 to 1,000,000." /><NumberField label="Studio fixture products" value={config.products} min={config.orders ? 1 : 0} max={200000} onChange={(products) => setConfig({ ...config, products })} hint="Products also receive inventory records." /><NumberField label="Fixture customers" value={config.customers} min={1} max={10000} onChange={(customers) => setConfig({ ...config, customers })} hint="Distribute orders across these test customers." /><NumberField label="Stock per product · minimum" value={config.stockMin} min={0} max={1000000} onChange={(stockMin) => setConfig({ ...config, stockMin })} /><NumberField label="Stock per product · maximum" value={config.stockMax} min={config.stockMin} max={1000000} onChange={(stockMax) => setConfig({ ...config, stockMax })} /><NumberField label="Benchmark customer owns every Nth order" value={config.customerEvery} min={1} max={10000} onChange={(customerEvery) => setConfig({ ...config, customerEvery })} hint={`About ${formatNumber(Math.floor(config.orders / config.customerEvery), 0)} fixture orders for the login-enabled customer.`} /></div>
      <TextField type="password" autoComplete="new-password" label="Password for a new benchmark customer" value={password} minLength={8} onChange={(e) => setPassword(e.target.value)} hint="Needed only if benchmark-customer@example.invalid does not exist yet. An existing account keeps its password." />
      <label className="studio-write-confirm"><input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} /><span><strong>Prepare these fixtures in the benchmark databases.</strong><small>This replaces the studio-owned fixture and sets its inventory. Existing unrelated shop records are retained. The application’s total counts may therefore be higher than the fixture counts.</small></span></label>
      <div className="studio-launch"><p className="caption muted">Use the same prepared fixture for before and after. Data preparation cannot run alongside a load test.</p><button className="btn btn-primary" disabled={!state?.enabled || !accepted || busy || running || testRunning} onClick={prepare}>{busy || running ? 'Preparing fixture…' : 'Prepare fixture'}</button></div>
    </section>
    {state?.job && <section className="card studio-section"><SectionTitle title="Preparation activity" action={<Status status={state.job.status} />}>{state.job.phase}</SectionTitle>{running && <Spinner label="Preparing records" />}<InlineError error={state.job.error ? new Error(state.job.error) : undefined} /><pre className="studio-code">{state.job.logs.join('\n') || 'Waiting for progress…'}</pre></section>}
    {manifest && <section className="card studio-section"><SectionTitle number="02" title="Current prepared fixture" action={<button className="btn btn-soft" onClick={() => { onUse(manifest); }}>Use in my scenario</button>}>Prepared {formatDateTime(manifest.preparedAt)}. The fingerprint is saved with new tests for comparison.</SectionTitle><div className="studio-metrics"><article><span>Total orders in database</span><strong>{formatNumber(manifest.counts.orders, 0)}</strong><small>{formatNumber(manifest.fixture.orders, 0)} studio fixture orders.</small></article><article><span>Total products in database</span><strong>{formatNumber(manifest.counts.products, 0)}</strong><small>{formatNumber(manifest.fixture.products, 0)} studio fixture products.</small></article><article><span>Benchmark customer’s orders</span><strong>{formatNumber(manifest.counts.customerOrders, 0)}</strong><small>Use this count for an optional response check.</small></article><article><span>Inventory records</span><strong>{formatNumber(manifest.counts.inventory, 0)}</strong><small>Configured stock range {manifest.config.stockMin}–{manifest.config.stockMax}.</small></article></div><div className="studio-source-note"><span className="caption muted">Fixture fingerprint</span><code>{manifest.fingerprint}</code></div><details className="studio-details"><summary>Sample product IDs</summary><pre className="studio-code">{manifest.samples.productIds.join('\n')}</pre></details></section>}
  </div>;
}
