import { useMemo, useState, type ReactNode } from 'react';
import { productsApi } from '../api/endpoints';
import type { Product } from '../api/types';
import { Icon } from '../components/Icon';
import { ResultView, timed, type Outcome, type Result, type Step } from '../components/LiveChecks';
import { Notice, PageHeader, ProblemNotice } from '../components/ui';
import { useAsync } from '../lib/useAsync';

/**
 * Live proofs for Requirement 3 (performance and caching), run from the admin account. Each check calls the
 * real API; the edit check puts the product back as it was. The numbers from k6 are in docs/r3-report.md.
 */

interface Ctx {
  product: Product;
  log: Step[];
}

interface Check {
  id: string;
  title: string;
  proves: string;
  expected: string;
  /** Shown before running: steps the presenter does by hand, or where to see the evidence. */
  manual?: ReactNode;
  run?: (ctx: Ctx) => Promise<Outcome>;
}

const ms = (value: number) => `${value < 100 ? value.toFixed(1) : Math.round(value).toLocaleString('en-US')} ms`;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const DEEP_PAGE = '?page=10000&pageSize=10';
const TRIES = 3;

function Commands({ intro, lines, after }: { intro: string; lines: string; after?: ReactNode }) {
  return (
    <div className="stack gap-xs body-sm">
      <span className="strong">{intro}</span>
      <pre className="code">{lines}</pre>
      {after && <span className="muted">{after}</span>}
    </div>
  );
}

