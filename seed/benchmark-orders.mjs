import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const project = 'onlineshop-bench';
const projectDir = fileURLToPath(new URL('../', import.meta.url));
const email = 'benchmark-customer@example.invalid';
const orderCount = Number(process.argv[2] ?? 100);

function compose(args, options = {}) {
  const result = spawnSync('docker', ['compose', '-p', project, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    ...options,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Docker Compose command failed: ${args[0]}. Check that ${project} is running.`);
  }
  return result.stdout;
}

async function main() {
  if (!Number.isInteger(orderCount) || orderCount < 100 || orderCount > 200000) {
    throw new Error('Order count must be an integer from 100 to 200000.');
  }

  const sql = readFileSync(new URL('./benchmark-orders.sql', import.meta.url), 'utf8');
  const publishedPort = compose(['port', 'app', '8080'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = publishedPort.match(/:(\d+)\s*$/)?.[1];
  if (!port) throw new Error(`Start the API with docker compose -p ${project} up -d --build app.`);

  const password = randomBytes(18).toString('base64url');
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(10000),
  });

  if (response.status === 201) {
    console.log(`Created benchmark customer ${email}`);
    console.log(`Save this local test password for Swagger and k6: ${password}`);
  } else if (response.status === 409) {
    console.log(`Reusing ${email} with its existing password.`);
  } else {
    throw new Error(`Benchmark customer registration returned HTTP ${response.status}. Check the API in Swagger.`);
  }

  compose([
    'exec', '-T', 'app-db', 'psql', '-X', '-U', 'admin', '-d', 'db_online_shop',
    '-v', `order_count=${orderCount}`, '-f', '-',
  ], { input: sql, stdio: ['pipe', 'inherit', 'inherit'] });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
