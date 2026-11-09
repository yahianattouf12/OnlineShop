import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cases = ['orders-first', 'orders-deep', 'orders-customer', 'product-hot', 'product-etag'];
const [label, ...args] = process.argv.slice(2);
const requireETag = args.includes('--etag');
const selected = args.filter((arg) => arg !== '--etag');
const workloads = selected.length ? [...new Set(selected)] : cases;
const api = 'http://localhost:8080/api/v1';

function command(executable, args, env = process.env) {
  return spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

async function get(path, headers = {}) {
  const response = await fetch(api + path, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (response.status !== 200) throw new Error(path + ' returned HTTP ' + response.status + '.');
  return response;
}

function runK6(caseName, folder, extra, duration, warmup) {
  const summary = join(folder, caseName + '.json');
  const partialSummary = summary + '.' + process.pid + '.partial';
  const log = join(folder, caseName + (warmup ? '-warmup.txt' : '.txt'));
  console.log('Running ' + caseName + ' (' + duration + (warmup ? ' warm-up' : ' measured') + ')');
  const result = command('k6', [
    'run', '--quiet', '--no-color', '--new-machine-readable-summary=false', 'api-tests/task3/benchmark.js',
  ], {
    ...process.env, ...extra, TASK3_CASE: caseName, TASK3_DURATION: duration,
    TASK3_SUMMARY_FILE: warmup ? '' : partialSummary,
  });
  if (result.error) throw result.error;
  writeFileSync(log, result.stdout + '\n' + result.stderr);
  if (result.status !== 0 || (!warmup && !existsSync(partialSummary))) {
    throw new Error('The run failed. See ' + log + '.');
  }
  if (!warmup) {
    renameSync(partialSummary, summary);
    console.log('Saved ' + log);
  }
}

async function main() {
  if (!label || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(label) ||
      workloads.some((item) => !cases.includes(item)) ||
      (requireETag && !workloads.includes('product-etag'))) {
    throw new Error('Usage: node api-tests/task3/run.mjs <label> [case ...] [--etag]\nCases: ' + cases.join(', '));
  }

  const folder = join(root, 'task3-results', label);
  for (const caseName of workloads) {
    if (existsSync(join(folder, caseName + '.json'))) {
      throw new Error('A result already exists for ' + label + '/' + caseName + '. Choose a new label to keep it.');
    }
  }

  const binding = command('docker', ['compose', '-p', 'onlineshop-bench', 'port', 'app', '8080']);
  if (binding.error) throw binding.error;
  if (binding.status !== 0 || !/:8080\s*$/.test(binding.stdout)) {
    throw new Error('Start the onlineshop-bench API on port 8080 before running this benchmark.');
  }

  const productId = process.env.PRODUCT_ID?.trim().toLowerCase();
  if (workloads.some((item) => item.startsWith('product-')) &&
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(productId ?? '')) {
    throw new Error('Set PRODUCT_ID to the UUID printed by the benchmark seeder.');
  }

  const extra = {
    PRODUCT_ID: productId ?? '',
    TASK3_CUSTOMER_ID: '',
    TASK3_ETAG_VALUE: '',
    TASK3_ETAG_REQUIRED: '0',
  };
  if (workloads.some((item) => item === 'orders-first' || item === 'orders-deep') && !process.env.ORDERS_TOKEN?.trim()) {
    throw new Error('Set ORDERS_TOKEN to the admin accessToken before running an admin case.');
  }
  if (workloads.includes('orders-customer')) {
    const token = process.env.CUSTOMER_TOKEN?.trim();
    if (!token) throw new Error('Set CUSTOMER_TOKEN to the benchmark customer accessToken.');
    const user = await (await get('/auth/me', { Authorization: 'Bearer ' + token })).json();
    if (user.role !== 'Customer' || user.email !== 'benchmark-customer@example.invalid' || !user.id) {
      throw new Error('CUSTOMER_TOKEN must belong to the seeded benchmark customer.');
    }
    extra.TASK3_CUSTOMER_ID = user.id;
  }
  if (requireETag) {
    const response = await get('/products/' + productId);
    const tag = response.headers.get('etag');
    if (!tag) throw new Error('The product API did not return an ETag. Run --etag after implementing it.');
    extra.TASK3_ETAG_VALUE = tag;
  }

  mkdirSync(folder, { recursive: true });
  for (const caseName of workloads) {
    const env = { ...extra, TASK3_ETAG_REQUIRED: requireETag && caseName === 'product-etag' ? '1' : '0' };
    runK6(caseName, folder, env, '15s', true);
    runK6(caseName, folder, env, '60s', false);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