const CHECKS: Check[] = [
  {
    id: 'etag',
    title: 'Product details answer 304 when nothing changed.',
    proves:
      'GET /products/{id} sends an ETag: a fingerprint (SHA-256) of the exact answer, stock included. Sending it back in If-None-Match gets 304 Not Modified with no body, so the data is not sent again. ETag saves the network; Redis saves the database.',
    expected: '200 with an ETag, then 304 with 0 bytes',
    run: async ({ product, log }) => {
      const first = await timed(log, `Open ${product.name}`, `/products/${product.id}`, { token: null });
      const etag = first.headers.etag;
      if (first.status !== 200 || !etag) {
        return { pass: false, summary: `Expected 200 with an ETag header, got ${first.status}${etag ? '' : ' without an ETag'}.`, steps: log };
      }
      const again = await timed(log, 'Ask again with that ETag (If-None-Match)', `/products/${product.id}`, {
        token: null,
        headers: { 'If-None-Match': etag },
      });
      const pass = again.status === 304 && again.bytes === 0;
      return {
        pass,
        summary: pass
          ? `304 Not Modified with an empty body: 0 bytes instead of ${first.bytes.toLocaleString('en-US')}.`
          : `Expected 304 with no body, got ${again.status} with ${again.bytes} bytes.`,
        steps: log,
        body: { etag, cacheControl: first.headers['cache-control'], firstAnswerBytes: first.bytes, secondAnswerBytes: again.bytes },
      };
    },
  },
  {
    id: 'edit',
    title: 'An edit shows at once, although products are cached.',
    proves:
      'The product is in Redis and the client holds its ETag. The admin changes the price (PUT /products/{id}): the API deletes the cached copy and starts a new list generation. The very next reads, with the old ETag, must get the new price, in the details and in the list. The price is put back afterwards.',
    expected: 'old ETag → 200 with the new price; the list shows it too',
    run: async ({ product, log }) => {
      const url = `/products/${product.id}`;
      await timed(log, 'Read it once (now it is in Redis)', url, { token: null });
      const before = await timed(log, 'Read it again and keep its ETag, like a browser', url, { token: null });
      const original = before.body as Product | null;
      const etag = before.headers.etag;
      if (before.status !== 200 || !original || !etag) {
        return { pass: false, summary: `Reading the product failed (${before.status}).`, steps: log };
      }
      const details = { name: original.name, description: original.description, category: original.category };
      const newPrice = Math.round((original.price + 1) * 100) / 100;
      try {
        const put = await timed(log, `Admin changes the price to ${newPrice}`, url, { method: 'PUT', body: { ...details, price: newPrice } });
        if (put.status !== 200) return { pass: false, summary: `The edit failed (${put.status}).`, steps: log, body: put.body };

        const after = await timed(log, 'Right after, with the OLD ETag', url, { token: null, headers: { 'If-None-Match': etag } });
        const list = await timed(log, 'The product list, right after', '/products?page=1&pageSize=12', { token: null });
        const listed = ((list.body?.items ?? []) as Product[]).find((p) => p.id === product.id);
        const afterPrice = (after.body as Product | null)?.price;
        const pass = after.status === 200 && afterPrice === newPrice && listed?.price === newPrice && after.headers.etag !== etag;
        return {
          pass,
          summary: pass
            ? `The old ETag got 200 with the new price ${newPrice} and a new ETag, and the list shows it too: no stale copy anywhere.`
            : `Expected the new price ${newPrice}; the details answered ${after.status} with ${afterPrice ?? 'nothing'}, the list shows ${listed?.price ?? 'nothing'}.`,
          steps: log,
          body: { oldEtag: etag, newEtag: after.headers.etag, detailsPrice: afterPrice, listPrice: listed?.price },
        };
      } finally {
        await timed(log, `Put the price back to ${original.price}`, url, { method: 'PUT', body: { ...details, price: original.price } }).catch(() => {});
      }
    },
  },
  {
    id: 'deep-page',
    title: 'The deep order page: the old query against the new one.',
    proves:
      'Page 10,000 of the admin order list. GET /orders/legacy runs the old query, which counted the items of all 100,000 orders it walked past. GET /orders picks the 10 orders first, counts only theirs, and uses the (CreatedAt DESC, Id) index. Each is sent 3 times, one after the other; the middle time counts.',
    expected: 'the same 10 orders, many times faster',
    run: async ({ log }) => {
      const times = { new: [] as number[], old: [] as number[] };
      let fresh: Awaited<ReturnType<typeof timed>> | undefined;
      let legacy: Awaited<ReturnType<typeof timed>> | undefined;
      for (let i = 1; i <= TRIES; i++) {
        fresh = await timed(log, `New query, try ${i}`, `/orders${DEEP_PAGE}`);
        times.new.push(log[log.length - 1].ms);
      }
      const total = Number(fresh?.body?.totalCount ?? 0);
      if (fresh?.status !== 200 || total < 100_000) {
        return {
          pass: false,
          summary: `Page 10,000 needs at least 100,000 orders; there are ${total.toLocaleString('en-US')}. Seed them first: seed/r3-orders.sql (see docs/r3-report.md).`,
          steps: log,
        };
      }
      for (let i = 1; i <= TRIES; i++) {
        legacy = await timed(log, `Old query (GET /orders/legacy), try ${i}`, `/orders/legacy${DEEP_PAGE}`);
        if (legacy.status !== 200) break;
        times.old.push(log[log.length - 1].ms);
      }
      if (legacy?.status === 404) {
        return { pass: false, summary: 'GET /orders/legacy exists only in Development, for this comparison. Run the API with ASPNETCORE_ENVIRONMENT=Development.', steps: log };
      }
      const ids = (r: typeof legacy) => ((r?.body?.items ?? []) as { id: string }[]).map((o) => o.id).join();
      const sameOrders = ids(fresh) === ids(legacy) && ids(fresh) !== '';
      const newMs = median(times.new);
      const oldMs = median(times.old);
      // Every try must answer 200: a slow answer is a result, a failed one is not.
      const failures = log.filter((s) => s.ex.status !== 200);
      const pass = failures.length === 0 && legacy?.status === 200 && sameOrders && newMs < oldMs;
      return {
        pass,
        summary: pass
          ? `New ${ms(newMs)}, old ${ms(oldMs)}: ${Math.round(oldMs / newMs)}× faster, with the same 10 orders.`
          : failures.length
            ? `${failures.map((s) => `${s.label} answered ${s.ex.status}`).join('; ')}. Run it again; if it repeats, check docker compose logs app.`
            : `New ${ms(newMs)}, old ${oldMs ? ms(oldMs) : '—'}${sameOrders ? '' : '; the two queries returned different orders'}.`,
        steps: log,
        body: { totalCount: total, newMedianMs: Math.round(newMs), oldMedianMs: Math.round(oldMs) },
      };
    },
  },
  {
    id: 'replica',
    title: 'A customer sees their new order at once, even when the replica is behind.',
    proves:
      'The admin list of all orders is read from the read replica. A customer’s own list, order details and every write use the primary database (read-your-own-writes). Pausing the replica proves it: the admin list does not have the new order yet, but the customer sees it.',
    expected: 'explained: run with the replica paused',
    manual: (
      <Commands
        intro="With the replica on (docker-compose.replica.yml), in a terminal at the project root:"
        lines={`docker compose exec app-db-replica psql -U admin -d db_online_shop -c "SELECT pg_wal_replay_pause();"
$env:CUSTOMER_PASSWORD = '…'; node api-tests/r3/proof-replica.mjs
docker compose exec app-db-replica psql -U admin -d db_online_shop -c "SELECT pg_wal_replay_resume();"`}
        after="Expected: PROOF OK, the replica is behind (paused), the admin list does not have the order yet, but the customer sees it."
      />
    ),
  },
  {
    id: 'redis-down',
    title: 'The shop keeps working when Redis is down.',
    proves:
      'Redis is a cache, not a requirement. When it does not answer, reads go to PostgreSQL. After one Redis error, reads skip Redis for 30 seconds, so only one request pays the timeout instead of every one.',
    expected: 'explained: stop Redis and browse the shop',
    manual: (
      <Commands
        intro="With Redis on (docker-compose.cache.yml):"
        lines={`docker compose stop redis     # the shop still answers, from the database
docker compose start redis    # it is used again within 30 s`}
        after="Measured: about 1.4 s for the first request after Redis stops, then 8 to 14 ms."
      />
    ),
  },
  {
    id: 'n-plus-one',
    title: 'No N+1 in the order list.',
    proves:
      'The order list is 2 SQL queries per request (a count and the page), whatever the page size, because the item count is part of the page query. An N+1 version (one query per order) made 52 queries for 50 orders and was about 3 times slower, although each query was fast.',
    expected: 'explained: count the SQL in the log',
    manual: (
      <Commands
        intro="Watch the SQL of one request:"
        lines={`docker compose logs -f app    # then open Orders as the admin`}
        after="Each order-list request logs 2 “Executed DbCommand” lines: SELECT count(*) and the page."
      />
    ),
  },
];

