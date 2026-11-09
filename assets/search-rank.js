// Ranking for site search: by meaning (cosine against the index's vectors)
// and by keywords (BM25), combined into the list of results. Nothing here
// touches the page, so it runs under Node for tests/search_rank.test.mjs.

import { namer } from "./search-names.js";

export const LIMIT = 8;
// Articles get at most this many of the LIMIT places, so a strong video
// match can't push them out entirely and they can't crowd out videos.
const ARTICLES = 3;
// Calibrated scores below this are noise: off-topic queries score around -2,
// real hits in testing scored 2 to 6.
const MIN_SCORE = 1.5;

export function decodeIndex(raw) {
  const bytes = Uint8Array.from(atob(raw.vectors), (c) => c.charCodeAt(0));
  return { ...raw, vectors: new Int8Array(bytes.buffer) };
}

// --- Ranking by meaning ----------------------------------------------------

// Episode windows are one minute long and start every HOP seconds
// (see scripts/search/index.py).
const WINDOW = 60;
const HOP = 30;

export function clock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// Each episode window stores the transcript of its first HOP seconds (see
// scripts/search/index.py), so its full minute is its own text plus the
// next window's.
export function transcriptOf(index, at) {
  const { items } = index;
  const item = items[at];
  const next = items[at + 1];
  const follows =
    next?.kind === "episode" &&
    videoOf(next).video === videoOf(item).video &&
    videoOf(next).start === videoOf(item).start + HOP;
  return follows ? `${item.text} ${next.text}` : item.text;
}

export function videoOf(item) {
  const [, video, start] = item.url.match(/v=([\w-]+)&t=(\d+)/) ?? [];
  return { video, start: Number(start) };
}

// Calibration was measured with typed queries and halves accuracy for spoken
// ones, so spoken queries rank by plain cosine and skip the noise cut-off.
// Live voice passes `smoothed`, a running average of each passage's cosine
// across updates, so results only move when they're consistently better.
const SMOOTHING = 0.4; // Weight of the newest update.

export function rank(index, query, { spoken = false, smoothed } = {}) {
  const { dims, vectors, scales, items } = index;
  // Truncate the query to the index's Matryoshka size and renormalise.
  const head = query.slice(0, dims);
  const norm = Math.hypot(...head);
  // Rank by how unusually well each passage matches (see calibrate() in
  // scripts/search/index.py), so silence and audio-vs-text scale don't win.
  const scored = items.map((item, i) => {
    let dot = 0;
    const offset = i * dims;
    for (let d = 0; d < dims; d++) dot += head[d] * vectors[offset + d];
    let cosine = (dot * scales[i]) / norm;
    if (smoothed) {
      const previous = smoothed[i];
      if (!Number.isNaN(previous)) cosine = previous + SMOOTHING * (cosine - previous);
      smoothed[i] = cosine;
    }
    return {
      ...item,
      ...videoOf(item),
      at: i,
      score: spoken ? cosine : (cosine - item.mean) / item.std,
    };
  });

  const floor = spoken ? -Infinity : MIN_SCORE;
  const hits = scored.filter((item) => item.kind === "post" && item.score >= floor);

  // For each episode, grow its best window into the run of neighbouring
  // windows that also match, so a result covers the whole stretch of talk.
  const episodes = Map.groupBy(
    scored.filter((item) => item.kind === "episode"),
    (item) => item.video,
  );
  for (const windows of episodes.values()) {
    const best = windows.reduce((a, b) => (b.score > a.score ? b : a));
    if (best.score < floor) continue;
    let from = best.start;
    let to = best.start;
    if (!spoken) {
      const byStart = new Map(windows.map((w) => [w.start, w]));
      while (byStart.get(from - HOP)?.score >= MIN_SCORE) from -= HOP;
      while (byStart.get(to + HOP)?.score >= MIN_SCORE) to += HOP;
    }
    hits.push({
      ...best,
      start: from,
      end: to + WINDOW,
      section: `${clock(from)} – ${clock(to + WINDOW)}`,
    });
  }

  return hits.sort((a, b) => b.score - a.score);
}

// --- Keyword ranking (BM25) ------------------------------------------------

// Each post section is a document, as is each minute of each video, by its
// title and transcript, so keywords find the moment something was said.
const STOP = new Set(
  "a an and are as at be but by for from has have how i in is it its of on or that the this to was what when where which who why will with you your".split(
    " ",
  ),
);
const K1 = 1.2;
const B = 0.75;

export function tokens(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => token.length > 1 && !STOP.has(token),
  );
}

