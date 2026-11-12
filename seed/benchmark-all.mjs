import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = 'onlineshop-bench';
const projectDir = fileURLToPath(new URL('../', import.meta.url));
const ordersSeed = fileURLToPath(new URL('./benchmark-orders.mjs', import.meta.url));
const orderCount = Number(process.argv[2] ?? 100);

function run(command, args, stdio = 'inherit') {
  const result = spawnSync(command, args, { cwd: projectDir, encoding: 'utf8', stdio });
  if (result.error) throw result.error;
  return result;
}

function compose(args, stdio) {
  return run('docker', ['compose', '-p', project, ...args], stdio);
}

try {
  if (process.argv.length > 3 || !Number.isInteger(orderCount) || orderCount < 100 || orderCount > 200000) {
    throw new Error('Usage: node seed/benchmark-all.mjs [order count from 100 to 200000]');
  }

  for (const [service, port] of [['app', '8080'], ['inventory', '50051']]) {
    const result = compose(['port', service, port], ['ignore', 'pipe', 'inherit']);
    if (result.status !== 0 || !/:\d+\s*$/.test(result.stdout ?? '')) {
      throw new Error(`Start the benchmark API and inventory: docker compose -p ${project} up -d --build app inventory`);
    }
  }

  const catalog = compose(['--profile', 'seed', 'run', '--rm', '--no-deps', '-e', 'BENCHMARK_STOCK=100', 'seed']);
  if (catalog.status !== 0) throw new Error('The benchmark catalog seed failed.');

  const orders = run(process.execPath, [ordersSeed, String(orderCount)]);
  if (orders.status !== 0) throw new Error('The benchmark order seed failed.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
