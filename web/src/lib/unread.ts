import { useEffect, useState } from 'react';
import { notificationsApi } from '../api/endpoints';

const EVENT = 'onlineshop:notifications-changed';

/** Call after anything that changes notifications (new order, marked read) to refresh the nav badge. */
export const notificationsChanged = () => window.dispatchEvent(new Event(EVENT));

/** Unread notifications for the logged-in user: refreshed on change, on focus, and every 30 seconds. */
export function useUnreadCount(enabled: boolean) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    let active = true;
    const refresh = () =>
      notificationsApi
        .unreadCount()
        .then((r) => active && setCount(r.count))
        .catch(() => {});

    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener(EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [enabled]);

  return count;
}
