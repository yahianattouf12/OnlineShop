import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { OrderCreatedLive, Product } from '../api/types';
import { Icon } from '../components/Icon';
import { ResultView, seconds, timed, type Outcome, type Result, type Step } from '../components/LiveChecks';
import { LiveBadge, Notice, PageHeader } from '../components/ui';
import { shortId } from '../lib/format';
import { useLiveChannel } from '../lib/realtime';

/**
 * Live proofs for Requirement 4 (asynchronous queues and real-time updates), run from the admin account.
 * The orders are placed by temporary customers this page creates. The status card reads the outbox and
 * RabbitMQ every second (GET /queue-checks/status); this page itself listens to private-admin-orders.
 * The same proofs as scripts: api-tests/r4/.
 */

interface QueueStats {
  ready: number;
  unacked: number;
  consumers: number;
  acked: number;
}

interface QueueStatus {
  outboxPending: number;
  rabbitMqReachable: boolean;
  emailQueue: QueueStats | null;
  deadLetterQueue: QueueStats | null;
}

interface XDeath {
  reason?: string;
  queue?: string;
  exchange?: string;
  count?: number;
}

interface DeadLetter {
  messageId: string | null;
  payload: unknown;
  xDeath: XDeath[] | null;
}

interface PusherMessage {
  event: string;
  channel?: string;
  data?: unknown;
}

interface HeardOrder {
  at: number;
  event: OrderCreatedLive;
}

interface Ctx {
  log: Step[];
  /** The current queue numbers (logged as one step). */
  status: (label?: string) => Promise<QueueStatus>;
  /** Reads the numbers until `done` says yes, or the time is up. */
  waitFor: (label: string, done: (s: QueueStatus) => boolean, timeoutMs: number) => Promise<{ ok: boolean; status: QueueStatus }>;
  product: () => Promise<Product>;
  customer: () => Promise<{ email: string; token: string }>;
  otherCustomer: () => Promise<{ email: string; token: string }>;
  /** Is this page subscribed to private-admin-orders right now? */
  adminLive: () => boolean;
  /** Every order.created this page heard, with the time it arrived. */
  heard: () => HeardOrder[];
  /** A line under the check while it waits for the presenter (e.g. "now start the worker"). */
  progress: (text: string) => void;
}

interface Check {
  id: string;
  title: string;
  proves: string;
  expected: string;
  /** Needs something done by hand first (a container stopped): not part of "Run all". */
  setup?: ReactNode;
  run: (ctx: Ctx) => Promise<Outcome>;
}

const ADMIN_CHANNEL = 'private-admin-orders';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ms = (value: number) => `${Math.round(value)} ms`;
const emailQueue = (s: QueueStatus) => s.emailQueue ?? { ready: 0, unacked: 0, consumers: 0, acked: 0 };
const deadQueue = (s: QueueStatus) => s.deadLetterQueue ?? { ready: 0, unacked: 0, consumers: 0, acked: 0 };

/** Fails early with the command that fixes the setup, instead of waiting for a timeout. */
function needs(ctx: Ctx, s: QueueStatus, what: { rabbitMq?: boolean; worker?: boolean }): Outcome | null {
  if (what.rabbitMq && !s.rabbitMqReachable) {
    return { pass: false, summary: 'RabbitMQ is not answering. Start it: docker compose start rabbitmq', steps: ctx.log };
  }
  if (what.worker && emailQueue(s).consumers === 0) {
    return { pass: false, summary: 'The email worker is stopped (no consumer on the queue). Start it: docker compose start email-worker', steps: ctx.log };
  }
  return null;
}

async function placeOrder(ctx: Ctx, label = 'The customer places an order') {
  const { token } = await ctx.customer();
  const product = await ctx.product();
  const res = await timed(ctx.log, `${label} (1 × ${product.name})`, '/orders', {
    method: 'POST',
    body: { items: [{ productId: product.id, quantity: 1 }] },
    token,
  });
  if (res.status !== 201) throw new Error(`Placing the order failed (${res.status}). See the log below.`);
  return { id: String(res.body?.id), ms: ctx.log[ctx.log.length - 1].ms };
}

// ---------- A WebSocket to Soketi, spoken by hand (Pusher protocol), like api-tests/r4/proof-realtime.mjs ----------
// The page needs a second "browser" (a customer) next to the admin: this is that customer's tab.

interface RawSocket {
  socketId: string;
  send: (message: object) => void;
  next: (match: (m: PusherMessage) => boolean, timeoutMs?: number) => Promise<PusherMessage>;
  close: () => void;
}

