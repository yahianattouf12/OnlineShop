import { api } from './client';

// The benchmark service (benchmark/, Requirement 3). Same site, its own API; it accepts the admin's shop token.
const base = '/benchmark-api/v1';
const call = <T>(path: string, options: Parameters<typeof api>[1] = {}) => api<T>(path, { ...options, base });

export type CaseId = 'orders-first' | 'orders-deep' | 'orders-customer' | 'product-hot' | 'product-etag';
export type ProfileId = 'standard' | 'quick';

export interface BenchmarkCase {
  id: CaseId;
  title: string;
  request: string;
  role: 'admin' | 'customer' | 'anonymous';
  layer: string;
  measures: string;
}

export interface Profile {
  warmup: string;
  duration: string;
  seconds: number;
}

export interface Expected {
  orders: number;
  customerOrders: number;
  productStock: number;
  productName: string;
  customerEmail: string;
}

export interface Health {
  status: 'ok';
  k6: string | null;
  appUrl: string;
  runningRunId: string | null;
}

export interface CasesResponse {
  cases: BenchmarkCase[];
  profiles: Record<ProfileId, Profile>;
  rate: number;
  expected: Expected;
}

export interface PreflightCheck {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'info';
  detail: string;
  hint: string | null;
}

export interface Preflight {
  checkedAt: string;
  productId: string | null;
  customerEmail: string;
  customerReady: boolean;
  expected: Expected;
  dataset: { orders: number | null; customerOrders: number | null; productStock: number | null; etag: string | null };
  checks: PreflightCheck[];
  cases: Record<CaseId, { ready: boolean; reasons: string[] }>;
}

/** What api-tests/task3/benchmark.js writes in its summary. Latencies in ms. */
export interface Metrics {
  p50: number;
  p95: number;
  p99: number;
  requests: number;
  requestsPerSecond: number;
  failedRate: number | null;
  checkRate: number | null;
  dropped: number;
  bytesReceived: number;
  status200: number;
  status304: number;
}

export interface Workload {
  url: string;
  rate: number;
  duration: string;
  preAllocatedVUs: number;
  warmup: string;
  role: string;
  expectedOrders: number | null;
  expectedStock: number | null;
}

export interface TimelinePoint {
  second: number;
  requests: number;
  failed: number;
  p50: number;
  p95: number;
  max: number;
}

export type StepStatus = 'waiting' | 'warmup' | 'measuring' | 'passed' | 'failed' | 'cancelled' | 'skipped';
export type RunStatus = 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';

export interface RunStep {
  case: CaseId;
  status: StepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  metrics: Metrics | null;
  error: string | null;
}

export interface Run {
  id: string;
  label: string;
  cases: CaseId[];
  etag: boolean;
  profile: ProfileId;
  plan: Profile & { rate: number };
  productId: string | null;
  status: RunStatus;
  startedBy: string;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  current: { case: CaseId; phase: 'warmup' | 'measure'; startedAt: string; seconds: number } | null;
  steps: RunStep[];
}

export interface RunDetails extends Run {
  live: { case: CaseId; phase: 'warmup' | 'measure'; elapsedSeconds: number; points: TimelinePoint[] } | null;
  timelines: Partial<Record<string, TimelinePoint[]>>;
}

export interface SavedResult {
  workload?: Workload;
  metrics?: Metrics;
  expectedStatus?: 200 | 304;
  passed?: boolean;
  problem?: string;
  savedAt: string | null;
  runner?: 'dashboard' | 'cli';
}

export interface LabelResults {
  label: string;
  firstSaved: string | null;
  cases: Partial<Record<CaseId, SavedResult>>;
}

export interface Comparison {
  label: string;
  result: SavedResult | null;
  comparable: boolean;
  reason: string | null;
  change: {
    p50: number | null;
    p95: number | null;
    p99: number | null;
    bytesPerRequest: { before: number; after: number };
    status: { before: number; after: number } | null;
  } | null;
}

export interface CompareResponse {
  baseline: string;
  labels: string[];
  cases: { case: CaseId; baseline: SavedResult | null; comparisons: Comparison[] }[];
}

export type ProofMode = 'etag-stock' | 'read-after-write';

export interface ProofResult {
  id: string;
  mode: ProofMode;
  title: string;
  passed: boolean;
  output: string;
  startedAt: string;
  durationMs: number;
  startedBy: string;
}

export interface StartRun {
  label: string;
  cases: CaseId[];
  profile: ProfileId;
  etag: boolean;
  productId?: string;
  customerPassword?: string;
}

export const benchmarkApi = {
  health: () => call<Health>('/health', { token: null }),
  cases: () => call<CasesResponse>('/cases', { token: null }),
  preflight: (productId?: string) => call<Preflight>(`/preflight${productId ? `?productId=${encodeURIComponent(productId)}` : ''}`),
  /** The password goes in the body, never in a URL (URLs end up in logs). */
  customerSession: (password: string) =>
    call<{ email: string; id: string; expiresAt: string }>('/customer-session', { method: 'POST', body: { password } }),
  start: (body: StartRun) => call<Run>('/runs', { method: 'POST', body }),
  runs: () => call<{ runs: Run[]; runningRunId: string | null }>('/runs'),
  run: (id: string) => call<RunDetails>(`/runs/${id}`),
  cancel: (id: string) => call<Run>(`/runs/${id}/cancel`, { method: 'POST' }),
  results: () => call<{ labels: LabelResults[] }>('/results'),
  compare: (baseline: string, labels: string[]) =>
    call<CompareResponse>(`/compare?baseline=${encodeURIComponent(baseline)}&labels=${labels.map(encodeURIComponent).join(',')}`),
  proofs: () => call<{ proofs: ProofResult[] }>('/proofs'),
  proof: (mode: ProofMode, body: { productId?: string; customerPassword?: string; acceptDatasetChange?: boolean }) =>
    call<ProofResult>(`/proofs/${mode}`, { method: 'POST', body }),
};
