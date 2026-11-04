import { useMemo, useRef, useState, type ReactNode } from 'react';
import { exchange, type Exchange } from '../api/client';
import { productsApi } from '../api/endpoints';
import type { Product } from '../api/types';
import { Icon } from '../components/Icon';
import { Notice, PageHeader, ProblemNotice } from '../components/ui';
import { useAsync } from '../lib/useAsync';

/**
 * Live proofs for Requirement 2 (the inventory service over gRPC), run from the admin account.
 * The admin sets the stock; the orders are placed by a temporary customer this page creates, exactly like
 * api-tests/race-last-unit.mjs. Every check puts the product's stock back to what it was afterwards.
 */

interface Step {
  label: string;
  ex: Pick<Exchange, 'method' | 'url' | 'status'> & { statusText?: string };
  ms: number;
}

interface Outcome {
  pass: boolean;
  summary: ReactNode;
  steps: Step[];
  /** The one response worth reading in full (e.g. the 409 refusal). */
  body?: unknown;
}

interface Ctx {
  product: Product;
  other: Product | undefined;
  raceOrders: number;
  log: Step[];
  customerToken: () => Promise<string>;
}

interface Check {
  id: string;
  title: string;
  proves: string;
  expected: string;
  needsOther?: boolean;
  /** Shown before running: steps the presenter does by hand (e.g. stopping a container). */
  manual?: ReactNode;
  run?: (ctx: Ctx) => Promise<Outcome>;
}

type Body = Record<string, unknown> | null;
type Options = Parameters<typeof exchange>[1];

async function timed(log: Step[], label: string, path: string, options?: Options) {
  const started = performance.now();
  const ex = await exchange(path, options);
  log.push({ label, ex, ms: performance.now() - started });
  return { ...ex, body: (ex.body && typeof ex.body === 'object' ? ex.body : null) as Body };
}

/** The current stock of a product, as the app reports it (null: the inventory service did not answer). */
async function readStock(log: Step[], product: Product, label = `Read the stock of ${product.name}`) {
  const res = await timed(log, label, `/products/${product.id}`, { token: null });
  if (res.status !== 200) throw new Error(`Reading ${product.name} failed (${res.status}).`);
  return (res.body?.stock ?? null) as number | null;
}

async function setStock(log: Step[], product: Product, quantity: number, label = `Set the stock of ${product.name} to ${quantity}`) {
  const res = await timed(log, label, `/products/${product.id}/stock`, { method: 'PUT', body: { quantity } });
  if (res.status !== 200) throw new Error(`Setting the stock of ${product.name} failed (${res.status}). Is the inventory service running?`);
}

/** Runs work with the products' stock, then always puts the original stock back. */
async function withStockRestored<T>(log: Step[], products: Product[], work: () => Promise<T>) {
  const original = new Map<Product, number>();
  for (const p of products) {
    const stock = await readStock(log, p, `Remember the stock of ${p.name}`);
    if (stock === null) throw new Error('The inventory service is not answering. Start it (docker compose start inventory) and run again.');
    original.set(p, stock);
  }
  try {
    return await work();
  } finally {
    for (const [p, stock] of original) await setStock(log, p, stock, `Put the stock of ${p.name} back to ${stock}`).catch(() => {});
  }
}

const order = (log: Step[], label: string, token: string, items: { productId: string; quantity: number }[]) =>
  timed(log, label, '/orders', { method: 'POST', body: { items }, token });

const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;