export function PerformanceChecksPage() {
  const products = useAsync(() => productsApi.list({ page: 1, pageSize: 12 }), []);
  const items = useMemo(() => products.data?.items ?? [], [products.data]);
  const [productId, setProductId] = useState('');
  const [results, setResults] = useState<Record<string, Result>>({});
  const product = items.find((p) => p.id === productId) ?? items[0];

  const run = async (check: Check) => {
    if (!check.run || !product) return;
    setResults((r) => ({ ...r, [check.id]: { running: true } }));
    const log: Step[] = [];
    try {
      const outcome = await check.run({ product, log });
      setResults((r) => ({ ...r, [check.id]: { running: false, outcome } }));
    } catch (err) {
      setResults((r) => ({ ...r, [check.id]: { running: false, error: err instanceof Error ? err.message : String(err) } }));
    }
  };

  const runAll = async () => {
    for (const check of CHECKS.filter((c) => c.run)) await run(check);
  };

  const finished = Object.values(results).filter((r) => r.outcome);
  const passed = finished.filter((r) => r.outcome!.pass).length;
  const busy = Object.values(results).some((r) => r.running);

  return (
    <main className="main main-medium">
      <PageHeader
        title="Performance checks."
        lead="Requirement 3, live: caching in the browser (ETag) and on the server (Redis), a faster order query with an index, and a read replica. Each check calls the real API."
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
          <div className="field">
            <label className="field-label" htmlFor="perf-product">
              Product to test with (checks 1 and 2)
            </label>
            <select id="perf-product" className="select" value={product?.id ?? ''} onChange={(e) => setProductId(e.target.value)}>
              {items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <p className="caption muted">
            Check 2 changes the price and puts it back. Check 3 needs the 200,000 test orders and takes a few seconds: the old query is slow on
            purpose. For the load numbers (p50, p95, p99 at 50 requests per second), see <span className="mono">docs/r3-report.md</span>.
          </p>
        </div>
      )}

      {finished.length > 0 && (
        <div style={{ marginBottom: 'var(--space-lg)' }}>
          <Notice icon={passed === finished.length ? 'shield' : 'alert'} title={`${passed} of ${finished.length} checks passed.`} />
        </div>
      )}

      <ol className="list stack gap-md">
        {CHECKS.map((check, index) => (
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
                <button type="button" className="btn btn-soft btn-sm" onClick={() => run(check)} disabled={!product || busy}>
                  Run
                </button>
              )}
            </div>
            {check.manual}
            {results[check.id] && <ResultView result={results[check.id]} />}
          </li>
        ))}
      </ol>
    </main>
  );
}
