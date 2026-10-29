import type { ProblemDetails } from './types';

/** Every non-2xx response becomes an ApiError carrying the Problem Details body. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, problem: ProblemDetails, retryAfterSeconds: number | null) {
    super(problem.detail || problem.title || `Request failed (${status})`);
    this.status = status;
    this.problem = problem;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  /** Validation messages for one field. The API uses PascalCase keys ("Email"), so match case-insensitively. */
  fieldErrors(field: string): string[] {
    const errors = this.problem.errors ?? {};
    const key = Object.keys(errors).find((k) => k.toLowerCase() === field.toLowerCase());
    return key ? errors[key] : [];
  }
}

/** A raw view of one exchange, used by the Security checks page to show exactly what happened. */
export interface Exchange {
  method: string;
  url: string;
  requestBody?: unknown;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
}

let tokenProvider: () => string | null = () => null;
let onUnauthorized: () => void = () => {};

/** Wired once by AuthProvider, so the client always sends the current token. */
export function configureClient(options: { getToken: () => string | null; onUnauthorized: () => void }) {
  tokenProvider = options.getToken;
  onUnauthorized = options.onUnauthorized;
}

export const API_BASE = '/api/v1';

interface RequestOptions {
  method?: string;
  body?: unknown;
  form?: FormData;
  /** Overrides the stored token: a specific token, or null to send none. */
  token?: string | null;
  signal?: AbortSignal;
}

async function send(path: string, options: RequestOptions) {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = options.token === undefined ? tokenProvider() : options.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form; // the browser sets the multipart boundary
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const response = await fetch(API_BASE + path, {
    method: options.method ?? 'GET',
    headers,
    body,
    signal: options.signal,
  });

  const text = await response.text();
  let parsed: unknown = text;
  if (text && (response.headers.get('Content-Type') ?? '').includes('json')) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { response, parsed };
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { response, parsed } = await send(path, options);

  if (!response.ok) {
    const problem: ProblemDetails =
      parsed && typeof parsed === 'object' ? (parsed as ProblemDetails) : { status: response.status, title: response.statusText };
    const retryAfter = response.headers.get('Retry-After');

    // An expired or invalid session: only when we actually sent the stored token.
    if (response.status === 401 && options.token === undefined && tokenProvider()) onUnauthorized();

    throw new ApiError(response.status, problem, retryAfter ? Number(retryAfter) : null);
  }

  return (response.status === 204 ? undefined : parsed) as T;
}

/** Like api(), but never throws: returns the full request/response for display. */
export async function exchange(path: string, options: RequestOptions = {}): Promise<Exchange> {
  const { response, parsed } = await send(path, options);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    method: options.method ?? 'GET',
    url: API_BASE + path,
    requestBody: options.body,
    status: response.status,
    statusText: response.statusText,
    headers,
    body: parsed,
  };
}
