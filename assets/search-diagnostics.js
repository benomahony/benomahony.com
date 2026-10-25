// Per-tab diagnostics survive reloads. Never store queries, audio, transcripts,
// URLs, or raw exception messages; those can contain visitor content.
const KEY = 'ai-search-diagnostics-v1';
const LIMIT = 80;

export function createDiagnostics(storage, environment = {}) {
  let previous;
  try { previous = JSON.parse(storage?.getItem(KEY) ?? 'null'); } catch {}
  const events = Array.isArray(previous?.events) ? previous.events.slice(-LIMIT) : [];
  const active = new Map();
  let sequence = 0;
  function save() {
    try {
      storage?.setItem(KEY, JSON.stringify({ events, active: [...active.values()] }));
    } catch {} // Disabled storage or quota exhaustion must never break search.
  }
  function record(event, details = {}) {
    events.push({ at: new Date().toISOString(), event, ...details });
    if (events.length > LIMIT) events.shift();
    save();
  }
  if (previous?.active?.length) {
    record('previous-operation-interrupted', {
      phases: previous.active.map(({ phase }) => phase),
    });
  }
  record('page-start');
  return {
    record,
    begin(phase) {
      const id = ++sequence;
      active.set(id, { phase, started: Date.now() });
      record('operation-start', { phase });
      return id;
    },
    end(id, outcome = 'complete') {
      const operation = active.get(id);
      if (!operation) return;
      active.delete(id);
      record('operation-end', {
        phase: operation.phase, outcome, durationMs: Date.now() - operation.started,
      });
    },
    stop(reason) {
      for (const id of active.keys()) this.end(id, reason);
      record(reason);
    },
    report() {
      return JSON.stringify({ version: 1, environment, events, active: [...active.values()] }, null, 2);
    },
    clear() {
      events.length = 0;
      save(); // Preserve active work so clearing a log cannot hide an interruption.
    },
  };
}

export function errorCategory(error) {
  const message = String(error?.message ?? error).toLowerCase();
  if (/memory|allocation|out of bounds|oom/.test(message)) return 'memory';
  if (/gpu|device lost/.test(message)) return 'gpu';
  if (/fetch|network|download/.test(message)) return 'network';
  if (/support|notallowed|permission/.test(message)) return 'capability-or-permission';
  return 'unknown';
}
