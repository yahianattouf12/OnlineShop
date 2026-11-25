# Requirement 4: Asynchronous Queues & Real-Time, results

Machine: one Windows PC, Docker Desktop. Containers: `app` (API), `email-worker`, `rabbitmq` (4.1 with the
management UI), `soketi` (1.6), `web` (nginx), plus the databases and the inventory service from Requirements 1 to 3.
Mail: Mailtrap Email Sandbox (a real SMTP server; the login is only in `.env`).
All numbers below are from 25 November 2026.

## How to run it

```powershell
docker compose up -d                       # everything, including rabbitmq, email-worker and soketi
node api-tests/r4/proof-worker.mjs         # proof 1
node api-tests/r4/proof-realtime.mjs       # proofs 2 and 3 + the channel permissions (a minute later: login limit)
```

Or in the browser: log in as the admin, open **Queue checks** (`/queue-checks`). Every proof below is a check there,
with a live card of the outbox, RabbitMQ, the worker, the queue and the DLQ. Commands for the demos by hand:
`api-tests/r4/r4-demo-commands.txt`.

## 1. How it works

```
 customer --POST /orders--> API --(same transaction)--> orders + OutboxMessages   (answer 201 at once)
                             |
                             +-- OutboxPublisher (every 1 s) --> RabbitMQ exchange "shop.events"
                                                                    | routing key "order.created"
                                                                    v
                                                          queue "email.order-created"
                                                                    |
                                                                    v
                                     Email Worker (ack only after the email is sent) --SMTP--> Mailtrap
                                                                    |
                                                 fails 4 times -> Nack -> "shop.dead-letter" -> DLQ
                                                                           "email.order-created.dead"

 API --HTTP (Pusher API)--> Soketi ==WebSocket (nginx /app/)==> admin browser:    private-admin-orders
 API --HTTP (Pusher API)--> Soketi ==WebSocket (nginx /app/)==> customer browser: private-order-<id>

 before joining a private channel:  browser --POST /api/v1/realtime/auth (JWT)--> API: role? owner? -> signature
```

## 2. The queue: no email is lost

- The order and its `order.created` event are saved in **one transaction** (the outbox), and the API answers `201`
  without waiting for any email.
- `OutboxPublisher` (a background service in the API) sends waiting events to RabbitMQ every second, with publisher
  confirms and `mandatory: true`; the queue is durable and the messages persistent.
- The email worker is a separate program (`app/Shop.EmailWorker`, its own container): `autoAck: false`,
  `prefetch 1`, and `BasicAck` **only after** the SMTP server accepted the email.
- Failure: 3 retries (after 2 s, 5 s, 10 s), then `BasicNack(requeue: false)`: the queue's
  `x-dead-letter-exchange` sends it to `shop.dead-letter` and on to `email.order-created.dead`.
  A message that is not a valid order goes there at once (retrying cannot fix it).
- The worker reads everything from the message (even the customer's email, taken from the JWT), never from the
  shop's database.

### Proof 1: stop the worker, then start it (`node api-tests/r4/proof-worker.mjs`)

```
1. docker compose stop email-worker
2. order 6c23296f placed, answer in 95 ms (nobody waits for the email)
2. order 4c4f868d placed, answer in 95 ms (nobody waits for the email)
2. order 117c6058 placed, answer in 103 ms (nobody waits for the email)
3. worker stopped: 3 messages are waiting in email.order-created (not lost)
4. docker compose start email-worker
5. the queue is empty again: the worker took and acked every message
   order 6c23296f: email sent
   order 4c4f868d: email sent
   order 117c6058: email sent

PROOF OK: the worker was stopped, 3 orders were placed, and after the restart all 3 emails were sent.
```

The same from the browser (Queue checks 2): "While the worker was stopped, 3 messages waited in the queue. When
it started, it took them all and sent the emails. None was lost."

### The other queue checks (Queue checks page, all passed)

| Check | Result |
|---|---|
| 1. The order does not wait for the email | `201` in 56 ms; the worker acked the message 17.5 s later (Mailtrap's free plan limits emails per second, so the worker retried) |
| 3. A broken message → DLQ | rejected by the worker; in `email.order-created.dead` with `x-death`: reason `rejected`, queue `email.order-created` |
| 4. Wrong mail password | 4 attempts, then the DLQ; no email sent, nothing lost. Moved back with the management UI's **Move messages** |
| 5. RabbitMQ stopped | the order answered `201` in 109 ms; 1 event waited in the outbox and was published when RabbitMQ came back |

## 3. Live updates

- Soketi, a ready-made WebSocket server that speaks the Pusher protocol. The browser reaches it through nginx on
  the site's own origin (`/app/`), so the Content-Security-Policy (`connect-src 'self'`) needs no change.
- After saving, the API asks Soketi over HTTP (signed with the secret) to send the event: `order.created` on
  `private-admin-orders`, `order.status-changed` on `private-order-<id>`. Best effort: if Soketi is down, the
  order still succeeds and a warning is logged (at most 2 s).
- Private channels: before joining, the browser calls `POST /api/v1/realtime/auth` with its JWT. The API checks
  the role (admin channel) or the ownership (order channel, with `VisibleOrders()`, the same rule that protects
  `GET /orders/{id}`), then signs `socket_id:channel` with HMAC-SHA256. Soketi refuses a join without a valid
  signature.
- The order page reloads its data each time it (re)joins its channel, so a change made while the connection was
  down is not missed; the **Live** badge shows when a page is subscribed and connected.

### Proofs 2 and 3, and the permissions (`node api-tests/r4/proof-realtime.mjs`)

```
Permissions:
  admin    -> private-admin-orders: joined
  customer -> private-admin-orders: refused by the API (403)
  customer -> private-admin-orders with a forged signature: refused by Soketi (pusher:subscription_error)

Proof 2: a new order appears on the admin dashboard at once
  customer placed order e4c23238 -> admin got "order.created" for e4c23238 (realtime-customer-1795579811146@test.local) after 91 ms
  customer -> private-order-e4c23238... (own order): joined
  other    -> private-order-e4c23238... (NOT theirs): refused by the API (403)

Proof 3: the admin's approval appears on the customer's order page at once
  admin confirmed the order -> customer got "order.status-changed": Confirmed after 64 ms

PROOF OK: both live updates arrived without any page reload, and only the right people could listen.
```

From the browser (Queue checks 6 to 9): the admin page got `order.created` 61 ms after the order; the customer's
socket got `Confirmed` 24 ms after the admin's PATCH; strangers got `403`, `403` and `401`, a forged signature
was refused by Soketi, and the owner joined. With Soketi stopped, the order still answered `201` (2.08 s, the
2-second limit on calls to Soketi), the badge showed **Connecting…**, and after `docker compose start soketi` the
page joined again by itself.

## 4. What we observed

- The order answer does not wait for the email any more (tens of ms), and a slow or broken mail service cannot
  fail an order.
- With RabbitMQ down, orders still work; the events wait in the outbox and go out when it is back.
- At least once: a crash between "email sent" and "ack" sends the email again. The `EventId` (also the RabbitMQ
  `MessageId`) would let the worker skip a duplicate; we did not add that store.
- The admin list may come from the read replica (Requirement 3), so a new order is added to the dashboard from
  the event itself, not by reloading the list.
- The first requests after a restart are slower (about 1 s for the first live event), while .NET and the
  connections warm up; after that, tens of ms.
- RabbitMQ refreshes its queue numbers every second here (`deploy/rabbitmq/onlineshop.conf`, default 5 s), so the
  management UI and the Queue checks page show a message arrive and leave at once.
