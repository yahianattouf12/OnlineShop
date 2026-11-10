const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { RESULTS_DIR } = require('./config');
const { Problem } = require('./problem');
const operations = require('./operations');
const shop = require('./shop');

const EMAIL = 'benchmark-customer@example.invalid';
const DIR = path.join(RESULTS_DIR, '.lab');
const FILE = path.join(DIR, 'dataset.json');
const JOB_FILE = path.join(DIR, 'dataset-job.json');
const SQL_DIR = process.env.BENCHMARK_SEED_DIR ?? path.join(__dirname, '..', '..', 'seed');
let saved = null;
let job = null;
try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
try {
  job = JSON.parse(fs.readFileSync(JOB_FILE, 'utf8'));
  if (job?.status === 'running') Object.assign(job, { status: 'failed', error: 'The service stopped during fixture preparation. Prepare it again before comparing runs.' });
} catch {}

function persist(file, value) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

function enabled() {
  return process.env.BENCHMARK_PROJECT === 'onlineshop-bench' &&
    Boolean(process.env.BENCHMARK_APP_DB_PASSWORD && process.env.BENCHMARK_INVENTORY_DB_PASSWORD);
}

function getState() {
  return { enabled: enabled(), reason: enabled() ? null : 'Data preparation is available only in the onlineshop-bench Docker project. Rebuild its benchmark service.',
    job, manifest: saved };
}

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Problem(400, 'Invalid data settings.', 'Send a JSON object.');
  const integer = (field, min, max, fallback) => {
    const value = input[field] ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new Problem(400, 'Invalid data settings.', `${field} must be a whole number from ${min} to ${max}.`, { field });
    }
    return value;
  };
  const config = {
    orders: integer('orders', 0, 1_000_000), products: integer('products', 0, 200_000),
    stockMin: integer('stockMin', 0, 1_000_000), stockMax: integer('stockMax', 0, 1_000_000),
    customers: integer('customers', 1, 10_000, 1000), customerEvery: integer('customerEvery', 1, 10_000, 50),
  };
  if (config.orders > 0 && config.products === 0) throw new Problem(400, 'Products are needed.', 'Prepare at least one product when creating orders.', { field: 'products' });
  if (config.stockMax < config.stockMin) throw new Problem(400, 'The stock range is reversed.', 'Maximum stock must be at least minimum stock.', { field: 'stockMax' });
  if (input.customerPassword !== undefined && (typeof input.customerPassword !== 'string' || input.customerPassword.length > 128 ||
      input.customerPassword.length > 0 && input.customerPassword.length < 8)) {
    throw new Problem(400, 'Invalid customer password.', 'Use 8 to 128 characters, or leave it blank for an existing customer.', { field: 'customerPassword' });
  }
  if (input.acceptDatasetChange !== true) throw new Problem(400, 'Confirm the fixture change.', 'This replaces studio-owned fixture orders/products and resets their stock. Existing unrelated data stays. Set acceptDatasetChange to true.');
  return config;
}

// No SQL, host, command or password can be supplied by the browser. psql receives fixed scripts on stdin.
function executeSql(database, sql, variables = {}) {
  const inventory = database === 'inventory';
  return new Promise((resolve, reject) => {
    const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
    for (const [key, value] of Object.entries(variables)) args.push('-v', `${key}=${value}`);
    const child = spawn(process.env.PSQL_BIN ?? 'psql', args, {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        PGHOST: inventory ? 'inventory-db' : 'app-db', PGPORT: '5432',
        PGDATABASE: inventory ? 'inventory' : 'db_online_shop', PGUSER: inventory ? 'inventory' : 'admin',
        PGPASSWORD: inventory ? process.env.BENCHMARK_INVENTORY_DB_PASSWORD : process.env.BENCHMARK_APP_DB_PASSWORD,
        PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'onlineshop-benchmark-seeder', PGSSLMODE: 'disable' },
    });
    let output = '', errors = '', stopped = false;
    const timer = setTimeout(() => { stopped = true; child.kill(); }, 240_000);
    child.stdout.on('data', data => { if (output.length < 2_000_000) output += data; });
    child.stderr.on('data', data => { if (errors.length < 16000) errors += data; });
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(new Error(error.code === 'ENOENT' ? 'PostgreSQL client is missing. Rebuild the benchmark image.' : 'Could not start the PostgreSQL client.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (stopped) return reject(new Error('Fixture preparation timed out. Prepare it again before benchmarking.'));
      if (code !== 0) return reject(new Error(`The ${database} database rejected fixture preparation. ${errors.replace(/NOTICE:[^\n]*/g, '').trim().slice(-2000)}`));
      resolve(output.trim());
    });
    child.stdin.end(sql);
  });
}

