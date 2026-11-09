// Tests for the speech logic in assets/search-voice.js: node --test tests/
import assert from "node:assert/strict";
import { test } from "node:test";

import { addChunk, downsampler, due, joined } from "../assets/search-voice.js";

const RATE = 16000;
const session = () => ({ chunks: [], length: 0, received: 0, embedded: 0 });
const tone = (level, length = 1600) => new Float32Array(length).fill(level);

// Feed `chunk` at each time in `times` (ms), returning addChunk's answers.
function feed(t, s, chunk, times) {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  return times.map((at) => {
    now = at;
    return addChunk(s, chunk);
  });
}

test("downsampling 48 kHz averages each three samples into one", () => {
  const resample = downsampler(48000);
  assert.deepEqual([...resample(Float32Array.from([1, 2, 3, 4, 5, 6]))], [2, 5]);
});

test("a quiet room is not speech, and keeps only a short lead-in", (t) => {
  const s = session();
  feed(t, s, tone(0.001), [0, 100, 200, 300, 400, 500]);
  assert.ok(!s.speaking);
  assert.ok(s.length <= 0.3 * RATE + 1600);
  assert.equal(s.received, 6 * 1600);
});

test("speech well above the room is heard, and a long pause after enough talk ends it", (t) => {
  const s = session();
  const quiet = feed(t, s, tone(0.001), [0]);
  const talking = feed(t, s, tone(0.1), [100, 1100, 2200]);
  assert.ok(s.speaking);
  assert.deepEqual([...quiet, ...talking], [false, false, false, false]);
  // Quiet again: not over until PAUSE_MS has passed since they were last heard.
  s.level = 0.0001;
  assert.deepEqual(feed(t, s, tone(0), [3000, 4800]), [false, true]);
});

test("the first chunk sets the room's level, so it is never heard as speech", (t) => {
  const s = session();
  feed(t, s, tone(0.1), [0]);
  assert.ok(!s.speaking);
});

test("a single short word still ends listening once PAUSE_MS passes", (t) => {
  // Speech can't start after it was last heard, so a PAUSE_MS (2.5 s) pause
  // always covers MIN_TALK_MS (2 s) of talk: the pause alone decides.
  const s = session();
  feed(t, s, tone(0.001), [0]);
  feed(t, s, tone(0.1), [100]);
  s.level = 0.0001;
  assert.deepEqual(feed(t, s, tone(0), [2500, 2700]), [false, true]);
});

test("searching waits for enough speech, then for each further stretch", () => {
  const s = { ...session(), speaking: true, length: RATE, received: RATE };
  assert.ok(!due(s), "under MIN_SPEECH");
  Object.assign(s, { length: 2 * RATE, received: 2 * RATE });
  assert.ok(due(s));
  s.embedded = s.received;
  assert.ok(!due(s), "nothing new");
  s.received += 0.5 * RATE;
  assert.ok(!due(s), "less than UPDATE_EVERY new");
  s.stopped = true;
  assert.ok(due(s), "stopping searches whatever is new");
  s.busy = true;
  assert.ok(!due(s), "busy");
});

test("joined puts the session's chunks into one buffer in order", () => {
  const s = { chunks: [Float32Array.from([1, 2]), Float32Array.from([3])], length: 3 };
  assert.deepEqual([...joined(s)], [1, 2, 3]);
});
