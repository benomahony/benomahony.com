// Tests for assets/search-rank.js: node --test tests/
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  arrange,
  bm25,
  clock,
  decodeIndex,
  keywordRank,
  LIMIT,
  namedVideo,
  passage,
  rank,
  tokens,
  transcriptOf,
} from "../assets/search-rank.js";

const episode = (video, start, text, title = `Video ${video}`) => ({
  kind: "episode",
  title,
  url: `https://www.youtube.com/watch?v=${video}&t=${start}s`,
  text,
  mean: 0,
  std: 0.1,
});
const post = (url, title, text) => ({ kind: "post", title, url, section: null, text, mean: 0, std: 0.1 });

// Two-dimensional vectors: x means "zig", y means "evals".
function indexOf(items, vectors) {
  const bytes = Int8Array.from(vectors.flat());
  const raw = {
    dims: 2,
    items,
    scales: items.map(() => 1 / 100),
    vectors: btoa(String.fromCharCode(...new Uint8Array(bytes.buffer))),
  };
  return decodeIndex(raw);
}

const items = [
  post("/blog/zig/", "Writing Zig", "Comptime makes Zig generic code simple."),
  post("/blog/evals/", "Eval driven development", "Write the evals before the agent."),
  episode("aaa", 0, "Today we talk about zig"),
  episode("aaa", 30, "and comptime in zig"),
  episode("aaa", 60, "then something else entirely"),
  episode("bbb", 0, "evals for agents", "This Week in AI | Evals"),
];
const vectors = [
  [100, 0],
  [0, 100],
  [100, 0],
  [100, 0],
  [0, 100],
  [0, 100],
];
const index = indexOf(items, vectors);

test("clock formats minutes and hours", () => {
  assert.equal(clock(5), "0:05");
  assert.equal(clock(125), "2:05");
  assert.equal(clock(3725), "1:02:05");
});

test("tokens lowercase and drop stop words and single letters", () => {
  assert.deepEqual(tokens("How to write a Zig CLI, in 2 steps"), ["write", "zig", "cli", "steps"]);
});

test("an episode window's transcript runs on into the next window of the same video", () => {
  assert.equal(transcriptOf(index, 2), "Today we talk about zig and comptime in zig");
  assert.equal(transcriptOf(index, 5), "evals for agents");
  assert.equal(passage(index, { ...items[0], at: 0 }), items[0].text);
});

test("keyword search matches an unfinished last word and returns one result per video", () => {
  const keywords = bm25(index);
  const hits = keywordRank(keywords, "comp");
  // The 30 s window's minute is shorter and still says "comptime", so it is
  // the video's best match; the 0 s window is left out as the same video.
  assert.deepEqual(new Set(hits.map((hit) => hit.url)), new Set(["/blog/zig/", "https://www.youtube.com/watch?v=aaa&t=30s"]));
  assert.equal(hits.find((hit) => hit.video === "aaa").section, "0:30 – 1:30");
  assert.deepEqual(keywordRank(keywords, "the and"), []);
});

test("typed meaning search grows a video's best window across matching neighbours", () => {
  const hits = rank(index, [1, 0]);
  const zig = hits.find((hit) => hit.video === "aaa");
  assert.equal(zig.start, 0);
  assert.equal(zig.end, 90);
  assert.equal(zig.section, "0:00 – 1:30");
  assert.ok(hits.every((hit) => hit.score >= 1.5));
  assert.ok(!hits.some((hit) => hit.video === "bbb"));
});

test("spoken search keeps every result and smooths scores across updates", () => {
  const smoothed = new Float32Array(items.length).fill(Number.NaN);
  rank(index, [1, 0], { spoken: true, smoothed });
  assert.equal(smoothed[0], 1);
  const hits = rank(index, [0, 1], { spoken: true, smoothed });
  assert.ok(Math.abs(smoothed[0] - 0.6) < 1e-6);
  assert.ok(hits.some((hit) => hit.video === "bbb"));
});

test("arrange caps articles, fills up to LIMIT and puts the stronger group first", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ kind: "post", url: `/p${i}`, score: 10 - i }));
  const vids = Array.from({ length: 10 }, (_, i) => ({ kind: "episode", video: `v${i}`, score: 20 - i }));
  const out = arrange([...many, ...vids]);
  assert.equal(out.length, LIMIT);
  assert.equal(out.filter((hit) => hit.kind === "post").length, 3);
  assert.equal(out[0].kind, "episode");
});

test("a spoken video name finds that video's first window", () => {
  assert.equal(namedVideo(index, "play this week in ai evals"), 5);
  assert.equal(namedVideo(index, "something unrelated about cooking"), null);
});
