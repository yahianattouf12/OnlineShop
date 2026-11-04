import { useState } from 'react';
import { exchange, type Exchange } from '../api/client';
import { ordersApi } from '../api/endpoints';
import { useAuth } from '../auth/AuthContext';
import { Icon } from '../components/Icon';
import { Notice, PageHeader } from '../components/ui';

/**
 * Live security checks for Requirement 1. Each one sends a real request that a well-behaved UI would
 * never send (someone else's order, a customer changing a status, a forged token, ...) and shows that
 * the API itself rejects it. The UI hiding a button is not security; these prove the server enforces it.
 */

const SECURITY_HEADERS = ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'content-security-policy'];
const RANDOM_ID = () => crypto.randomUUID();

/** Takes a real JWT, changes the role inside it to Admin, and keeps the old signature. */
function forgeAdminToken(token: string) {
  const [header, payload, signature] = token.split('.');
  const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  json.role = 'Admin';
  const forged = btoa(JSON.stringify(json)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return [header, forged, signature].join('.');
}

interface Check {
  id: string;
  title: string;
  proves: string;
  expected: number[];
  /** Which roles can meaningfully run it. */
  roles: ('Customer' | 'Admin')[];
  warning?: string;
  needsOrderId?: boolean;
  run: (ctx: { token: string; orderId: string }) => Promise<Exchange>;
  showHeaders?: boolean;
}

const CHECKS: Check[] = [
  {
    id: 'idor',
    title: 'Open another customer’s order.',
    proves: 'Customers see only their own orders (IDOR / broken object level authorization). The order is filtered by the owner from the token, so it “doesn’t exist” for anyone else.',
    expected: [404],
    roles: ['Customer'],
    needsOrderId: true,
    run: ({ orderId }) => exchange(`/orders/${orderId}`),
  },
  {
    id: 'status',
    title: 'Change an order’s status as a customer.',
    proves: 'Only the admin can change an order’s status, even the order’s owner cannot. Uses your newest order.',
    expected: [403],
    roles: ['Customer'],
    run: async () => {
      const mine = await ordersApi.list({ pageSize: 1 }).catch(() => null);
      const id = mine?.items[0]?.id ?? RANDOM_ID();
      return exchange(`/orders/${id}/status`, { method: 'PATCH', body: { status: 'Delivered' } });
    },
  },
  {
    id: 'admin-endpoint',
    title: 'Call an admin-only endpoint.',
    proves: 'Roles are checked on the server: the user list is admin only.',
    expected: [403],
    roles: ['Customer'],
    run: () => exchange('/users'),
  },
  {
    id: 'forged',
    title: 'Send a token edited to say “Admin”.',
    proves: 'The JWT signature protects its contents. Changing the role breaks the signature, so the token is rejected.',
    expected: [401],
    roles: ['Customer', 'Admin'],
    run: ({ token }) => exchange('/users', { token: forgeAdminToken(token) }),
  },
  {
    id: 'no-token',
    title: 'Call a protected endpoint without a token.',
    proves: 'Authentication is required: no token, no access.',
    expected: [401],
    roles: ['Customer', 'Admin'],
    run: () => exchange('/orders', { token: null }),
    showHeaders: true,
  },
  {
    id: 'validation',
    title: 'Send invalid input.',
    proves: 'Invalid input gets 422 in the same Problem Details format as every other error.',
    expected: [422],
    roles: ['Customer', 'Admin'],
    run: () => exchange('/products?pageSize=1000', { token: null }),
  },
  {
    id: 'brute-force',
    title: 'Try to guess a password.',
    proves: 'Login is limited to 5 attempts per minute per IP. Sends wrong passwords until the server answers 429.',
    expected: [429],
    roles: ['Customer', 'Admin'],
    warning: 'Afterwards nobody on this computer can log in for about a minute (you stay logged in).',
    run: async () => {
      let last: Exchange | undefined;
      for (let i = 0; i < 8; i++) {
        last = await exchange('/auth/login', {
          method: 'POST',
          body: { email: 'attacker@example.com', password: `guess-${i}` },
          token: null,
        });
        if (last.status === 429) break;
      }
      return last!;
    },
  },
];

type Result = { exchange?: Exchange; error?: string; running: boolean };

function ResultView({ check, result }: { check: Check; result: Result }) {
  if (result.running) {
    return (
      <div className="check-result">
        <span className="row gap-xs body-sm muted">
          <span className="spinner" /> Sending request…
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
  const ex = result.exchange!;
  const ok = check.expected.includes(ex.status);
  return (
    <div className="check-result">
      <div className="row gap-sm wrap">
        <span className={`badge ${ok ? 'badge-ink' : 'badge-outline'}`}>
          <Icon name={ok ? 'check' : 'alert'} size={14} />
          {ok ? 'Rejected as expected' : 'Unexpected result'}
        </span>
        <span className="mono">
          {ex.method} {ex.url} → <span className="strong">{ex.status} {ex.statusText}</span>
        </span>
      </div>
      {check.showHeaders && (
        <ul className="list body-sm">
          {SECURITY_HEADERS.map((h) => (
            <li key={h} className="row gap-xs" style={{ padding: '2px 0' }}>
              <Icon name={ex.headers[h] ? 'check' : 'x'} size={14} />
              <span className="mono">
                {h}: {ex.headers[h] ?? '(missing)'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <pre className="code">{typeof ex.body === 'string' ? ex.body || '(empty body)' : JSON.stringify(ex.body, null, 2)}</pre>
    </div>
  );
}

export function SecurityPage() {
  const { user, token } = useAuth();
  const [results, setResults] = useState<Record<string, Result>>({});
  const [orderId, setOrderId] = useState('');

  if (!user || !token) return null;

  const runnable = (c: Check) => c.roles.includes(user.role);

  const run = async (check: Check) => {
    setResults((r) => ({ ...r, [check.id]: { running: true } }));
    try {
      const ex = await check.run({ token, orderId: orderId.trim() || RANDOM_ID() });
      setResults((r) => ({ ...r, [check.id]: { running: false, exchange: ex } }));
    } catch (err) {
      setResults((r) => ({ ...r, [check.id]: { running: false, error: err instanceof Error ? err.message : String(err) } }));
    }
  };

  const runAll = async () => {
    for (const check of CHECKS.filter((c) => runnable(c) && !c.warning)) await run(check);
  };

  const finished = Object.entries(results).filter(([, r]) => r.exchange);
  const passed = finished.filter(([id, r]) => CHECKS.find((c) => c.id === id)!.expected.includes(r.exchange!.status)).length;

  return (
    <main className="main main-medium">
      <PageHeader
        title="Security checks."
        lead={
          <>
            Each check sends a real request that the interface would never send, as <span className="strong">{user.email}</span> ({user.role}), and
            shows the server rejecting it.
          </>
        }
        actions={
          <button type="button" className="btn btn-primary" onClick={runAll}>
            <Icon name="play" size={16} />
            Run all
          </button>
        }
      />

      {finished.length > 0 && (
        <div style={{ marginBottom: 'var(--space-lg)' }}>
          <Notice icon={passed === finished.length ? 'shield' : 'alert'} title={`${passed} of ${finished.length} checks rejected as expected.`} />
        </div>
      )}

      <ol className="list stack gap-md">
        {CHECKS.map((check, index) => {
          const available = runnable(check);
          return (
            <li key={check.id} className="card check">
              <div className="check-head">
                <span className="squircle" style={{ width: 36, height: 36, fontWeight: 650 }}>
                  {index + 1}
                </span>
                <div className="stack gap-xs grow">
                  <h2 className="title">{check.title}</h2>
                  <p className="body-sm muted">{check.proves}</p>
                  <span className="caption muted">
                    Expected: <span className="strong" style={{ color: 'var(--color-ink)' }}>{check.expected.join(' or ')}</span>
                  </span>
                </div>
                <button type="button" className="btn btn-soft btn-sm" onClick={() => run(check)} disabled={!available || results[check.id]?.running}>
                  Run
                </button>
              </div>

              {check.needsOrderId && available && (
                <div className="stack gap-xs">
                  <label className="field-label" htmlFor="other-order">
                    Another customer’s order id
                  </label>
                  <div className="row gap-xs">
                    <input
                      id="other-order"
                      className="input mono"
                      placeholder="Paste a full order id (the admin can copy one from Orders)"
                      value={orderId}
                      onChange={(e) => setOrderId(e.target.value)}
                    />
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => setOrderId(RANDOM_ID())}>
                      Random
                    </button>
                  </div>
                  <span className="caption muted">Left empty, a random id is used.</span>
                </div>
              )}

              {!available && (
                <span className="caption muted">Log in as a {check.roles.join(' or ').toLowerCase()} to run this check.</span>
              )}
              {check.warning && available && (
                <span className="caption muted row gap-xs">
                  <Icon name="info" size={14} />
                  {check.warning}
                </span>
              )}

              {results[check.id] && <ResultView check={check} result={results[check.id]} />}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