function lastJson(output) {
  const line = output.split(/\r?\n/).reverse().find(value => value.trim().startsWith('{'));
  if (!line) throw new Error('The database returned no fixture summary.');
  return JSON.parse(line);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify({ version: 1, config: value.config,
    counts: value.counts, fixture: value.fixture, samples: value.samples })).digest('hex');
}

async function prepare(record, config, password, release) {
  const update = (phase, message) => { record.phase = phase; record.logs.push(message); persist(JOB_FILE, record); };
  try {
    if (config.orders > 0) {
      update('customer', 'Checking the registered benchmark customer.');
      const customer = await executeSql('app', `SELECT count(*) FROM users."Users" WHERE "Email" = '${EMAIL}' AND "Role" = 'Customer';`);
      if (Number(customer) === 0) {
        if (!password) throw new Error('Enter a customer password (at least 8 characters) to create benchmark-customer@example.invalid, then prepare again.');
        const registration = await shop.call('/auth/register', { method: 'POST', body: { email: EMAIL, password } });
        if (registration.status !== 201 && registration.status !== 409) throw new Error(`Benchmark customer registration returned HTTP ${registration.status}.`);
        record.logs.push('Created the benchmark customer with the password you supplied.');
      } else record.logs.push('Reusing the benchmark customer with its existing password.');
    }
    password = '';
    update('application', 'Preparing studio-owned products, orders, order items and status history. Other records are retained.');
    const app = lastJson(await executeSql('app', fs.readFileSync(path.join(SQL_DIR, 'custom-benchmark-app.sql'), 'utf8'), {
      orders: config.orders, products: config.products, customers: config.customers, customer_every: config.customerEvery,
    }));
    update('inventory', 'Setting stock across the configured range in the separate inventory database.');
    const inventory = lastJson(await executeSql('inventory', fs.readFileSync(path.join(SQL_DIR, 'custom-benchmark-inventory.sql'), 'utf8'), {
      products: config.products, stock_min: config.stockMin, stock_max: config.stockMax,
    }));
    const next = { id: record.id, preparedAt: new Date().toISOString(), config,
      counts: { ...app.counts, inventory: inventory.inventory }, fixture: { ...app.fixture, inventory: inventory.fixtureInventory },
      samples: app.samples, observedStock: { min: inventory.stockMin, max: inventory.stockMax } };
    next.fingerprint = fingerprint(next);
    persist(FILE, next);
    saved = next;
    record.status = 'passed';
    update('complete', `Ready: ${next.fixture.orders} studio orders and ${next.fixture.products} studio products. The whole database contains ${next.counts.orders} orders and ${next.counts.products} products.`);
    record.logs.push('Customer fixture accounts left over from a smaller resize are retained; synthetic owners have no usable password. Product images are not generated.');
  } catch (error) {
    record.status = 'failed';
    record.error = error.message;
    record.logs.push(error.message, 'The application and inventory databases are separate transactions. If one stage completed, rerun preparation to finish both before comparing tests.');
  } finally {
    password = '';
    record.finishedAt = new Date().toISOString();
    try { persist(JOB_FILE, record); } finally { release(); }
  }
}

function start(session, body) {
  if (!enabled()) throw new Problem(409, 'Data preparation is disabled.', getState().reason);
  const config = normalize(body);
  const id = crypto.randomUUID();
  const release = operations.acquire('fixture preparation', id);
  try {
    // A failed/partial resize must not leave an old successful dataset fingerprint active.
    persist(FILE, null);
    saved = null;
    job = { id, status: 'running', phase: 'starting', startedAt: new Date().toISOString(), finishedAt: null,
      error: null, config, logs: ['Starting fixture preparation on the dedicated benchmark stack.'] };
    persist(JOB_FILE, job);
    prepare(job, config, body.customerPassword ?? '', release).catch(error => {
      console.error('Could not finish fixture preparation:', error.message);
      release();
    });
    return { job };
  } catch (error) { release(); throw error; }
}

module.exports = { getState, start, manifest: () => saved, busy: () => job?.status === 'running' ? job.id : null,
  normalize, fingerprint };
