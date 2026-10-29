import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ordersApi, usersApi } from '../api/endpoints';
import { ORDER_STATUSES, type OrderStatus } from '../api/types';
import { EmptyState, PageHeader, Pagination, ProblemNotice, Segmented, StatusBadge } from '../components/ui';
import { formatDateTime, formatMoney, shortId } from '../lib/format';
import { useAsync } from '../lib/useAsync';

const PAGE_SIZE = 10;

/** "My orders" for a customer, "Orders" (everyone's) for the admin: the API decides what each one sees. */
export function OrdersPage({ admin = false }: { admin?: boolean }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') ?? '') as OrderStatus | '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const orders = useAsync(() => ordersApi.list({ status: status || undefined, page, pageSize: PAGE_SIZE }), [status, page]);
  // Admins see who placed each order. Users live in another module, so ask its API, not its tables.
  const users = useAsync(() => (admin ? usersApi.list() : Promise.resolve([])), [admin]);
  const emailById = useMemo(() => new Map((users.data ?? []).map((u) => [u.id, u.email])), [users.data]);

  const update = (next: { status?: string; page?: number }) => {
    const search = new URLSearchParams();
    const s = next.status ?? status;
    if (s) search.set('status', s);
    if ((next.page ?? 1) > 1) search.set('page', String(next.page));
    setParams(search);
  };

  const data = orders.data;
  const options = [{ value: '', label: 'All' }, ...ORDER_STATUSES.map((s) => ({ value: s, label: s }))];

  return (
    <main className="main">
      <PageHeader
        title={admin ? 'Orders.' : 'My orders.'}
        lead={admin ? 'Every customer’s orders. Open one to move it to its next status.' : 'Everything you’ve ordered, newest first.'}
      />

      <div style={{ marginBottom: 'var(--space-xl)' }}>
        <Segmented label="Filter by status" options={options} value={status} onChange={(value) => update({ status: value, page: 1 })} />
      </div>

      {orders.error ? (
        <ProblemNotice error={orders.error} />
      ) : !data ? (
        <div className="stack gap-sm" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 56 }} />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <EmptyState
          icon="receipt"
          title={status ? `No ${status.toLowerCase()} orders.` : admin ? 'No orders yet.' : 'You haven’t ordered anything yet.'}
          action={
            !admin && !status ? (
              <Link to="/products" className="btn btn-primary">
                Browse the shop
              </Link>
            ) : (
              status && (
                <button type="button" className="btn btn-primary" onClick={() => update({ status: '', page: 1 })}>
                  Show all orders
                </button>
              )
            )
          }
        >
          {admin ? 'Orders placed by customers will show up here.' : !status && 'When you place an order, you can follow its status here.'}
        </EmptyState>
      ) : (
        <>
          <div className="card table-wrap" style={{ padding: 'var(--space-md) var(--space-sm) var(--space-xs)', opacity: orders.loading ? 0.6 : 1 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  {admin && <th>Customer</th>}
                  <th>Placed</th>
                  <th className="num">Items</th>
                  <th className="num">Total</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => navigate(`/orders/${o.id}`)}>
                    <td>
                      <Link to={`/orders/${o.id}`} className="strong mono" style={{ textDecoration: 'none' }} onClick={(e) => e.stopPropagation()}>
                        {shortId(o.id)}
                      </Link>
                    </td>
                    {admin && <td>{emailById.get(o.userId) ?? <span className="mono muted">{shortId(o.userId)}</span>}</td>}
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {formatDateTime(o.createdAt)}
                    </td>
                    <td className="num">{o.itemCount}</td>
                    <td className="num strong">{formatMoney(o.totalAmount)}</td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="caption muted" style={{ marginTop: 'var(--space-md)' }}>
            {data.totalCount} {data.totalCount === 1 ? 'order' : 'orders'}
          </p>
          <Pagination page={data.page} totalPages={data.totalPages} onChange={(p) => update({ page: p })} />
        </>
      )}
    </main>
  );
}
