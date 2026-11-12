import { api } from './client';
import type { TimelinePoint } from './benchmark';

const call = <T>(path: string, options: Parameters<typeof api>[1] = {}) =>
  api<T>(path, { ...options, base: '/benchmark-api/v1/lab' });

export type MetricKey = 'p50' | 'p95' | 'p99' | 'throughput' | 'errors' | 'checks' | 'requests' | 'dropped' | 'bytesReceived' | 'cpu' | 'memory' | 'database';
export interface LabRequest {
  id: string;
  name: string;
  method: string;
  path: string;
  role: 'admin' | 'customer' | 'anonymous';
  headers: Record<string, string>;
  query: Record<string, string>;
  body: string;
  expectedStatuses: number[];
  assertions: { path: string; operator: 'eq' | 'exists' | 'contains'; value?: unknown }[];
  enabled: boolean;
}
export interface Scenario {
  id?: string;
  name: string;
  requests: LabRequest[];
  data: { rows: Record<string, unknown>[]; ranges: { name: string; min: number; max: number; step: number }[] };
  load: { mode: 'iterations' | 'duration' | 'rate'; iterations: number; duration: number; warmup: number; concurrency: number; rate: number; repeat: number; pauseMs: number };
  thresholds: { p95: number; errorRate: number; checks: number };
  metrics: string[];
  datasetTag: string;
}
export interface LabMetrics {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  throughput: number;
  errors: number;
  checks: number;
  requests: number;
  dropped: number;
  bytesReceived: number;
  cpu?: number | null;
  memory?: number | null;
  dbTransactions?: number | null;
  dbCacheHit?: number | null;
  dbConnections?: number | null;
}
export interface LabRun {
  datasetFingerprint?: string | null;
  id: string;
  label: string;
  scenario: Scenario;
  status: 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
  sourceNote: string;
  createdAt: string;
  finishedAt: string | null;
  current: { phase: 'warmup' | 'measure'; repeat: number; seconds: number; startedAt: string } | null;
  metrics: LabMetrics | null;
  timeline: TimelinePoint[];
  repetitions: { repeat: number; status: string; metrics: LabMetrics | null }[];
  observations: Record<string, unknown>[];
  error: string | null;
  requestCount: number;
  requestMetrics: ({ requestId: string; name: string } & LabMetrics)[];
  notes?: string[];
  monitoringNote?: string;
  logs?: string;
}
export interface Inspection {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string | string[]>;
  body: string | unknown;
  durationMs: number;
  checks: { label: string; passed: boolean }[];
  truncated?: boolean;
  note?: string;
  error?: string;
}
export interface RequestRecord extends Omit<Inspection, 'body'> {
  sequence: number;
  requestId: string;
  name: string;
  iteration: number;
  repeat: number;
  at: string;
  error?: string;
}
export interface LabComparison {
  before: LabRun;
  after: LabRun;
  comparable: boolean;
  reasons: string[];
  metrics: { key: string; before: number | null; after: number | null; changePercent: number | null; unit: string; lowerIsBetter: boolean }[];
  notes?: string[];
}

export interface DataConfig {
  orders: number;
  products: number;
  stockMin: number;
  stockMax: number;
  customers: number;
  customerEvery: number;
}
export interface DataManifest {
  id: string;
  preparedAt: string;
  config: DataConfig;
  counts: { orders: number; products: number; customerOrders: number; inventory: number };
  fixture: { orders: number; products: number; customers: number };
  samples: { productIds: string[]; orderIds: string[]; customerId: string | null };
  fingerprint: string;
}
export interface DataState {
  enabled: boolean;
  reason: string | null;
  job: null | { id: string; status: 'running' | 'passed' | 'failed'; phase: string; startedAt: string; finishedAt: string | null; error: string | null; logs: string[] };
  manifest: DataManifest | null;
}
export interface Telemetry {
  sampledAt: string;
  api: { available: boolean; cpuPercent: number | null; memoryBytes: number | null; logicalProcessors?: number };
  database: { available: boolean; transactionsPerSecond: number | null; cacheHitRate: number | null; activeConnections: number | null };
  notes: string[];
}

export const labApi = {
  scenarios: () => call<{ scenarios: Scenario[] }>('/scenarios'),
  saveScenario: (scenario: Scenario) => call<Scenario>('/scenarios', { method: 'POST', body: scenario }),
  deleteScenario: (id: string) => call<void>(`/scenarios/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  start: (body: { label: string; scenario: Scenario; sourceNote: string; customerPassword?: string; acceptWrites: boolean }) => call<LabRun>('/runs', { method: 'POST', body }),
  runs: () => call<{ runs: LabRun[]; runningRunId: string | null }>('/runs'),
  run: (id: string) => call<LabRun>(`/runs/${encodeURIComponent(id)}`),
  cancel: (id: string) => call<LabRun>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} }),
  requests: (id: string, page: number) => call<{ page: number; pageSize: number; total: number; items: RequestRecord[] }>(`/runs/${encodeURIComponent(id)}/requests?page=${page}&pageSize=25`),
  inspect: (body: { scenario: Scenario; requestId: string; customerPassword?: string; acceptWrites: boolean }) => call<Inspection>('/inspect', { method: 'POST', body }),
  compare: (before: string, after: string) => call<LabComparison>(`/compare?before=${encodeURIComponent(before)}&after=${encodeURIComponent(after)}`),
  comparisonReport: (before: string, after: string) => call<string>(`/compare?before=${encodeURIComponent(before)}&after=${encodeURIComponent(after)}&format=txt`),
  report: (id: string) => call<string>(`/runs/${encodeURIComponent(id)}/report`),
  data: () => call<DataState>('/data'),
  prepare: (body: DataConfig & { customerPassword?: string; acceptDatasetChange: boolean }) => call<DataState>('/data', { method: 'POST', body }),
  telemetry: () => call<Telemetry>('/telemetry'),
};
