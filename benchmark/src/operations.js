const { Problem } = require('./problem');

// Loading and modifying a fixture at the same time invalidates the measurement.
// Reserve synchronously, before any asynchronous preflight checks can overlap.
let current = null;
function acquire(kind, id) {
  if (current) {
    throw new Problem(409, 'Another test operation is running.',
      `Wait for the ${current.kind} operation to finish before starting another.`, { operation: current });
  }
  const reservation = { kind, id };
  current = reservation;
  return () => { if (current === reservation) current = null; };
}
module.exports = { acquire, busy: () => current };
