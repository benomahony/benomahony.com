import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnostics, errorCategory } from '../assets/search-diagnostics.js';

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('unfinished operations are reported after a reload, without claiming a crash', () => {
  const saved = storage();
  const first = createDiagnostics(saved);
  first.begin('model-load');
  const second = createDiagnostics(saved);
  const report = JSON.parse(second.report());
  assert.ok(report.events.some((e) => e.event === 'previous-operation-interrupted' && e.phases[0] === 'model-load'));
  assert.equal(report.active.length, 0);
});

test('normal navigation does not report an interrupted operation', () => {
  const saved = storage();
  const first = createDiagnostics(saved);
  first.begin('model-load');
  first.stop('page-hidden');
  const second = createDiagnostics(saved);
  assert.ok(!JSON.parse(second.report()).events.some((e) => e.event === 'previous-operation-interrupted'));
});

test('logs are bounded and clearable, even when storage is blocked', () => {
  const log = createDiagnostics({ getItem() { throw Error('denied'); }, setItem() { throw Error('quota'); } });
  for (let i = 0; i < 100; i++) log.record('model-ready');
  assert.equal(JSON.parse(log.report()).events.length, 80);
  log.clear();
  assert.equal(JSON.parse(log.report()).events.length, 0);
});

test('error categories do not include raw messages or visitor text', () => {
  assert.equal(errorCategory(Error('GPU allocation failed: private question')), 'memory');
  assert.equal(errorCategory(Error('fetch failed for private URL')), 'network');
  assert.equal(errorCategory(Error('private question')), 'unknown');
});
