import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/search-worker.js', import.meta.url), 'utf8')
  .replace(/import \{[\s\S]*?\} from "[^"]+";/, '');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function worker({ gpuFailure = false } = {}) {
  const messages = [];
  const calls = [];
  let active = 0;
  let peak = 0;
  let release;
  const model = async (inputs) => {
    active++;
    peak = Math.max(peak, active);
    calls.push(inputs);
    try {
      if (inputs?.[0]?.endsWith('slow')) await new Promise((resolve) => { release = resolve; });
      if (gpuFailure) { gpuFailure = false; throw new Error('GPU unavailable'); }
      return { sentence_embedding: { data: new Float32Array([1, 0]) } };
    } finally { active--; }
  };
  model.dispose = async () => { assert.equal(active, 0); calls.push('dispose'); };
  const context = vm.createContext({
    console, performance, Float32Array,
    env: {}, navigator: { gpu: { requestAdapter: async () => ({}) } },
    AutoConfig: { from_pretrained: async () => ({ vision_config: {} }) },
    AutoProcessor: { from_pretrained: async () => (text) => text },
    AutoModel: { from_pretrained: async (_, options) => { calls.push(options.device); return model; } },
    pipeline: async () => { calls.push('whisper'); return async () => ({ text: 'hello' }); },
    self: { postMessage: (message) => messages.push(message) },
  });
  vm.runInContext(source, context);
  return { messages, calls, send: (data) => context.self.onmessage({ data }),
    release: () => release(), peak: () => peak };
}

test('startup leaves Whisper unloaded; first transcription loads it once', async () => {
  const w = worker();
  w.send({ type: 'load' });
  await tick();
  assert.ok(w.messages.some((m) => m.type === 'ready'));
  assert.ok(!w.calls.includes('whisper'));
  w.send({ type: 'transcribe', id: 1, audio: new Float32Array(16) });
  w.send({ type: 'transcribe', id: 2, audio: new Float32Array(16) });
  await tick();
  assert.equal(w.calls.filter((c) => c === 'whisper').length, 1);
  assert.equal(w.messages.filter((m) => m.type === 'transcript').length, 2);
});

test('rapid searches never overlap inference and only the newest waiting query runs', async () => {
  const w = worker();
  w.send({ type: 'load' });
  await tick();
  w.send({ type: 'query', id: 1, query: 'slow' });
  await tick();
  w.send({ type: 'query', id: 2, query: 'obsolete' });
  w.send({ type: 'query', id: 3, query: 'latest' });
  assert.ok(w.messages.some((m) => m.id === 2 && m.vector === null));
  w.release();
  await tick();
  assert.equal(w.peak(), 1);
  assert.ok(!w.calls.some((c) => c?.[0]?.endsWith?.('obsolete')));
  assert.ok(w.messages.some((m) => m.id === 3 && m.vector?.[0] === 1));
});

test('GPU failure disposes the old model before the CPU fallback', async () => {
  const w = worker({ gpuFailure: true });
  w.send({ type: 'load' });
  await tick();
  assert.ok(w.calls.indexOf('dispose') < w.calls.indexOf('wasm'));
  assert.ok(w.messages.some((m) => m.type === 'ready' && m.device === 'wasm'));
  assert.equal(w.peak(), 1);
});

test('page failure terminates the worker and settles outstanding requests', () => {
  const page = readFileSync(new URL('../assets/search.js', import.meta.url), 'utf8');
  const fail = page.slice(page.indexOf('function fail('), page.indexOf('\nfunction start('));
  let terminated = false;
  let vector = 'waiting';
  let transcript = 'waiting';
  const context = vm.createContext({ console, failed: false, ready: true,
    diagnostics: { record() {}, stop() {} }, errorCategory: () => "memory",
    worker: { terminate: () => { terminated = true; } },
    progress: {}, stopListening() {}, showSetting() {}, voice: {},
    pending: new Map([[1, (value) => { vector = value; }]]),
    transcripts: new Map([[1, (value) => { transcript = value; }]]),
    status: {}, input: { value: '' },
  });
  vm.runInContext(fail + '\nfail("out of memory");', context);
  assert.ok(terminated);
  assert.equal(context.worker, undefined);
  assert.equal(context.ready, false);
  assert.equal(vector, null);
  assert.equal(transcript, '');
  assert.equal(context.pending.size, 0);
});
