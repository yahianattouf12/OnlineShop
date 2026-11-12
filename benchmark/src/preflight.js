const { DATASET, CASES, UUID } = require('./config');
const shop = require('./shop');
const { Problem } = require('./problem');

let detected = { id: null, at: 0 };

async function benchmarkProductId(given) {
  if (given) {
    if (!UUID.test(given)) throw new Problem(400, 'The product ID is not valid.', 'Use the UUID of a product in the benchmark shop.', { field: 'productId' });
    return given.toLowerCase();
  }
  if (detected.id && Date.now() - detected.at < 60_000) return detected.id;
  detected = { id: await shop.findBenchmarkProduct(), at: Date.now() };
  return detected.id;
}

const check = (id, title, status, detail, hint) => ({ id, title, status, detail, hint: hint ?? null });
const count = (value) => value.toLocaleString('en-US');

/**
 * Is the benchmark shop ready for each workload? benchmark.js checks the same fixtures on every
 * response (200,000 orders, 4,000 for the customer, stock 100), so a run on the wrong data fails anyway:
 * better to say it before spending a minute on it.
 */
async function preflight(session, { productId: givenProductId, customerPassword } = {}) {
  // customerPassword comes only from a request body (POST /runs, POST /customer-session), never from a URL.
  const checks = [];
  const dataset = { orders: null, customerOrders: null, productStock: null, etag: null };
  const startedAt = Date.now();

  const ping = await shop.call('/products?page=1&pageSize=1');
  checks.push(ping.status === 200
    ? check('api', 'The shop API answers', 'pass', `GET /products answered in ${Date.now() - startedAt} ms.`)
    : check('api', 'The shop API answers', 'fail', `GET /products returned ${ping.status}.`, 'docker compose -p onlineshop-bench up -d --build app inventory'));

  const productId = await benchmarkProductId(givenProductId);
  let product = null;
  if (!productId) {
    checks.push(check('product', 'The benchmark product exists', 'fail', `No product named ${DATASET.productName}.`, 'node seed/benchmark-all.mjs 200000'));
  } else {
    product = await shop.call(`/products/${productId}`);
    if (product.status !== 200) {
      checks.push(check('product', 'The benchmark product exists', 'fail', `GET /products/${productId} returned ${product.status}.`, 'Check the product ID, or run the seeder.'));
    } else {
      dataset.productStock = product.json?.stock ?? null;
      dataset.etag = product.headers.get('etag');
      const ok = dataset.productStock === DATASET.productStock;
      checks.push(check('product', `${product.json?.name ?? 'The product'} has ${DATASET.productStock} in stock`, ok ? 'pass' : 'fail',
        dataset.productStock === null
          ? 'The stock is unknown: the inventory service is not answering.'
          : `The stock is ${count(dataset.productStock)}; the product workloads expect exactly ${DATASET.productStock}.`,
        ok ? null : dataset.productStock === null ? 'docker compose -p onlineshop-bench up -d inventory' : `Set its stock back to ${DATASET.productStock} (Inventory page, or rerun the seeder).`));
      checks.push(check('etag', 'Product responses carry an ETag', dataset.etag ? 'pass' : 'info',
        dataset.etag ? `ETag ${dataset.etag}: product-etag can run with “Send the current ETag” (expects 304).` : 'No ETag yet: product-etag measures the full 200 (the “before” case).'));
    }
  }

  const orders = await shop.call('/orders?page=1&pageSize=1', { token: session.token });
  if (orders.status === 200) {
    dataset.orders = orders.json?.totalCount ?? null;
    const ok = dataset.orders === DATASET.orders;
    checks.push(check('orders', `${count(DATASET.orders)} orders in the shop`, ok ? 'pass' : 'fail',
      `The admin sees ${count(dataset.orders ?? 0)} orders.`, ok ? null : 'node seed/benchmark-all.mjs 200000'));
  } else {
    checks.push(check('orders', `${count(DATASET.orders)} orders in the shop`, 'fail', `GET /orders returned ${orders.status}.`));
  }

  // The customer is checked only when we can log in without spending the login limit for nothing.
  let customer = shop.knownCustomer();
  let customerProblem = null;
  if (!customer && (customerPassword || process.env.BENCHMARK_CUSTOMER_PASSWORD)) {
    try {
      customer = await shop.customerSession(customerPassword);
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      customerProblem = error;
    }
  }
  if (customer) {
    const mine = await shop.call('/orders?page=1&pageSize=1', { token: customer.token });
    dataset.customerOrders = mine.status === 200 ? mine.json?.totalCount ?? null : null;
    const ok = dataset.customerOrders === DATASET.customerOrders;
    checks.push(check('customer', `${count(DATASET.customerOrders)} orders for the benchmark customer`, ok ? 'pass' : 'fail',
      `${DATASET.customerEmail} has ${count(dataset.customerOrders ?? 0)} orders.`, ok ? null : 'node seed/benchmark-all.mjs 200000'));
  } else {
    checks.push(check('customer', `${count(DATASET.customerOrders)} orders for the benchmark customer`, customerProblem ? 'fail' : 'info',
      customerProblem ? customerProblem.detail : `Enter the password of ${DATASET.customerEmail} to check it (needed for orders-customer).`));
  }

  const productReady = dataset.productStock === DATASET.productStock;
  const reasons = {
    'orders-first': dataset.orders === DATASET.orders ? [] : [`Needs ${count(DATASET.orders)} orders.`],
    'orders-deep': dataset.orders === DATASET.orders ? [] : [`Needs ${count(DATASET.orders)} orders.`],
    'orders-customer': !customer
      ? ['Needs the benchmark customer’s password.']
      : dataset.customerOrders === DATASET.customerOrders ? [] : [`Needs ${count(DATASET.customerOrders)} customer orders.`],
    'product-hot': productReady ? [] : [`Needs the benchmark product with stock ${DATASET.productStock}.`],
    'product-etag': productReady ? [] : [`Needs the benchmark product with stock ${DATASET.productStock}.`],
  };

  return {
    checkedAt: new Date().toISOString(),
    productId,
    customerEmail: DATASET.customerEmail,
    customerReady: Boolean(customer),
    expected: DATASET,
    dataset,
    checks,
    cases: Object.fromEntries(CASES.map(({ id }) => [id, { ready: reasons[id].length === 0, reasons: reasons[id] }])),
  };
}

module.exports = { preflight, benchmarkProductId };