function wsStep(log: Step[], label: string, what: string, answer: string, started: number) {
  log.push({ label, ex: { method: 'WS', url: what, status: 0, statusText: answer }, ms: performance.now() - started });
}

async function openSocket(log: Step[], key: string, who: string): Promise<RawSocket> {
  const started = performance.now();
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  // Same origin as this page (port 3000): nginx forwards /app/ to Soketi, so the CSP allows it.
  const ws = new WebSocket(`${scheme}://${window.location.host}/app/${key}?protocol=7&client=queue-checks&version=1.0`);
  const listeners = new Set<(m: PusherMessage) => void>();
  ws.onmessage = (e) => {
    const message = JSON.parse(String(e.data)) as PusherMessage;
    for (const listener of [...listeners]) listener(message);
  };
  const next: RawSocket['next'] = (match, timeoutMs = 8000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`${who}: no answer from Soketi within ${seconds(timeoutMs)}.`));
      }, timeoutMs);
      const listener = (m: PusherMessage) => {
        if (!match(m)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(m);
      };
      listeners.add(listener);
    });
  ws.onerror = () => {
    for (const listener of [...listeners]) listener({ event: 'socket-error' });
  };
  // Soketi's first message gives this connection its socket_id.
  const first = await next((m) => m.event === 'pusher:connection_established' || m.event === 'socket-error');
  if (first.event !== 'pusher:connection_established') throw new Error('Could not open a WebSocket to Soketi. Is it running? docker compose start soketi');
  const socketId = JSON.parse(String(first.data)).socket_id as string;
  wsStep(log, `${who}: open a WebSocket`, `/app/${key.slice(0, 6)}…`, `socket_id ${socketId}`, started);
  return { socketId, send: (m) => ws.send(JSON.stringify(m)), next, close: () => ws.close() };
}

/** Like pusher-js: ask OUR API for a signature (with the JWT), then send it to Soketi with the subscribe. */
async function join(log: Step[], socket: RawSocket, channel: string, token: string | null, who: string) {
  const auth = await timed(log, `${who}: ask the API to sign "${channel}"`, '/realtime/auth', {
    method: 'POST',
    body: { socketId: socket.socketId, channelName: channel },
    token,
  });
  if (auth.status !== 200) return `refused by the API (${auth.status})`;
  return subscribe(log, socket, channel, String(auth.body?.auth), who);
}

async function subscribe(log: Step[], socket: RawSocket, channel: string, signature: string, who: string, label = `${who}: join "${channel}"`) {
  const started = performance.now();
  socket.send({ event: 'pusher:subscribe', data: { channel, auth: signature } });
  const reply = await socket.next((m) => m.channel === channel || m.event === 'pusher:error');
  const joined = reply.event === 'pusher_internal:subscription_succeeded';
  wsStep(log, label, `pusher:subscribe ${channel}`, joined ? 'joined' : reply.event, started);
  return joined ? 'joined' : `refused by Soketi (${reply.event})`;
}

const realtimeKey = async (log: Step[]) => {
  const res = await timed(log, 'The public app key', '/realtime/config', { token: null });
  if (res.status !== 200) throw new Error(`GET /realtime/config failed (${res.status}).`);
  return String(res.body?.key);
};

// ---------- The checks ----------

function Commands({ lines, after }: { lines: string; after?: ReactNode }) {
  return (
    <div className="stack gap-xs body-sm">
      <span className="strong">First, in a terminal at the project folder:</span>
      <pre className="code">{lines}</pre>
      {after && <span className="muted">{after}</span>}
    </div>
  );
}