const CHECKS: Check[] = [
  {
    id: 'details',
    title: 'Product details include the stock.',
    proves:
      'The app has no stock column. For GET /products/{id} it asks the inventory service (GetStock over gRPC) and returns the quantity with the product.',
    expected: '200 with a number in "stock"',
    run: async ({ product, log }) => {
      const res = await timed(log, `Open ${product.name}`, `/products/${product.id}`, { token: null });
      const stock = res.body?.stock;
      return {
        pass: res.status === 200 && typeof stock === 'number',
        summary: typeof stock === 'number' ? `“stock”: ${stock}, answered by the inventory service.` : '“stock” is null: the inventory service did not answer.',
        steps: log,
        body: res.body,
      };
    },
  },
  {
    id: 'short',
    title: 'Order more than is in stock.',
    proves: 'The inventory service refuses the reservation, so the order is not created. The user gets a clear message naming the product.',
    expected: '409 “Not enough stock for: …” with “shortages”',
    run: (ctx) => {
      const { product, log } = ctx;
      return withStockRestored(log, [product], async () => {
        await setStock(log, product, 1);
        const token = await ctx.customerToken();
        const res = await order(log, `Order 2 × ${product.name}`, token, [{ productId: product.id, quantity: 2 }]);
        const shortages = (res.body?.shortages ?? []) as { requested: number; available: number }[];
        const pass = res.status === 409 && shortages.length === 1 && shortages[0].requested === 2 && shortages[0].available === 1;
        return {
          pass,
          summary: pass ? `Refused: asked for 2, only 1 left. No order was created.` : `Expected 409, got ${res.status}.`,
          steps: log,
          body: res.body,
        };
      });
    },
  },
  {
    id: 'all-or-nothing',
    title: 'One short item refuses the whole order.',
    proves:
      'Reserve is all or nothing, in one database transaction: when one product is short, the units already taken for the other one are given back.',
    expected: '409, and the other product’s stock is unchanged',
    needsOther: true,
    run: (ctx) => {
      const { product, other, log } = ctx;
      const b = other!;
      return withStockRestored(log, [product, b], async () => {
        await setStock(log, product, 5);
        await setStock(log, b, 1);
        const token = await ctx.customerToken();
        const res = await order(log, `Order 2 × ${product.name} and 2 × ${b.name}`, token, [
          { productId: product.id, quantity: 2 },
          { productId: b.id, quantity: 2 },
        ]);
        const after = await readStock(log, product, `Read the stock of ${product.name} again`);
        const pass = res.status === 409 && after === 5;
        return {
          pass,
          summary: pass
            ? `Refused because of ${b.name}, and ${product.name} is still at 5: nothing was kept.`
            : `Expected 409 and 5 left, got ${res.status} and ${after ?? 'unknown'}.`,
          steps: log,
          body: res.body,
        };
      });
    },
  },
  {
    id: 'race',
    title: 'Many orders at the same moment for the last unit.',
    proves:
      'The race condition: the inventory service checks and subtracts in one conditional UPDATE, so only one order can take the last unit, however many arrive together.',
    expected: 'exactly one 201, all the others 409, stock ends at 0',
    run: (ctx) => {
      const { product, raceOrders, log } = ctx;
      return withStockRestored(log, [product], async () => {
        await setStock(log, product, 1);
        const token = await ctx.customerToken();

        // Promise.all starts every request before waiting for any answer.
        const started = performance.now();
        const results = await Promise.all(
          Array.from({ length: raceOrders }, () => exchange('/orders', { method: 'POST', body: { items: [{ productId: product.id, quantity: 1 }] }, token })),
        );
        const count = (status: number) => results.filter((r) => r.status === status).length;
        const created = count(201);
        const refused = count(409);
        const other = results.length - created - refused;
        log.push({
          label: `${raceOrders} orders sent together: ${created} × 201, ${refused} × 409${other ? `, ${other} × other` : ''}`,
          ex: { method: 'POST', url: `/api/v1/orders × ${raceOrders}`, status: created === 1 ? 201 : 0 },
          ms: performance.now() - started,
        });

        const after = await readStock(log, product, `Read the stock of ${product.name} again`);
        const pass = created === 1 && refused === raceOrders - 1 && after === 0;
        return {
          pass,
          summary: pass
            ? `1 order got the last unit, ${refused} were refused, and the stock is 0 (never negative).`
            : `Expected 1 × 201 and ${raceOrders - 1} × 409 with 0 left, got ${created} × 201, ${refused} × 409, ${after ?? 'unknown'} left.`,
          steps: log,
          body: results.find((r) => r.status === 409)?.body,
        };
      });
    },
  },
  {
    id: 'down',
    title: 'The inventory service is stopped or slow.',
    proves:
      'Every gRPC call has a deadline (2 s). The product page still opens, without the stock, and an order is refused with a clear 503 instead of hanging. Stopped: refused at once. Paused (slow): about 4 s, because after Reserve times out the app also tries Release, in case the reservation went through late.',
    expected: 'product 200 with “stock”: null · order 503 within a few seconds',
    manual: (
      <div className="stack gap-xs body-sm">
        <span className="strong">First, in a terminal at the project root:</span>
        <pre className="code">{`docker compose stop inventory     # stopped: refused at once
docker compose pause inventory    # or slow: no answer, the app gives up at the deadline`}</pre>
        <span className="muted">
          Afterwards: <span className="mono">docker compose start inventory</span> (or <span className="mono">unpause</span>). The app reconnects
          within a few seconds.
        </span>
      </div>
    ),
    run: async (ctx) => {
      const { product, log } = ctx;
      const stock = await readStock(log, product, `Open ${product.name}`);
      if (stock !== null) {
        return {
          pass: false,
          summary: `The inventory service is still answering (stock = ${stock}). Stop or pause it first, then run this check again.`,
          steps: log,
        };
      }
      const token = await ctx.customerToken();
      const res = await order(log, `Order 1 × ${product.name}`, token, [{ productId: product.id, quantity: 1 }]);
      const took = log[log.length - 1].ms;
      const pass = res.status === 503;
      return {
        pass,
        summary: pass
          ? `The page opened without the stock, and the order was refused with 503 after ${seconds(took)}. The user never waits forever.`
          : `Expected 503, got ${res.status}.`,
        steps: log,
        body: res.body,
      };
    },
  },
  {
    id: 'compensation',
    title: 'Saving the order fails after the stock was reserved.',
    proves:
      'The app reserves first and saves second. If saving fails, it calls Release for that order, so the stock goes back (compensation). After a timeout it also calls Release, in case the reservation went through late.',
    expected: 'explained, not run from the browser',
    manual: (
      <div className="stack gap-xs body-sm">
        <span className="muted">
          This needs the app’s own database to fail at the exact moment between Reserve and the save, which a browser cannot cause. Where to show it:
        </span>
        <ul className="list stack gap-xxs">
          <li>
            <span className="mono">app/Shop.Api/Modules/Orders/OrdersService.cs</span>: <span className="mono">CreateAsync</span> wraps the save in
            try/catch and calls <span className="mono">TryReleaseStockAsync</span>.
          </li>
          <li>
            The app log line: <span className="mono">Saving order … failed after its stock was reserved; releasing the stock</span>.
          </li>
          <li>
            Release is safe to repeat, and a late Reserve for a released order is refused (<span className="mono">inventory/src/inventory.js</span>).
          </li>
        </ul>
      </div>
    ),
  },
];

