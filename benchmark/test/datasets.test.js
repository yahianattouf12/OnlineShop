const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize, fingerprint, getState, start } = require('../src/datasets');
const { calculate } = require('../src/telemetry');

const config = { orders: 150000, products: 50000, stockMin: 25, stockMax: 900, acceptDatasetChange: true };
test('fixture settings support variable volumes and refuse invalid or unconfirmed writes', () => {
  assert.equal(normalize(config).orders, 150000);
  assert.equal(normalize(config).products, 50000);
  for (const patch of [{ orders: -1 }, { orders: 1.2 }, { orders: 1000001 }, { products: 200001 },
    { orders: '100; DROP TABLE x' }, { products: 0 }, { stockMax: 20 }, { stockMin: -1 },
    { customers: 0 }, { customerEvery: 0 }, { acceptDatasetChange: false }, { customerPassword: 'short' }]) {
    assert.throws(() => normalize({ ...config, ...patch }));
  }
  assert.equal(normalize({ ...config, orders: 0, products: 0 }).orders, 0);
});

test('fixture writes are disabled outside the dedicated stack', () => {
  const previous = process.env.BENCHMARK_PROJECT;
  process.env.BENCHMARK_PROJECT = 'onlineshop';
  try {
    assert.equal(getState().enabled, false);
    assert.throws(() => start({}, config), error => error.status === 409);
  } finally {
    if (previous === undefined) delete process.env.BENCHMARK_PROJECT;
    else process.env.BENCHMARK_PROJECT = previous;
  }
});

test('dataset identity survives repeat preparation but changes with workload data', () => {
  const data = { config: normalize(config), counts: { orders: 150010, products: 50001 }, fixture: { orders: 150000, products: 50000 }, samples: { productIds: ['a'] } };
  assert.equal(fingerprint({ ...data, id: 'first', preparedAt: 'today' }), fingerprint({ ...data, id: 'next', preparedAt: 'tomorrow' }));
  assert.notEqual(fingerprint(data), fingerprint({ ...data, counts: { orders: 150011, products: 50001 } }));
  assert.notEqual(fingerprint(data), fingerprint({ ...data, config: { ...data.config, stockMax: 1000 } }));
});

const before = { sampledAt: '2026-11-10T12:00:00Z', api: { processId: 1, startedAt: '2026-11-10T11:00:00Z', cpuTotalMs: 100, memoryBytes: 1048576 },
  database: { available: true, name: 'shop', statsReset: null, commits: 100, rollbacks: 2, blocksHit: 200, blocksRead: 10, activeConnections: 3 } };
const after = { sampledAt: '2026-11-10T12:00:02Z', api: { ...before.api, cpuTotalMs: 600 },
  database: { ...before.database, commits: 120, rollbacks: 4, blocksHit: 218, blocksRead: 12 } };

test('telemetry calculates process CPU and database interval rates from real counters', () => {
  const value = calculate(after, before);
  assert.equal(value.api.cpuPercent, 25);
  assert.equal(value.api.memoryBytes, 1048576);
  assert.equal(value.database.transactionsPerSecond, 11);
  assert.equal(value.database.cacheHitRate, .9);
  assert.equal(value.database.activeConnections, 3);
});

test('telemetry does not invent rates on first sample, restart or counter reset', () => {
  assert.equal(calculate(after, null).api.cpuPercent, null);
  assert.equal(calculate(after, null).database.transactionsPerSecond, null);
  assert.equal(calculate({ ...after, api: { ...after.api, processId: 2 } }, before).api.cpuPercent, null);
  assert.equal(calculate({ ...after, database: { ...after.database, statsReset: '2026-11-10T12:00:01Z' } }, before).database.cacheHitRate, null);
  assert.equal(calculate({ ...after, database: { ...after.database, commits: 5 } }, before).database.transactionsPerSecond, null);
});
