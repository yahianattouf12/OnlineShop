const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { RESULTS_DIR } = require('./config');
const { Problem } = require('./problem');
const { redact } = require('./lab-model');
const ROOT = path.join(RESULTS_DIR, '.lab');
const RUNS = path.join(ROOT, 'runs');
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
let initialized = false;
function directory(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const info = fs.lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The result directory is not a regular directory.');
}
function atomic(file, value) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Unsafe result path.');
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(redact(value)), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, file);
}
function read(file, fallback = null) {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return fallback; }
}
function runPath(id, suffix = '.json') {
  if (typeof id !== 'string' || !UUID.test(id)) throw new Problem(404, 'Run not found.', 'Choose a saved run.');
  return path.join(RUNS, id + suffix);
}
function initialize() {
  if (initialized) return;
  directory(ROOT); directory(RUNS);
  for (const file of fs.readdirSync(RUNS)) {
    if (!file.endsWith('.json') || !UUID.test(file.slice(0, -5))) continue;
    const run = read(path.join(RUNS, file));
    if (run?.status === 'running') {
      run.status = 'interrupted'; run.current = null;
      run.error = 'The service stopped before this run finished.';
      run.finishedAt = new Date().toISOString();
      atomic(path.join(RUNS, file), run);
    }
  }
  initialized = true;
}
function scenarios(value) {
  initialize();
  const file = path.join(ROOT, 'scenarios.json');
  if (value) atomic(file, value);
  const saved = read(file, []);
  return Array.isArray(saved) ? saved : [];
}
function allRuns() {
  initialize();
  return fs.readdirSync(RUNS).filter(file => file.endsWith('.json') && UUID.test(file.slice(0, -5)))
    .map(file => read(path.join(RUNS, file))).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function get(id) {
  initialize(); const run = read(runPath(id));
  if (!run) throw new Problem(404, 'Run not found.', 'This run is not in the saved results folder.');
  return run;
}
function save(state) {
  atomic(runPath(state.run.id), state.run);
  atomic(runPath(state.run.id, '.index.json'), state.offsets);
}
function openRequests(id) { return fs.openSync(runPath(id, '.requests.jsonl'), 'wx', 0o600); }
function append(state, event) {
  if (state.run.requestCount % 100 === 0) state.offsets.push(state.offset);
  state.offset += fs.writeSync(state.fd, JSON.stringify(redact({ ...event, sequence: ++state.run.requestCount })) + '\n');
}
async function page(run, query = {}, liveOffsets) {
  const page = query.page == null ? 1 : Number(query.page), pageSize = query.pageSize == null ? 25 : Number(query.pageSize);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Problem(400, 'Check the page.', 'Use page 1 or higher and a page size from 1 to 100.');
  }
  const start = (page - 1) * pageSize, output = { page, pageSize, total: run.requestCount, items: [] };
  if (start >= run.requestCount) return output;
  const offsets = liveOffsets ?? read(runPath(run.id, '.index.json'), []);
  const block = Math.floor(start / 100), offset = offsets[block];
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Problem(409, 'Inspection is incomplete.', 'The request file index is missing.');
  const file = runPath(run.id, '.requests.jsonl'), info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Problem(404, 'Inspection is unavailable.', 'The request file is missing.');
  const input = fs.createReadStream(file, { start: offset });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  let index = block * 100;
  try {
    for await (const line of reader) {
      if (index++ < start) continue;
      try { output.items.push(JSON.parse(line)); } catch { break; }
      if (output.items.length >= pageSize) break;
    }
  } finally { reader.close(); input.destroy(); }
  return output;
}
module.exports = { initialize, scenarios, allRuns, get, save, openRequests, append, page, read };