export function bm25(index) {
  const docs = index.items.map((item, at) => {
    if (item.kind === "post") {
      // Titles count twice, so naming a post finds it.
      return {
        item,
        terms: tokens(`${item.title} ${item.title} ${item.section ?? ""} ${item.text}`),
      };
    }
    const { video, start } = videoOf(item);
    return {
      item: {
        ...item,
        video,
        start,
        at,
        end: start + WINDOW,
        section: `${clock(start)} – ${clock(start + WINDOW)}`,
      },
      terms: tokens(`${item.title} ${transcriptOf(index, at)}`),
    };
  });
  const df = new Map();
  for (const doc of docs) {
    doc.counts = new Map();
    for (const term of doc.terms) doc.counts.set(term, (doc.counts.get(term) ?? 0) + 1);
    for (const term of doc.counts.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const avgLength = docs.reduce((sum, doc) => sum + doc.terms.length, 0) / docs.length;
  return { docs, df, avgLength };
}

export function keywordRank(keywords, query) {
  const { docs, df, avgLength } = keywords;
  const words = tokens(query);
  if (!words.length) return [];
  // While typing, the last word may be unfinished, so it also matches the
  // longer words it starts.
  const last = words.at(-1);
  const terms = words.slice(0, -1).map((word) => [word]);
  terms.push([...df.keys()].filter((term) => term.startsWith(last)).slice(0, 20));

  const idf = (term) => Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
  const videos = new Set();
  return (
    docs
      .map((doc) => {
        let score = 0;
        let matched = 0;
        for (const options of terms) {
          // Only the best-scoring expansion of each word counts.
          let best = 0;
          for (const term of options) {
            const tf = doc.counts.get(term);
            if (!tf) continue;
            const norm = tf + K1 * (1 - B + (B * doc.terms.length) / avgLength);
            best = Math.max(best, (idf(term) * tf * (K1 + 1)) / norm);
          }
          score += best;
          if (best) matched++;
        }
        return { ...doc.item, score, matched: matched / terms.length };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      // One result per video: its best-matching minute.
      .filter((hit) => hit.kind === "post" || (!videos.has(hit.video) && videos.add(hit.video)))
  );
}

// --- Combining rankings ----------------------------------------------------

// Typed searches fuse the meaning and keyword rankings (reciprocal rank
// fusion), separately for articles and videos: meaning finds paraphrases,
// keywords find exact names and titles. A keyword-only match must contain at
// least half the query's words, so off-topic queries still find nothing.
const FUSION_K = 60;

function fuse(meaning, words) {
  const relevant = words.filter((hit) => hit.matched >= 0.5);
  const fused = new Map();
  for (const list of [meaning, relevant]) {
    list.forEach((hit, i) => {
      const key = hit.kind === "post" ? hit.url : hit.video;
      // Keep the meaning hit's version (its matched stretch) when both have it.
      const entry = fused.get(key) ?? { hit, score: 0 };
      entry.score += 1 / (FUSION_K + i + 1);
      fused.set(key, entry);
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ hit, score }) => ({ ...hit, score }));
}

// Group results into articles and videos, the stronger group first.
export function arrange(hits, words = null) {
  const kind = (k, list) => list.filter((hit) => hit.kind === k);
  let posts = kind("post", hits);
  let videos = kind("episode", hits);
  if (words) {
    posts = fuse(posts, kind("post", words));
    videos = fuse(videos, kind("episode", words));
  }
  posts = posts.slice(0, ARTICLES);
  videos = videos.slice(0, LIMIT - posts.length);
  return (posts[0]?.score ?? -Infinity) >= (videos[0]?.score ?? -Infinity)
    ? [...posts, ...videos]
    : [...videos, ...posts];
}

// The words a result shows a snippet from.
export function passage(index, hit) {
  return hit.kind === "episode" ? transcriptOf(index, hit.at) : hit.text;
}

// --- Naming a video out loud --------------------------------------------------

// Embeddings can't tell asking for a video by name from asking about its topic
// (eval.py names), so Whisper transcribes the finished question and
// search-names.js checks it against the video titles. Each video's first
// window, by index, with the namer for their titles.
const named = new WeakMap();

export function namedVideo(index, text) {
  if (!named.has(index)) {
    const first = new Map();
    index.items.forEach((item, at) => {
      if (item.kind === "episode" && !first.has(videoOf(item).video))
        first.set(videoOf(item).video, at);
    });
    const videos = [...first.values()];
    named.set(index, { videos, named: namer(videos.map((at) => index.items[at].title)) });
  }
  const { videos, named: name } = named.get(index);
  const which = name(text);
  return which === null ? null : videos[which];
}
