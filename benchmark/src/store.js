const fs = require('node:fs');
const path = require('node:path');
const { RESULTS_DIR } = require('./config');

// The run and proof history, kept next to the results so it survives a restart of this container.
// The measured numbers themselves live in task3-results/<label>/<case>.json, the same files the CLI writes.
const DIR = path.join(RESULTS_DIR, '.dashboard');
const FILE = path.join(DIR, 'history.json');
const KEEP = 100;

let state = { runs: [], proofs: [] };

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = { runs: Array.isArray(saved.runs) ? saved.runs : [], proofs: Array.isArray(saved.proofs) ? saved.proofs : [] };
  } catch {
    state = { runs: [], proofs: [] };
  }
  // A run that was going when the container stopped did not finish: say so instead of showing it as running forever.
  for (const run of state.runs) {
    if (run.status === 'queued' || run.status === 'running') {
      run.status = 'interrupted';
      run.error = 'The benchmark service stopped during this run.';
      run.current = null;
      for (const step of run.steps) if (!['passed', 'failed', 'skipped'].includes(step.status)) step.status = 'skipped';
    }
  }
  save();
}

let pending = null;
function save() {
  // Several updates in the same second become one write. Written to a temporary file first, so a crash never leaves half a file.
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(state, null, 2));
      fs.renameSync(`${FILE}.tmp`, FILE);
    } catch (error) {
      console.error('Could not save the history:', error.message);
    }
  }, 250);
}

function addRun(run) {
  state.runs.unshift(run);
  state.runs.length = Math.min(state.runs.length, KEEP);
  save();
}

function addProof(proof) {
  state.proofs.unshift(proof);
  state.proofs.length = Math.min(state.proofs.length, KEEP);
  save();
}

const runs = () => state.runs;
const proofs = () => state.proofs;
const findRun = (id) => state.runs.find((run) => run.id === id);

function timelinePath(runId, caseName) {
  return path.join(DIR, 'timelines', runId, `${caseName}.json`);
}

function saveTimeline(runId, caseName, points) {
  try {
    fs.mkdirSync(path.dirname(timelinePath(runId, caseName)), { recursive: true });
    fs.writeFileSync(timelinePath(runId, caseName), JSON.stringify(points));
  } catch (error) {
    console.error('Could not save a timeline:', error.message);
  }
}

function readTimeline(runId, caseName) {
  try {
    return JSON.parse(fs.readFileSync(timelinePath(runId, caseName), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { load, save, addRun, addProof, runs, proofs, findRun, saveTimeline, readTimeline };
