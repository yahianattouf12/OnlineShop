const shop = require('./shop');

let previous = null;
let inflight = null;
let cached = null;
const notes = [
  'CPU and memory measure the shop API process, not the entire laptop or load generator. CPU 100% means one logical core.',
  'Database counters cover all activity in the application database, including monitoring. They are not individual query timings.',
  'PostgreSQL counters can update with a short delay. Cache hit rate refers to PostgreSQL shared buffers, not Redis.',
];

function calculate(raw, before) {
  const sampledAt = raw.sampledAt ?? new Date().toISOString();
  const seconds = before ? (Date.parse(sampledAt) - Date.parse(before.sampledAt)) / 1000 : 0;
  const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const sameProcess = before?.api?.processId === raw.api?.processId && before?.api?.startedAt === raw.api?.startedAt;
  const cpuDelta = (raw.api?.cpuTotalMs ?? 0) - (before?.api?.cpuTotalMs ?? 0);
  const cpuPercent = sameProcess && seconds > 0 && cpuDelta >= 0 ? cpuDelta / (seconds * 10) : null;
  const db = raw.database;
  const sameDatabase = before?.database?.available && db?.available && before.database.statsReset === db.statsReset && before.database.name === db.name;
  const delta = key => sameDatabase && finite(db[key]) && finite(before.database[key]) && db[key] >= before.database[key]
    ? db[key] - before.database[key] : null;
  const commits = delta('commits'), rollbacks = delta('rollbacks'), hits = delta('blocksHit'), reads = delta('blocksRead');
  return {
    sampledAt,
    api: { ...raw.api, available: finite(raw.api?.memoryBytes), cpuPercent: finite(cpuPercent) ? cpuPercent : null,
      memoryBytes: finite(raw.api?.memoryBytes) ? raw.api.memoryBytes : null },
    database: { ...(db ?? {}), available: db?.available === true,
      transactionsPerSecond: seconds > 0 && commits !== null && rollbacks !== null ? (commits + rollbacks) / seconds : null,
      cacheHitRate: hits !== null && reads !== null && hits + reads > 0 ? hits / (hits + reads) : null,
      activeConnections: finite(db?.activeConnections) ? db.activeConnections : null },
    notes,
  };
}

async function sample(session) {
  if (cached && Date.now() - cached.at < 900) return cached.value;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await shop.call('/benchmark/telemetry', { token: session.token });
      if (response.status !== 200 || !response.json?.api) throw new Error('unavailable');
      const value = calculate(response.json, previous);
      previous = response.json;
      cached = { at: Date.now(), value };
      return value;
    } catch {
      previous = null;
      const value = { sampledAt: new Date().toISOString(), api: { available: false, cpuPercent: null, memoryBytes: null },
        database: { available: false, transactionsPerSecond: null, cacheHitRate: null, activeConnections: null },
        notes: ['Monitoring is unavailable. Rebuild the app in the onlineshop-bench project to enable its admin-only telemetry endpoint.', ...notes] };
      cached = { at: Date.now(), value };
      return value;
    } finally { inflight = null; }
  })();
  return inflight;
}

// A measurement must not include CPU time accumulated while the system was idle or warming up.
async function reset() {
  if (inflight) await inflight;
  previous = null;
  cached = null;
}
module.exports = { sample, calculate, reset };