type Result = { running: boolean; outcome?: Outcome; error?: string };

function ResultView({ result }: { result: Result }) {
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

export function InventoryChecksPage() {
  const products = useAsync(() => productsApi.list({ pageSize: 50 }), []);
  const items = useMemo(() => products.data?.items ?? [], [products.data]);
  const [productId, setProductId] = useState('');
  const [otherId, setOtherId] = useState('');
  const [raceOrders, setRaceOrders] = useState(20);
  const [results, setResults] = useState<Record<string, Result>>({});
  const customer = useRef<{ email: string; token: string } | null>(null);
  const [customerEmail, setCustomerEmail] = useState<string>();

  const product = items.find((p) => p.id === productId) ?? items[0];
  const other = items.find((p) => p.id === otherId && p.id !== product?.id) ?? items.find((p) => p.id !== product?.id);

  /** One temporary customer per visit: login is limited to 5 per minute, so it logs in only once. */
  const customerToken = (log: Step[]) => async () => {
    if (customer.current) return customer.current.token;
    const email = `checks.${Date.now()}@shop.test`;
    const password = `Checks-${crypto.randomUUID()}`;
    const reg = await timed(log, 'Create a temporary customer', '/auth/register', { method: 'POST', body: { email, password }, token: null });
    if (reg.status !== 201) throw new Error(`Creating the temporary customer failed (${reg.status}).`);
    const login = await timed(log, 'Log in as that customer', '/auth/login', { method: 'POST', body: { email, password }, token: null });
    if (login.status === 429) throw new Error('Login is limited to 5 attempts per minute. Wait a minute and run the check again.');
    if (login.status !== 200) throw new Error(`Logging in the temporary customer failed (${login.status}).`);
    customer.current = { email, token: String(login.body?.accessToken) };
    setCustomerEmail(email);
    return customer.current.token;
  };

  const run = async (check: Check) => {
    if (!check.run || !product) return;
    setResults((r) => ({ ...r, [check.id]: { running: true } }));
    const log: Step[] = [];
    try {
      const outcome = await check.run({ product, other, raceOrders, log, customerToken: customerToken(log) });
      setResults((r) => ({ ...r, [check.id]: { running: false, outcome } }));
    } catch (err) {
      setResults((r) => ({ ...r, [check.id]: { running: false, error: err instanceof Error ? err.message : String(err) } }));
    }
  };

  const runAll = async () => {
    for (const check of CHECKS.filter((c) => c.run && !c.manual && (!c.needsOther || other))) await run(check);
  };

  const finished = Object.entries(results).filter(([, r]) => r.outcome);
  const passed = finished.filter(([, r]) => r.outcome!.pass).length;
  const busy = Object.values(results).some((r) => r.running);

  return (
    <main className="main main-medium">
      <PageHeader
        title="Inventory checks."
        lead="Requirement 2, live: each check talks to the real app, which talks to the inventory service over gRPC. The stock of the products you pick is put back afterwards."
        actions={
          <button type="button" className="btn btn-primary" onClick={runAll} disabled={busy || !product}>
            <Icon name="play" size={16} />
            Run all
          </button>
        }
      />

      {products.error ? (
        <ProblemNotice error={products.error} />
      ) : products.data && items.length === 0 ? (
        <Notice icon="info" title="There are no products yet.">
          Add a product (or run the seed) first.
        </Notice>
      ) : (
        <div className="card stack gap-md" style={{ marginBottom: 'var(--space-lg)' }}>
          <div className="form-grid">
            <div className="field">
              <label className="field-label" htmlFor="check-product">
                Product to test with
              </label>
              <select id="check-product" className="select" value={product?.id ?? ''} onChange={(e) => setProductId(e.target.value)}>
                {items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="check-other">
                Second product (check 3)
              </label>
              <select id="check-other" className="select" value={other?.id ?? ''} onChange={(e) => setOtherId(e.target.value)}>
                {items
                  .filter((p) => p.id !== product?.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="check-race">
                Orders sent together (check 4)
              </label>
              <input
                id="check-race"
                className="input tabular"
                type="number"
                min={2}
                max={50}
                value={raceOrders}
                onChange={(e) => setRaceOrders(Math.min(50, Math.max(2, Math.round(Number(e.target.value) || 2))))}
              />
            </div>
          </div>
          <p className="caption muted">
            Orders are placed by a temporary customer that the page creates
            {customerEmail ? (
              <>
                {' '}
                (<span className="mono">{customerEmail}</span>)
              </>
            ) : null}
            . The race check leaves one real order, the one that got the last unit. A browser sends about 6 requests at a time to one site;
            for {raceOrders} truly simultaneous requests, run <span className="mono">node api-tests/race-last-unit.mjs</span>.
          </p>
        </div>
      )}

      {finished.length > 0 && (
        <div style={{ marginBottom: 'var(--space-lg)' }}>
          <Notice icon={passed === finished.length ? 'shield' : 'alert'} title={`${passed} of ${finished.length} checks passed.`} />
        </div>
      )}

      <ol className="list stack gap-md">
        {CHECKS.map((check, index) => {
          const runnable = Boolean(check.run && product && (!check.needsOther || other));
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
                    Expected: <span className="strong" style={{ color: 'var(--color-ink)' }}>{check.expected}</span>
                  </span>
                </div>
                {check.run && (
                  <button type="button" className="btn btn-soft btn-sm" onClick={() => run(check)} disabled={!runnable || busy}>
                    Run
                  </button>
                )}
              </div>
              {check.manual}
              {check.needsOther && !other && product && <span className="caption muted">This check needs a second product.</span>}
              {results[check.id] && <ResultView result={results[check.id]} />}
            </li>
          );
        })}
      </ol>
    </main>
  );
}
