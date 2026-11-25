import Pusher, { type Channel } from 'pusher-js';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

// Requirement 4: live updates. One WebSocket per tab to Soketi (a ready-made server that speaks the Pusher
// protocol), through nginx on our own origin (/app/...). Every channel we use is "private-": before joining,
// pusher-js asks our API (with our JWT) whether we may, and the API signs the answer.

let client: Promise<Pusher> | null = null;

function getClient(): Promise<Pusher> {
  client ??= api<{ key: string }>('/realtime/config', { token: null }).then(
    ({ key }) =>
      new Pusher(key, {
        cluster: 'local', // pusher-js requires one; unused, because we give our own host below
        wsHost: window.location.hostname,
        wsPort: Number(window.location.port) || 80,
        wssPort: Number(window.location.port) || 443,
        forceTLS: window.location.protocol === 'https:',
        enabledTransports: ['ws', 'wss'],
        disableStats: true, // do not send statistics to pusher.com
        channelAuthorization: {
          endpoint: '/api/v1/realtime/auth', // not used by the custom handler, but required by the types
          transport: 'ajax',
          // Our own call instead of pusher-js' form post: it goes through api(), so it carries our JWT.
          customHandler: ({ socketId, channelName }, callback) => {
            api<{ auth: string }>('/realtime/auth', { method: 'POST', body: { socketId, channelName } })
              .then((data) => callback(null, data))
              .catch((error) => callback(error instanceof Error ? error : new Error(String(error)), null));
          },
        },
      }),
  );
  client.catch(() => {
    client = null; // the config call failed: try again next time
  });
  return client;
}

/** On logout: close the WebSocket, so the next user starts with a clean connection. */
export function disconnectRealtime() {
  client?.then((pusher) => pusher.disconnect()).catch(() => {});
  client = null;
}

/**
 * Listens to one event of one channel while the component is on screen; channel null = not now.
 * onSubscribed runs each time the channel is (re)joined, e.g. after the WebSocket reconnects: reload the data
 * there, so an event sent while we were offline is not missed.
 * Returns true while we are subscribed (for a "Live" badge).
 */
export function useLiveChannel<T>(channel: string | null, event: string, onEvent: (data: T) => void, onSubscribed?: () => void): boolean {
  const [live, setLive] = useState(false);
  // The latest callbacks, without leaving and re-joining the channel on every render.
  const handlers = useRef({ onEvent, onSubscribed });
  handlers.current = { onEvent, onSubscribed };

  useEffect(() => {
    if (!channel) return;
    let stopped = false;
    let joined: Channel | null = null;
    let pusher: Pusher | null = null;

    const handleEvent = (data: T) => handlers.current.onEvent(data);
    const handleSubscribed = () => {
      setLive(true);
      handlers.current.onSubscribed?.();
    };
    const handleError = () => setLive(false); // e.g. 403: the API said no
    // The connection dropped (Soketi stopped, network gone): not live any more. pusher-js reconnects by itself
    // and joins the channel again, and then handleSubscribed makes it live again.
    const handleState = ({ current }: { current: string }) => {
      if (current !== 'connected') setLive(false);
    };

    getClient()
      .then((p) => {
        if (stopped) return;
        pusher = p;
        joined = p.subscribe(channel);
        joined.bind(event, handleEvent);
        joined.bind('pusher:subscription_succeeded', handleSubscribed);
        joined.bind('pusher:subscription_error', handleError);
        p.connection.bind('state_change', handleState);
      })
      .catch(() => setLive(false));

    return () => {
      stopped = true;
      setLive(false);
      if (joined && pusher) {
        joined.unbind(event, handleEvent);
        joined.unbind('pusher:subscription_succeeded', handleSubscribed);
        joined.unbind('pusher:subscription_error', handleError);
        pusher.connection.unbind('state_change', handleState);
        pusher.unsubscribe(channel); // leave the channel when the page closes
      }
    };
  }, [channel, event]);

  return live;
}
