const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { API, RESULTS_DIR, TASK3_DIR } = require('./config');
const store = require('./store');
const shop = require('./shop');
const runner = require('./runner');
const { benchmarkProductId } = require('./preflight');
const { Problem } = require('./problem');

const VERIFY = path.join(TASK3_DIR, 'verify.mjs');

const PROOFS = {
  'etag-stock': {
    title: 'A stock change shows up at once, even with the old ETag',
    changesData: false,
  },
  'read-after-write': {
    title: 'A new order is visible at once to the customer who placed it',
    changesData: true,
  },
};

let running = false;

/** Runs api-tests/task3/verify.mjs, the same proof the team runs from the terminal, against the benchmark API. */
async function run(session, mode, body = {}) {
  const proof = PROOFS[mode];
  if (!proof) throw new Problem(404, 'Unknown proof.', `Use one of: ${Object.keys(PROOFS).join(', ')}.`);
  if (runner.busy()) throw new Problem(409, 'A benchmark run is going.', 'A proof changes data the run is measuring. Wait for the run to finish.');
  if (running) throw new Problem(409, 'A proof is already running.', 'Wait for it to finish.');
  if (proof.changesData && body.acceptDatasetChange !== true) {
    throw new Problem(400, 'Confirm the data change first.',
      'This proof places a real order: the shop gets one more order and the product one unit less, so the timed order and product workloads stop matching their fixtures. Run it after your last timed run, and send acceptDatasetChange: true.',
      { field: 'acceptDatasetChange' });
  }

  const productId = await benchmarkProductId(body.productId);
  if (!productId) throw new Problem(409, 'The benchmark product was not found.', 'Run the benchmark seeder first.');

  const env = { PATH: process.env.PATH, PRODUCT_ID: productId, TASK3_API_URL: API, ORDERS_TOKEN: session.token, CUSTOMER_TOKEN: '' };
  if (mode === 'read-after-write') env.CUSTOMER_TOKEN = (await shop.customerSession(body.customerPassword)).token;

  running = true;
  const startedAt = Date.now();
  try {
    const { code, output } = await new Promise((resolve) => {
      let text = '';
      const child = spawn(process.execPath, [VERIFY, mode], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
      child.stdout.on('data', (chunk) => (text += chunk));
      child.stderr.on('data', (chunk) => (text += chunk));
      child.on('error', (error) => resolve({ code: -1, output: `${text}\n${error.message}` }));
      child.on('close', (exitCode) => resolve({ code: exitCode ?? -1, output: text }));
    });

    const result = {
      id: crypto.randomUUID(),
      mode,
      title: proof.title,
      passed: code === 0,
      output: output.trim(),
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      startedBy: session.user.email,
    };
    store.addProof(result);
    try {
      fs.mkdirSync(path.join(RESULTS_DIR, 'proofs'), { recursive: true });
      fs.writeFileSync(path.join(RESULTS_DIR, 'proofs', `${mode}-${result.startedAt.replace(/[:.]/g, '-')}.txt`), `${result.output}\n`);
    } catch (error) {
      console.error('Could not save the proof output:', error.message);
    }
    console.log(`Proof ${mode} ${result.passed ? 'passed' : 'failed'} (${session.user.email})`);
    return result;
  } finally {
    running = false;
  }
}

module.exports = { run, PROOFS };