const CHECKS: Check[] = [
  {
    id: 'background',
    title: 'The order answers at once; the email is sent in the background.',
    proves:
      'POST /orders saves the order and its event (the outbox) in one transaction and answers 201 without waiting for any email. The OutboxPublisher hands the event to RabbitMQ; the email worker (a separate container) takes it, sends the email over SMTP and only then acks it.',
    expected: '201 in well under a second; the worker acks a few seconds later',
    run: async (ctx) => {
      const before = await ctx.status('Read the queue numbers before');
      const missing = needs(ctx, before, { rabbitMq: true, worker: true });
      if (missing) return missing;
      const { email } = await ctx.customer();
      const order = await placeOrder(ctx);
      const placedAt = performance.now();
      const sent = await ctx.waitFor(
        'Wait until the worker has sent the email and acked the message',
        (s) => emailQueue(s).acked > emailQueue(before).acked && s.outboxPending === 0 && emailQueue(s).unacked === 0,
        60_000,
      );
      const took = performance.now() - placedAt;
      return {
        pass: sent.ok,
        summary: sent.ok
          ? `The order answered 201 in ${ms(order.ms)}. The worker sent the email ${seconds(took)} later, while nobody waited for it. It is in Mailtrap, to ${email}.`
          : 'The worker did not ack within a minute. Look at: docker compose logs email-worker',
        steps: ctx.log,
        body: { orderId: order.id, orderAnsweredMs: Math.round(order.ms), emailsSentBefore: emailQueue(before).acked, emailsSentAfter: emailQueue(sent.status).acked },
      };
    },
  },
  {
    id: 'worker-down',
    title: 'Proof 1: the worker is stopped, the emails wait in the queue; it starts, it sends them all.',
    proves:
      'The queue is durable and the messages are persistent, so they wait in RabbitMQ while no worker is running. The check places 3 orders while the worker is stopped, shows them waiting (Ready = 3), then waits for you to start the worker and watches the queue empty.',
    expected: 'Ready goes up by 3, then back to 0 after the start',
    setup: <Commands lines="docker compose stop email-worker" after="Run the check. When it says so, start the worker: docker compose start email-worker" />,
    run: async (ctx) => {
      const before = await ctx.status('Read the queue numbers before');
      if (!before.rabbitMqReachable) return needs(ctx, before, { rabbitMq: true })!;
      if (emailQueue(before).consumers > 0) {
        return { pass: false, summary: 'The worker is running. Stop it first: docker compose stop email-worker, then run this check again.', steps: ctx.log };
      }
      const { email } = await ctx.customer();
      for (let i = 1; i <= 3; i++) await placeOrder(ctx, `Order ${i} of 3`);
      const waiting = await ctx.waitFor('Wait until the 3 messages are in the queue', (s) => emailQueue(s).ready >= emailQueue(before).ready + 3, 20_000);
      if (!waiting.ok) return { pass: false, summary: 'The 3 messages did not reach the queue. Is the API publishing? docker compose logs app', steps: ctx.log };
      const ready = emailQueue(waiting.status).ready;
      ctx.progress(`${ready} emails are waiting in email.order-created and nothing is lost. Now start the worker: docker compose start email-worker`);
      const drained = await ctx.waitFor(
        'Wait for the worker to start and empty the queue',
        (s) => emailQueue(s).consumers > 0 && emailQueue(s).ready === 0 && emailQueue(s).unacked === 0,
        180_000,
      );
      return {
        pass: drained.ok,
        summary: drained.ok
          ? `While the worker was stopped, ${ready} messages waited in the queue. When it started, it took them all and sent the emails (Mailtrap, to ${email}). None was lost.`
          : 'The queue did not empty within 3 minutes. Did you start the worker? docker compose start email-worker',
        steps: ctx.log,
        body: { waitingWhileStopped: ready, afterStart: emailQueue(drained.status) },
      };
    },
  },
  {
    id: 'dlq',
    title: 'A message the worker cannot handle goes to the dead-letter queue.',
    proves:
      'The admin puts one broken order.created event in the outbox (no customer email, no items). It travels the normal way to the worker, which rejects it (Nack, requeue: false). The queue has x-dead-letter-exchange, so RabbitMQ moves it to shop.dead-letter and on to email.order-created.dead, with an x-death header that says why.',
    expected: 'the DLQ gets the message, with reason "rejected"',
    run: async (ctx) => {
      const before = await ctx.status('Read the queue numbers before');
      const missing = needs(ctx, before, { rabbitMq: true, worker: true });
      if (missing) return missing;
      const sent = await timed(ctx.log, 'Put a broken event in the outbox', '/queue-checks/broken-message', { method: 'POST' });
      if (sent.status === 404) return { pass: false, summary: 'POST /queue-checks/broken-message exists only in Development (ASPNETCORE_ENVIRONMENT).', steps: ctx.log };
      if (sent.status !== 202) return { pass: false, summary: `The API answered ${sent.status}.`, steps: ctx.log, body: sent.body };
      const messageId = String(sent.body?.messageId);
      const dead = await ctx.waitFor('Wait until the DLQ has one more message', (s) => deadQueue(s).ready > deadQueue(before).ready, 30_000);
      if (!dead.ok) return { pass: false, summary: 'Nothing reached the DLQ within 30 s. Look at: docker compose logs email-worker', steps: ctx.log };
      const list = await timed(ctx.log, 'Read the DLQ (the messages stay in it)', '/queue-checks/dead-letters');
      const found = (Array.isArray(list.body) ? (list.body as DeadLetter[]) : []).find((m) => m.messageId === messageId);
      const death = found?.xDeath?.[0];
      return {
        pass: !!found && death?.reason === 'rejected',
        summary: found
          ? `The worker rejected it, and RabbitMQ moved it to email.order-created.dead. Its x-death header: reason "${death?.reason}", from the queue "${death?.queue}" through "${death?.exchange}". The DLQ now holds ${deadQueue(dead.status).ready}.`
          : 'The DLQ grew, but this message was not found in it.',
        steps: ctx.log,
        body: found,
      };
    },
  },
  {
    id: 'retries',
    title: 'The mail server fails: 3 retries, then the DLQ.',
    proves:
      'The worker tries to send 4 times (at once, then after 2, 5 and 10 seconds). If the 4th try fails too, it rejects the message, and the message goes to the DLQ instead of being lost or retried forever. The SMTP password lives only in .env, so the check breaks it there.',
    expected: 'no email is sent; the DLQ gets the message after about 17 s',
    setup: (
      <Commands
        lines={`# 1. Restart the worker with a wrong mail password (PowerShell; .env stays as it is):
$env:SMTP_PASSWORD = 'wrong'; docker compose up -d email-worker; Remove-Item Env:SMTP_PASSWORD
docker compose logs -f email-worker      # watch attempts 1 to 4, then "moving it to the DLQ"

# 2. Afterwards, restart it with the real password from .env:
docker compose up -d email-worker`}
        after="To send the message again: http://localhost:15672 › Queues › email.order-created.dead › Move messages › to email.order-created."
      />
    ),
    run: async (ctx) => {
      const before = await ctx.status('Read the queue numbers before');
      const missing = needs(ctx, before, { rabbitMq: true, worker: true });
      if (missing) return missing;
      await ctx.customer();
      await placeOrder(ctx);
      const end = await ctx.waitFor(
        'Wait for the worker: sent (ack) or given up (DLQ)',
        (s) => emailQueue(s).acked > emailQueue(before).acked || deadQueue(s).ready > deadQueue(before).ready,
        60_000,
      );
      const wentToDlq = deadQueue(end.status).ready > deadQueue(before).ready;
      return {
        pass: end.ok && wentToDlq,
        summary: !end.ok
          ? 'Neither sent nor in the DLQ after a minute. Look at: docker compose logs email-worker'
          : wentToDlq
            ? 'The worker tried 4 times, gave up and rejected the message: it is in the DLQ, not lost. Fix the password and move it back (see above).'
            : 'The email was sent: the mail server works. Break SMTP_PASSWORD in .env first (see above).',
        steps: ctx.log,
      };
    },
  },
  {
    id: 'rabbit-down',
    title: 'RabbitMQ is down: orders still work, their events wait in the outbox.',
    proves:
      'The order and its event are saved together in PostgreSQL. With RabbitMQ stopped the order still answers 201; the event waits in the outbox (OutboxPublisher retries every 5 s) and goes out as soon as RabbitMQ is back.',
    expected: '201; outbox pending 1, then 0 after the start',
    setup: <Commands lines="docker compose stop rabbitmq" after="Run the check. When it says so: docker compose start rabbitmq" />,
    run: async (ctx) => {
      const before = await ctx.status('Read the numbers before');
      if (before.rabbitMqReachable) {
        return { pass: false, summary: 'RabbitMQ is running. Stop it first: docker compose stop rabbitmq, then run this check again.', steps: ctx.log };
      }
      await ctx.customer();
      const order = await placeOrder(ctx);
      const waiting = await ctx.waitFor('The event waits in the outbox', (s) => s.outboxPending > 0, 5_000);
      ctx.progress(
        `The order answered 201 in ${ms(order.ms)} with RabbitMQ down; ${waiting.status.outboxPending} event(s) wait in the outbox. Now start it: docker compose start rabbitmq`,
      );
      const published = await ctx.waitFor('Wait for RabbitMQ and the outbox to empty', (s) => s.rabbitMqReachable && s.outboxPending === 0, 180_000);
      return {
        pass: waiting.ok && published.ok,
        summary: published.ok
          ? `The order was saved (201 in ${ms(order.ms)}) while RabbitMQ was down. When it came back, the outbox published the event, and the worker sends the email.`
          : 'The outbox did not empty within 3 minutes. Did you start RabbitMQ? docker compose start rabbitmq',
        steps: ctx.log,
      };
    },
  },
  {
    id: 'live-admin',
    title: 'Proof 2: a new order appears on the admin dashboard at once.',
    proves:
      'This page is subscribed to private-admin-orders, like the Orders dashboard. A customer places an order; right after saving it, the API asks Soketi (HTTP) to send order.created, and Soketi pushes it here over the open WebSocket. No reload, no polling.',
    expected: 'order.created arrives well under a second after the order',
    run: async (ctx) => {
      if (!ctx.adminLive()) {
        return { pass: false, summary: 'This page is not subscribed (the badge says Connecting…). Is Soketi running? docker compose start soketi', steps: ctx.log };
      }
      await ctx.customer();
      const startedAt = performance.now();
      const order = await placeOrder(ctx);
      let heard: HeardOrder | undefined;
      for (let waited = 0; waited < 10_000 && !heard; waited += 50) {
        heard = ctx.heard().find((h) => h.event.order.id === order.id);
        if (!heard) await sleep(50);
      }
      if (heard) wsStep(ctx.log, 'This page (the admin) gets the event', ADMIN_CHANNEL, 'order.created', startedAt);
      return {
        pass: !!heard,
        summary: heard
          ? `The admin got order.created for ${shortId(order.id)} (${heard.event.customerEmail}) ${ms(heard.at - startedAt)} after the customer sent the order.`
          : 'No order.created arrived within 10 s. Look at: docker compose logs app soketi',
        steps: ctx.log,
        body: heard?.event,
      };
    },
  },
  {
    id: 'live-customer',
    title: 'Proof 3: the admin’s approval appears on the customer’s order page at once.',
    proves:
      'A customer places an order and opens its channel, private-order-<id> (here: a WebSocket this page opens for the customer, with the customer’s token). The admin confirms the order (PATCH /orders/{id}/status); the customer’s socket gets order.status-changed.',
    expected: 'the customer gets "Confirmed" well under a second later',
    run: async (ctx) => {
      const key = await realtimeKey(ctx.log);
      const { token } = await ctx.customer();
      const order = await placeOrder(ctx);
      const socket = await openSocket(ctx.log, key, 'Customer');
      try {
        const channel = `private-order-${order.id}`;
        const joined = await join(ctx.log, socket, channel, token, 'Customer');
        if (joined !== 'joined') return { pass: false, summary: `The customer could not join their own order's channel: ${joined}.`, steps: ctx.log };
        const hear = socket.next((m) => m.event === 'order.status-changed', 10_000);
        const startedAt = performance.now();
        const patch = await timed(ctx.log, 'The admin confirms the order', `/orders/${order.id}/status`, { method: 'PATCH', body: { status: 'Confirmed' } });
        if (patch.status !== 200) return { pass: false, summary: `Confirming failed (${patch.status}).`, steps: ctx.log, body: patch.body };
        const message = await hear;
        const data = JSON.parse(String(message.data)) as { status: string };
        wsStep(ctx.log, 'The customer’s socket gets the event', channel, `order.status-changed: ${data.status}`, startedAt);
        return {
          pass: data.status === 'Confirmed',
          summary: `The customer got order.status-changed (${data.status}) ${ms(performance.now() - startedAt)} after the admin pressed Confirm, with no reload.`,
          steps: ctx.log,
          body: data,
        };
      } finally {
        socket.close();
      }
    },
  },
  {
    id: 'permissions',
    title: 'Only the right people can listen.',
    proves:
      'Every channel is private-: Soketi lets a socket join only with a signature from our API (HMAC with the secret). POST /realtime/auth checks the JWT (who?) and CanWatchChannelAsync (may they?: admin channel for admins, an order channel for its owner, the same rule as GET /orders/{id}). A made-up signature is refused by Soketi itself.',
    expected: '403, 403, 401, refused by Soketi; the owner joins',
    run: async (ctx) => {
      const key = await realtimeKey(ctx.log);
      const owner = await ctx.customer();
      const other = await ctx.otherCustomer();
      const order = await placeOrder(ctx);
      const orderChannel = `private-order-${order.id}`;
      const ownerTab = await openSocket(ctx.log, key, 'Customer');
      const otherTab = await openSocket(ctx.log, key, 'Another customer');
      const anonymousTab = await openSocket(ctx.log, key, 'Not logged in');
      try {
        const results = [
          { who: 'A customer → the admin channel', expected: 'refused by the API (403)', got: await join(ctx.log, ownerTab, ADMIN_CHANNEL, owner.token, 'Customer') },
          { who: 'Another customer → this customer’s order', expected: 'refused by the API (403)', got: await join(ctx.log, otherTab, orderChannel, other.token, 'Another customer') },
          { who: 'Not logged in → this customer’s order', expected: 'refused by the API (401)', got: await join(ctx.log, anonymousTab, orderChannel, null, 'Not logged in') },
          {
            who: 'A customer with a made-up signature → the admin channel',
            expected: 'refused by Soketi (pusher:subscription_error)',
            got: await subscribe(ctx.log, ownerTab, ADMIN_CHANNEL, `${key}:${'0'.repeat(64)}`, 'Customer', 'Customer: skip the API, send a made-up signature'),
          },
          { who: 'The customer → their own order', expected: 'joined', got: await join(ctx.log, ownerTab, orderChannel, owner.token, 'Customer') },
        ];
        const failed = results.filter((r) => r.got !== r.expected);
        return {
          pass: failed.length === 0,
          summary:
            failed.length === 0
              ? 'Each stranger was refused (by the API, or by Soketi for the fake signature), and only the owner joined their order’s channel.'
              : `Unexpected: ${failed.map((r) => `${r.who}: ${r.got}`).join('; ')}.`,
          steps: ctx.log,
          visual: (
            <table className="table body-sm" style={{ marginTop: 'var(--space-sm)' }}>
              <tbody>
                {results.map((r) => (
                  <tr key={r.who}>
                    <td>{r.who}</td>
                    <td className="strong">{r.got}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ),
        };
      } finally {
        for (const tab of [ownerTab, otherTab, anonymousTab]) tab.close();
      }
    },
  },
  {
    id: 'soketi-down',
    title: 'Soketi is down: orders still work, the badge waits, then reconnects.',
    proves:
      'Live updates are best effort: the order is already saved, so a failed TryPublishAsync is only logged (after at most 2 s). pusher-js keeps trying to reconnect; when Soketi is back it joins the channel again and the badge turns Live by itself.',
    expected: '201 while Soketi is stopped; Live again after the start',
    setup: <Commands lines="docker compose stop soketi" after="Run the check. When it says so: docker compose start soketi" />,
    run: async (ctx) => {
      if (ctx.adminLive()) {
        return { pass: false, summary: 'Soketi is running (the badge says Live). Stop it first: docker compose stop soketi, wait for the badge to say Connecting…, then run this check.', steps: ctx.log };
      }
      await ctx.customer();
      const order = await placeOrder(ctx);
      ctx.progress(`The order answered 201 in ${ms(order.ms)} with Soketi down (the API logged a warning). Now start it: docker compose start soketi`);
      let back = false;
      const startedAt = performance.now();
      for (let waited = 0; waited < 180_000 && !back; waited += 500) {
        back = ctx.adminLive();
        if (!back) await sleep(500);
      }
      if (back) wsStep(ctx.log, 'pusher-js reconnected and joined again', ADMIN_CHANNEL, 'Live', startedAt);
      return {
        pass: back,
        summary: back
          ? `The order was saved (201 in ${ms(order.ms)}) without Soketi. When Soketi came back, this page reconnected and joined ${ADMIN_CHANNEL} again by itself, without a reload.`
          : 'Still not live after 3 minutes. Did you start Soketi? docker compose start soketi',
        steps: ctx.log,
      };
    },
  },
];

const AUTOMATIC = CHECKS.filter((c) => !c.setup);

// ---------- The page ----------

function Tile({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: 'success' | 'error' }) {
  return (
    <div className="queue-tile">
      <span className="caption muted">{label}</span>
      <span className={`queue-tile-value tabular ${tone ? `queue-tile-${tone}` : ''}`}>{value}</span>
      {note && <span className="caption muted">{note}</span>}
    </div>
  );
}

function StatusCard({ status, error, live, heard }: { status: QueueStatus | null; error: string | null; live: boolean; heard: HeardOrder[] }) {
  const email = status ? emailQueue(status) : null;
  const dead = status ? deadQueue(status) : null;
  const reachable = status?.rabbitMqReachable;
  return (
    <div className="card stack gap-md" style={{ marginBottom: 'var(--space-lg)' }}>
      <div className="row gap-sm wrap" style={{ justifyContent: 'space-between' }}>
        <h2 className="title">Right now</h2>
        <span className="caption muted">read every second · the same numbers as http://localhost:15672</span>
      </div>
      {error ? (
        <Notice tone="error" icon="alert" title="Could not read the queue numbers.">
          {error}
        </Notice>
      ) : (
        <div className="queue-tiles">
          <Tile label="Outbox: events not sent yet" value={status ? status.outboxPending : '…'} note="saved with the order, waiting for RabbitMQ" />
          <Tile
            label="RabbitMQ"
            value={status ? (reachable ? 'Running' : 'Not answering') : '…'}
            tone={status ? (reachable ? 'success' : 'error') : undefined}
            note="message broker"
          />
          <Tile
            label="Email worker"
            value={email ? (email.consumers > 0 ? 'Running' : 'Stopped') : '—'}
            tone={email ? (email.consumers > 0 ? 'success' : 'error') : undefined}
            note={email ? `${email.consumers} consumer(s) on the queue` : 'unknown while RabbitMQ is down'}
          />
          <Tile label="email.order-created" value={email ? `${email.ready} · ${email.unacked}` : '—'} note={email ? `ready · being sent now · ${email.acked} sent since RabbitMQ started` : undefined} />
          <Tile label="DLQ: email.order-created.dead" value={dead ? dead.ready : '—'} note="messages that failed" tone={dead && dead.ready > 0 ? 'error' : undefined} />
          <Tile label="Live updates (this page)" value={<LiveBadge live={live} />} note={ADMIN_CHANNEL} />
        </div>
      )}
      {heard.length > 0 && (
        <div className="stack gap-xs">
          <span className="caption muted">Heard on {ADMIN_CHANNEL} (newest first)</span>
          <ul className="list stack gap-xxs body-sm">
            {heard
              .slice(-5)
              .reverse()
              .map((h) => (
                <li key={h.event.order.id} className="mono">
                  order.created · {shortId(h.event.order.id)} · {h.event.customerEmail} · {h.event.order.status}
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function QueueChecksPage() {
  const [status, setStatus] = useState<QueueStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [heard, setHeard] = useState<HeardOrder[]>([]);
  const heardRef = useRef<HeardOrder[]>([]);
  const liveRef = useRef(false);
  const customers = useRef<Record<string, { email: string; token: string }>>({});
  const productRef = useRef<Product | null>(null);

  // This page is an admin dashboard too: it listens to new orders like the Orders page does.
  const live = useLiveChannel<OrderCreatedLive>(ADMIN_CHANNEL, 'order.created', (event) => {
    heardRef.current = [...heardRef.current, { at: performance.now(), event }];
    setHeard(heardRef.current);
  });
  liveRef.current = live;

  // The status card: one small request per second while the page is open. The next one starts only after the
  // last one answered: with RabbitMQ stopped an answer takes up to 3 s, and requests must not pile up.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const s = await api<QueueStatus>('/queue-checks/status');
        if (!stopped) {
          setStatus(s);
          setStatusError(null);
        }
      } catch (err) {
        if (!stopped) setStatusError(err instanceof Error ? err.message : String(err));
      }
      if (!stopped) timer = setTimeout(read, 1000);
    };
    read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  /** One temporary customer per role and visit: login is limited to 5 per minute, so each logs in once. */
  const makeCustomer = (log: Step[], role: string) => async () => {
    if (customers.current[role]) return customers.current[role];
    const email = `${role}.${Date.now()}@shop.test`;
    const password = `Checks-${crypto.randomUUID()}`;
    const reg = await timed(log, `Create a temporary customer (${email})`, '/auth/register', { method: 'POST', body: { email, password }, token: null });
    if (reg.status !== 201) throw new Error(`Creating the temporary customer failed (${reg.status}).`);
    const login = await timed(log, 'Log in as that customer', '/auth/login', { method: 'POST', body: { email, password }, token: null });
    if (login.status === 429) throw new Error('Login is limited to 5 attempts per minute. Wait a minute and run the check again.');
    if (login.status !== 200) throw new Error(`Logging in the temporary customer failed (${login.status}).`);
    customers.current[role] = { email, token: String(login.body?.accessToken) };
    return customers.current[role];
  };

  /** A product with stock, so the orders are accepted (the admin tops the stock up if it is low). */
  const pickProduct = (log: Step[]) => async () => {
    if (productRef.current) return productRef.current;
    const list = await timed(log, 'Pick a product', '/products?page=1&pageSize=1', { token: null });
    const product = ((list.body?.items ?? []) as Product[])[0];
    if (!product) throw new Error('There are no products. Add one (or run the seed) first.');
    const details = await timed(log, `Read the stock of ${product.name}`, `/products/${product.id}`, { token: null });
    const stock = details.body?.stock as number | null | undefined;
    if (stock == null) throw new Error('The inventory service is not answering, so orders cannot reserve stock. Start it: docker compose start inventory');
    if (stock < 20) {
      const put = await timed(log, `Top the stock of ${product.name} up to 100`, `/products/${product.id}/stock`, { method: 'PUT', body: { quantity: 100 } });
      if (put.status !== 200) throw new Error(`Setting the stock failed (${put.status}).`);
    }
    productRef.current = product;
    return product;
  };

  const run = async (check: Check) => {
    setResults((r) => ({ ...r, [check.id]: { running: true } }));
    setProgress((p) => ({ ...p, [check.id]: '' }));
    const log: Step[] = [];
    const read = () => api<QueueStatus>('/queue-checks/status');
    const ctx: Ctx = {
      log,
      status: async (label = 'Read the queue numbers') => (await timed(log, label, '/queue-checks/status')).body as unknown as QueueStatus,
      waitFor: async (label, done, timeoutMs) => {
        const started = performance.now();
        let current = await read();
        while (!done(current) && performance.now() - started < timeoutMs) {
          await sleep(500);
          current = await read();
        }
        const ok = done(current);
        log.push({ label: `${label}${ok ? '' : ' (timed out)'}`, ex: { method: 'GET', url: '/api/v1/queue-checks/status (every 0.5 s)', status: 200 }, ms: performance.now() - started });
        return { ok, status: current };
      },
      product: pickProduct(log),
      customer: makeCustomer(log, 'queue.customer'),
      otherCustomer: makeCustomer(log, 'queue.other'),
      adminLive: () => liveRef.current,
      heard: () => heardRef.current,
      progress: (text) => setProgress((p) => ({ ...p, [check.id]: text })),
    };
    try {
      const outcome = await check.run(ctx);
      setResults((r) => ({ ...r, [check.id]: { running: false, outcome } }));
    } catch (err) {
      setResults((r) => ({ ...r, [check.id]: { running: false, error: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setProgress((p) => ({ ...p, [check.id]: '' }));
    }
  };

  const runAll = async () => {
    for (const check of AUTOMATIC) await run(check);
  };

  const finished = Object.values(results).filter((r) => r.outcome);
  const passed = finished.filter((r) => r.outcome!.pass).length;
  const busy = Object.values(results).some((r) => r.running);

  return (
    <main className="main main-medium">
      <PageHeader
        title="Queue checks."
        lead="Requirement 4, live: the confirmation email goes through RabbitMQ to a separate worker, and new orders and status changes reach the right browsers at once over WebSocket (Soketi). Each check calls the real API."
        actions={
          <button type="button" className="btn btn-primary" onClick={runAll} disabled={busy}>
            <Icon name="play" size={16} />
            Run all
          </button>
        }
      />

      <StatusCard status={status} error={statusError} live={live} heard={heard} />

      <p className="caption muted" style={{ marginBottom: 'var(--space-lg)' }}>
        The orders are placed by temporary customers this page creates; their emails arrive in the Mailtrap inbox. “Run all” runs the checks that
        need nothing by hand (1, 3, 6, 7 and 8). The others start with a command in a terminal (shown on the check). The same proofs as scripts:
        <span className="mono"> node api-tests/r4/proof-worker.mjs</span> and <span className="mono">node api-tests/r4/proof-realtime.mjs</span>.
      </p>

      {finished.length > 0 && (
        <div style={{ marginBottom: 'var(--space-lg)' }}>
          <Notice
            tone={passed === finished.length ? 'success' : 'soft'}
            icon={passed === finished.length ? 'shield' : 'alert'}
            title={`${passed} of ${finished.length} checks passed.`}
          />
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
              <button type="button" className="btn btn-soft btn-sm" onClick={() => run(check)} disabled={busy}>
                Run
              </button>
            </div>
            {check.setup}
            {progress[check.id] && (
              <Notice tone="soft" icon="info" title="Waiting for you.">
                {progress[check.id]}
              </Notice>
            )}
            {results[check.id] && <ResultView result={results[check.id]} />}
          </li>
        ))}
      </ol>
    </main>
  );
}
