import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { notificationsApi } from '../api/endpoints';
import type { Notification } from '../api/types';
import { EmptyState, PageHeader, Pagination, ProblemNotice, Segmented } from '../components/ui';
import { formatDateTime, timeAgo } from '../lib/format';
import { notificationsChanged } from '../lib/unread';
import { useAsync } from '../lib/useAsync';

const PAGE_SIZE = 10;

export function NotificationsPage() {
  const [params, setParams] = useSearchParams();
  const unreadOnly = params.get('filter') === 'unread';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [error, setError] = useState<unknown>();

  const list = useAsync(() => notificationsApi.list({ unreadOnly, page, pageSize: PAGE_SIZE }), [unreadOnly, page]);
  const unread = useAsync(() => notificationsApi.unreadCount(), [list.data]);

  const update = (next: { unread?: boolean; page?: number }) => {
    const search = new URLSearchParams();
    if (next.unread ?? unreadOnly) search.set('filter', 'unread');
    if ((next.page ?? 1) > 1) search.set('page', String(next.page));
    setParams(search);
  };

  const markRead = async (n: Notification) => {
    if (n.readAt) return;
    try {
      await notificationsApi.markRead(n.id);
      notificationsChanged();
      list.reload();
    } catch (err) {
      setError(err);
    }
  };

  const markAll = async () => {
    try {
      await notificationsApi.markAllRead();
      notificationsChanged();
      list.reload();
    } catch (err) {
      setError(err);
    }
  };

  const data = list.data;
  const unreadCount = unread.data?.count ?? 0;

  return (
    <main className="main main-medium">
      <PageHeader
        title="Notifications."
        lead={unreadCount > 0 ? `${unreadCount} unread.` : 'You’re all caught up.'}
        actions={
          <button type="button" className="btn btn-soft" onClick={markAll} disabled={unreadCount === 0}>
            Mark all as read
          </button>
        }
      />

      <div style={{ marginBottom: 'var(--space-lg)' }}>
        <Segmented
          label="Show"
          options={[
            { value: 'all', label: 'All' },
            { value: 'unread', label: `Unread${unreadCount ? ` (${unreadCount})` : ''}` },
          ]}
          value={unreadOnly ? 'unread' : 'all'}
          onChange={(v) => update({ unread: v === 'unread', page: 1 })}
        />
      </div>

      {(error != null || list.error != null) && (
        <div style={{ marginBottom: 'var(--space-lg)' }}>
          <ProblemNotice error={error ?? list.error} />
        </div>
      )}

      {!data ? (
        !list.error && (
          <div className="stack gap-sm" aria-hidden="true">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="skeleton" style={{ height: 72 }} />
            ))}
          </div>
        )
      ) : data.items.length === 0 ? (
        <EmptyState
          icon="bell"
          title={unreadOnly ? 'No unread notifications.' : 'No notifications yet.'}
          action={
            !unreadOnly && (
              <Link to="/products" className="btn btn-primary">
                Browse the shop
              </Link>
            )
          }
        >
          {unreadOnly ? 'Everything has been read.' : 'You’ll hear from us when you place an order and when its status changes.'}
        </EmptyState>
      ) : (
        <>
          <ul className="list stack gap-xs">
            {data.items.map((n) => (
              <li key={n.id} className={`notification ${n.readAt ? '' : 'unread'}`}>
                <span className={n.readAt ? 'read-dot' : 'unread-dot'} aria-hidden="true" />
                <div className="stack gap-xs grow">
                  <span className={n.readAt ? '' : 'strong'}>{n.message}</span>
                  <span className="body-sm muted" title={formatDateTime(n.createdAt)}>
                    {timeAgo(n.createdAt)}
                    {n.readAt ? ' · Read' : ''}
                  </span>
                </div>
                <div className="row gap-xs" style={{ alignSelf: 'center' }}>
                  {!n.readAt && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => markRead(n)}>
                      Mark as read
                    </button>
                  )}
                  {n.orderId && (
                    <Link to={`/orders/${n.orderId}`} className="btn btn-outline btn-sm" onClick={() => markRead(n)}>
                      View order
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
          <Pagination page={data.page} totalPages={data.totalPages} onChange={(p) => update({ page: p })} />
        </>
      )}
    </main>
  );
}
