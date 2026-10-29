import { useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { ApiError } from '../api/client';
import { ordersApi, usersApi } from '../api/endpoints';
import type { Order, OrderStatus } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { Icon } from '../components/Icon';
import { useToast } from '../components/Toasts';
import { BackLink, ErrorPage, Notice, ProblemNotice, StatusBadge } from '../components/ui';
import { formatDateTime, formatMoney, shortId } from '../lib/format';
import { HAPPY_PATH, NEXT_STATUSES, STATUS_ACTION, STATUS_HELP } from '../lib/orderStatus';
import { useAsync } from '../lib/useAsync';

function Timeline({ order }: { order: Order }) {
  const history = [...order.statusHistory].sort((a, b) => a.changedAt.localeCompare(b.changedAt));
  const reached = new Set(history.map((h) => h.status));
  const finished = order.status === 'Delivered' || order.status === 'Cancelled';
  const upcoming = finished ? [] : HAPPY_PATH.filter((s) => !reached.has(s));

  return (
    <ol className="timeline">
      {history.map((h, i) => {
        const current = i === history.length - 1;
        return (
          <li key={`${h.status}-${h.changedAt}`}>
            <span className={`timeline-dot ${current && !finished ? 'current' : ''}`} />
            <div className="stack gap-xxs">
              <span className="strong">{h.status}</span>
              <span className="body-sm muted">{formatDateTime(h.changedAt)}</span>
              {current && <span className="body-sm muted">{STATUS_HELP[h.status]}</span>}
            </div>
          </li>
        );
      })}
      {upcoming.map((s) => (
        <li key={s}>
          <span className="timeline-dot future" />
          <span className="faint strong">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function AdminActions({ order, onChanged }: { order: Order; onChanged: (order: Order) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<OrderStatus | null>(null);
  const [error, setError] = useState<unknown>();
  const next = NEXT_STATUSES[order.status];

  const move = async (status: OrderStatus) => {
    setBusy(status);
    setError(undefined);
    try {
      const updated = await ordersApi.changeStatus(order.id, status);
      onChanged(updated);
      toast(`Order ${shortId(order.id)} is now ${status}. The customer was notified.`);
    } catch (err) {
      setError(err);
      // 409: someone else changed it first. Show the latest state.
      if (err instanceof ApiError && err.status === 409) ordersApi.get(order.id).then(onChanged).catch(() => {});
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card stack gap-md" aria-label="Change status">
      <div className="row gap-sm">
        <span className="squircle" style={{ width: 36, height: 36 }}>
          <Icon name="shield" size={18} />
        </span>
        <h2 className="title">Change status.</h2>
      </div>
      {next.length === 0 ? (
        <p className="body-sm muted">{order.status} is final. This order can’t change anymore.</p>
      ) : (
        <>
          <p className="body-sm muted">Only the allowed next steps are offered. The customer gets a notification.</p>
          <div className="stack gap-xs">
            {next.map((s) => (
              <button
                key={s}
                type="button"
                className={`btn btn-block ${s === 'Cancelled' ? 'btn-outline' : 'btn-primary'}`}
                onClick={() => move(s)}
                disabled={busy !== null}
              >
                {busy === s ? 'Saving…' : STATUS_ACTION[s]}
              </button>
            ))}
          </div>
        </>
      )}
      {error != null && <ProblemNotice error={error} />}
    </section>
  );
}

/** The full id, e.g. to try opening this order from another account on the Security checks page. */
function CopyIdButton({ id }: { id: string }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      toast('Order id copied.');
    } catch {
      window.prompt('Copy the order id:', id);
    }
  };
  return (
    <button type="button" className="btn btn-soft btn-sm" onClick={copy} title={id}>
      Copy order id
    </button>
  );
}

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const { isAdmin } = useAuth();
  const location = useLocation();
  const justPlaced = (location.state as { justPlaced?: boolean } | null)?.justPlaced;
  const order = useAsync(() => ordersApi.get(id), [id]);
  const owner = useAsync(
    () => (isAdmin && order.data ? usersApi.list().then((all) => all.find((u) => u.id === order.data!.userId)) : Promise.resolve(undefined)),
    [isAdmin, order.data?.userId],
  );

  const back = isAdmin ? '/admin/orders' : '/orders';

  if (order.error) {
    return (
      <main className="main">
        <BackLink to={back}>{isAdmin ? 'Orders' : 'My orders'}</BackLink>
        <ErrorPage
          error={order.error}
          notFoundTitle="Order not found."
          notFoundText="This order doesn’t exist, or it belongs to another account. You can only open your own orders."
        />
      </main>
    );
  }

  const o = order.data;

  return (
    <main className="main">
      <BackLink to={back}>{isAdmin ? 'Orders' : 'My orders'}</BackLink>

      {!o ? (
        <div className="stack gap-md" aria-hidden="true">
          <div className="skeleton" style={{ height: 48, width: 320 }} />
          <div className="skeleton" style={{ height: 240 }} />
        </div>
      ) : (
        <>
          <header className="page-header">
            <div className="stack gap-sm">
              <div className="row gap-md wrap">
                <h1 className="h2">
                  Order <span className="mono" style={{ fontSize: '0.8em' }}>{shortId(o.id)}</span>.
                </h1>
                <StatusBadge status={o.status} />
              </div>
              <p className="lead muted">
                Placed {formatDateTime(o.createdAt)}
                {isAdmin && owner.data && <> by {owner.data.email}</>}.
              </p>
            </div>
            <CopyIdButton id={o.id} />
          </header>

          {justPlaced && (
            <div style={{ marginBottom: 'var(--space-xl)' }}>
              <Notice icon="check" title="Thanks, your order is in.">
                You’ll get a notification each time its status changes.
              </Notice>
            </div>
          )}

          <div className="two-col">
            <section className="card" aria-label="Items">
              <ul className="list">
                {o.items.map((item) => (
                  <li key={item.productId} className="list-row">
                    <img className="thumb" src={`/api/v1/products/${item.productId}/image`} alt="" />
                    <div className="stack gap-xxs grow">
                      <Link to={`/products/${item.productId}`} className="strong" style={{ textDecoration: 'none' }}>
                        {item.productName}
                      </Link>
                      <span className="body-sm muted tabular">
                        {item.quantity} × {formatMoney(item.unitPrice)}
                      </span>
                    </div>
                    <span className="strong tabular">{formatMoney(item.lineTotal)}</span>
                  </li>
                ))}
              </ul>
              <hr className="divider" style={{ margin: 'var(--space-sm) 0 var(--space-md)' }} />
              <div className="summary-total">
                <span>Total</span>
                <span className="tabular">{formatMoney(o.totalAmount)}</span>
              </div>
              <p className="caption muted" style={{ marginTop: 'var(--space-sm)' }}>
                Prices are a snapshot from when the order was placed.
              </p>
            </section>

            <div className="stack gap-lg sticky-aside">
              {isAdmin && <AdminActions order={o} onChanged={order.setData} />}
              <section className="card-soft stack gap-lg" aria-label="Status history">
                <h2 className="title">Status.</h2>
                <Timeline order={o} />
              </section>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
