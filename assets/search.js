// Live, in-browser semantic search over posts and video audio (spike).
//
// Typing finds keyword (BM25) matches straight away. Once the visitor turns
// on AI features with the switch beside the box, EmbeddingGemma 2 runs on
// their device and matches by meaning, from typed text or live from the
// microphone, falling back to keywords when nothing is close. From then on,
// focusing the box starts the model from the browser cache.

import { namer } from "./search-names.js";

const root = document.querySelector(".site-search");
const input = root.querySelector("input");
const mic = root.querySelector(".site-search-mic");
const panel = root.querySelector(".site-search-panel");
const about = root.querySelector(".site-search-about");
const toggle = root.querySelector(".site-search-switch input");
const explain = root.querySelector(".site-search-explain");
const [confirmOn, notNow] = explain.querySelectorAll(".site-search-explain-actions button");
const remove = root.querySelector(".site-search-remove");
const [deleteModel, keepModel] = remove.querySelectorAll("button");
const status = root.querySelector(".site-search-status");
const progress = root.querySelector(".site-search-progress");
const results = root.querySelector(".site-search-results");

const LIMIT = 8;
// Articles get at most this many of the LIMIT places, so a strong video
// match can't push them out entirely and they can't crowd out videos.
const ARTICLES = 3;
const DEBOUNCE_MS = 120;
// Calibrated scores below this are noise: off-topic queries score around -2,
// real hits in testing scored 2 to 6.
const MIN_SCORE = 1.5;

let worker;
let index;
let indexing;
let keywords;
let ready = false;
// Set when the model can't run here at all; search stays on keywords.
let failed = false;
let latest = 0;
let timer;
const pending = new Map();

// "AI features" is the visitor's switch for downloading and running the
// model. It's remembered per browser.
const SETTING = "ai-features";

function enabled() {
  try {
    return localStorage.getItem(SETTING) === "on";
  } catch {
    return false;
  }
}

function remember(on) {
  try {
    if (on) localStorage.setItem(SETTING, "on");
    else localStorage.removeItem(SETTING);
  } catch {}
}

// Voice search only appears once AI features are on.
function showSetting() {
  const on = enabled();
  toggle.checked = on;
  about.hidden = on;
  mic.hidden = !on || failed || !canListen;
}

function decodeIndex(raw) {
  const bytes = Uint8Array.from(atob(raw.vectors), (c) => c.charCodeAt(0));
  return { ...raw, vectors: new Int8Array(bytes.buffer) };
}

// The index holds the text for keyword search as well as the vectors, so it
// loads as soon as someone opens search, before they opt in to the model.
function loadIndex() {
  indexing ??= fetch(root.dataset.index)
    .then((response) => response.json())
    .then((raw) => {
      index = decodeIndex(raw);
      keywords = bm25(index.items);
    });
  return indexing;
}

// --- Download progress -----------------------------------------------------

// The small config and tokenizer files finish first, so the combined total
// only means something once the model weights (well over this size) start.
const WEIGHTS_STARTED = 50e6;
let downloaded = 0;
let speed = 0;
let lastSample;
let lastText = 0;
// Already downloaded, so progress is just reading the browser cache.
let fromCache = false;

function showProgress({ loaded, total }) {
  const now = performance.now();
  if (lastSample && now > lastSample.at) {
    const instant = ((loaded - lastSample.loaded) * 1000) / (now - lastSample.at);
    speed = speed ? speed * 0.8 + instant * 0.2 : instant;
  }
  lastSample = { loaded, at: now };

  progress.hidden = false;
  if (total >= WEIGHTS_STARTED) downloaded = Math.max(downloaded, loaded / total);
  progress.firstElementChild.style.transform = `scaleX(${downloaded})`;

  if (loaded >= total && total >= WEIGHTS_STARTED) {
    status.textContent = "Starting EmbeddingGemma 2…";
    return;
  }
  if (fromCache) {
    status.textContent = "Loading EmbeddingGemma 2 from this device…";
    return;
  }
  // Text changes twice a second at most, so the numbers are readable.
  if (now - lastText < 500) return;
  lastText = now;
  const mb = (bytes) => (bytes / 1e6).toFixed(0);
  const parts = [
    `Downloading EmbeddingGemma 2: ${mb(loaded)}${total >= WEIGHTS_STARTED ? ` of ${mb(total)}` : ""} MB`,
  ];
  if (speed > 0) parts.push(`${(speed / 1e6).toFixed(1)} MB/s`);
  if (speed > 0 && total >= WEIGHTS_STARTED) {
    const seconds = Math.ceil((total - loaded) / speed);
    parts.push(seconds < 60 ? `${seconds} s left` : `${Math.ceil(seconds / 60)} min left`);
  }
  status.textContent = parts.join(" · ");
}

function resetProgress() {
  downloaded = 0;
  speed = 0;
  lastSample = undefined;
  lastText = 0;
}

// Without the model, typing still finds keyword matches; voice needs it.
function fail(message) {
  console.warn("Search model unavailable:", message);
  failed = true;
  ready = false;
  progress.hidden = true;
  stopListening();
  voice = undefined;
  showSetting();
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
  for (const resolve of transcripts.values()) resolve("");
  transcripts.clear();
  status.textContent =
    "EmbeddingGemma 2 couldn't start on this device, so search matches keywords.";
  if (input.value.trim()) search();
}

function start() {
  if (worker || failed) return;
  status.textContent = "Starting EmbeddingGemma 2…";
  downloaded_().then((cached) => (fromCache = cached));
  worker = new Worker(root.dataset.worker, { type: "module" });
  // The worker script or the library it imports couldn't load.
  worker.onerror = (event) => {
    event.preventDefault();
    fail(event.message);
  };
  worker.onmessage = async ({ data }) => {
    if (data.type === "progress") {
      showProgress(data);
    } else if (data.type === "fallback") {
      resetProgress();
      status.textContent =
        "Your GPU couldn't run EmbeddingGemma 2, so switching to its slower CPU version…";
    } else if (data.type === "ready") {
      await loadIndex();
      ready = true;
      progress.hidden = true;
      status.textContent = "";
      // Anything said while the model loaded is searched now.
      if (voice) {
        if (!voice.stopped) status.textContent = "Listening…";
        hear(voice);
      } else {
        search();
      }
    } else if (data.type === "embedding") {
      pending.get(data.id)?.(data.vector);
      pending.delete(data.id);
    } else if (data.type === "transcript") {
      transcripts.get(data.id)?.(data.text);
      transcripts.delete(data.id);
    } else if (data.type === "failed") {
      fail(data.message);
    }
  };
  worker.postMessage({ type: "load" });
}

// What Whisper heard, or "" if it couldn't run.
const transcripts = new Map();
let transcribed = 0;

function transcribe(audio) {
  const id = ++transcribed;
  return new Promise((resolve) => {
    transcripts.set(id, resolve);
    worker.postMessage({ type: "transcribe", id, audio }, [audio.buffer]);
  });
}

// Resolves with a null vector if the model fails.
function embed(message, transfer = []) {
  const id = ++latest;
  return new Promise((resolve) => {
    pending.set(id, (vector) => resolve({ id, vector }));
    worker.postMessage({ type: "query", id, ...message }, transfer);
  });
}

// --- Ranking by meaning ----------------------------------------------------

// Episode windows are one minute long and start every HOP seconds
// (see scripts/search/index.py).
const WINDOW = 60;
const HOP = 30;

function clock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// Each episode window stores the transcript of its first HOP seconds (see
// scripts/search/index.py), so its full minute is its own text plus the
// next window's.
function transcriptOf(at) {
  const { items } = index;
  const item = items[at];
  const next = items[at + 1];
  const follows =
    next?.kind === "episode" &&
    videoOf(next).video === videoOf(item).video &&
    videoOf(next).start === videoOf(item).start + HOP;
  return follows ? `${item.text} ${next.text}` : item.text;
}

function videoOf(item) {
  const [, video, start] = item.url.match(/v=([\w-]+)&t=(\d+)/) ?? [];
  return { video, start: Number(start) };
}

// Calibration was measured with typed queries and halves accuracy for spoken
// ones, so spoken queries rank by plain cosine and skip the noise cut-off.
// Live voice passes `smoothed`, a running average of each passage's cosine
// across updates, so results only move when they're consistently better.
const SMOOTHING = 0.4; // Weight of the newest update.

function rank(query, { spoken = false, smoothed } = {}) {
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
      if (!Number.isNaN(smoothed[i])) cosine = smoothed[i] + SMOOTHING * (cosine - smoothed[i]);
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
    const byStart = new Map(windows.map((w) => [w.start, w]));
    let from = best.start;
    let to = best.start;
    if (!spoken) {
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

function tokens(text) {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => token.length > 1 && !STOP.has(token),
  );
}

function bm25(items) {
  const docs = items.map((item, at) => {
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
      terms: tokens(`${item.title} ${transcriptOf(at)}`),
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

function keywordRank(query) {
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
function arrange(hits, words = null) {
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

// --- Snippets --------------------------------------------------------------

// The words of a result to show: for typed searches, the stretch around the
// first word that matches, so it's clear why it matched; otherwise the start.
const SNIPPET = 220;

function excerpt(text, terms) {
  const words = [...text.matchAll(/\S+/g)];
  const matches = (word) => {
    const lower = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    return terms.some((term) => lower.startsWith(term));
  };
  const first = terms.length ? words.findIndex(([word]) => matches(word)) : -1;
  let from = 0;
  if (first > 0) {
    // Start a few words before the match, so it reads in context.
    from = words[Math.max(0, first - 6)].index;
  }
  let to = from + SNIPPET;
  if (to < text.length) to = text.lastIndexOf(" ", to);
  const shown = text.slice(from, to > from ? to : from + SNIPPET);
  const pieces = [];
  if (from > 0) pieces.push("…");
  for (const [i, part] of shown.split(/(\s+)/).entries()) {
    if (i % 2 === 0 && part && matches(part)) {
      const mark = document.createElement("mark");
      mark.textContent = part;
      pieces.push(mark);
    } else {
      pieces.push(part);
    }
  }
  if (from + shown.length < text.length) pieces.push("…");
  return pieces;
}

function passage(hit) {
  return hit.kind === "episode" ? transcriptOf(hit.at) : hit.text;
}

// --- Results ---------------------------------------------------------------

// Hovering an episode swaps its cover for a muted clip from the matched moment.
let hoverTimer;

function preview(frame, hit) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (frame.querySelector("iframe")) return;
    const player = document.createElement("iframe");
    const end = hit.end ? `&end=${hit.end}` : "";
    player.src = `https://www.youtube-nocookie.com/embed/${hit.video}?start=${hit.start}${end}&autoplay=1&mute=1&controls=0&playsinline=1&rel=0`;
    player.allow = "autoplay; encrypted-media";
    player.title = `${hit.title}, from ${clock(hit.start)}`;
    frame.append(player);
  }, 250);
}

function stopPreview(frame) {
  clearTimeout(hoverTimer);
  frame.querySelector("iframe")?.remove();
}

// Results that stay in the list keep their element and glide to their new
// place, so live updates read as movement rather than a redraw.
let shown = new Map();
const calm = matchMedia("(prefers-reduced-motion: reduce)");

// `terms` are the typed words to highlight in snippets.
function render(hits, terms = []) {
  const before = new Map([...shown].map(([key, li]) => [key, li.getBoundingClientRect().top]));
  const next = new Map();
  const highlight = terms.join(" ");
  const groups = new Set(hits.map((hit) => hit.kind)).size > 1;
  for (const [i, hit] of hits.entries()) {
    if (groups && hit.kind !== hits[i - 1]?.kind) {
      const key = `group:${hit.kind}`;
      next.set(key, shown.get(key) ?? heading(hit.kind === "post" ? "Articles" : "Videos"));
    }
    const key = hit.kind === "post" ? hit.url : `${hit.video}@${hit.start}@${hit.at}`;
    const kept = shown.get(key);
    next.set(key, kept?.dataset.highlight === highlight ? kept : result(hit, terms));
    next.get(key).dataset.highlight = highlight;
  }
  results.replaceChildren(...next.values());
  shown = next;
  if (calm.matches) return;
  for (const [key, li] of next) {
    const top = before.get(key);
    if (top === undefined) {
      li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
      continue;
    }
    const moved = top - li.getBoundingClientRect().top;
    if (moved) {
      li.animate([{ transform: `translateY(${moved}px)` }, { transform: "none" }], {
        duration: 250,
        easing: "ease-out",
      });
    }
  }
}

function heading(text) {
  const li = document.createElement("li");
  li.className = "site-search-group";
  li.setAttribute("role", "presentation");
  li.textContent = text;
  return li;
}

function result(hit, terms) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  const text = document.createElement("span");
  text.className = "site-search-text";
  const meta = document.createElement("span");
  meta.className = "site-search-meta";
  const show = /^This Week in AI/i.test(hit.title) ? "This Week in AI" : "YouTube";
  const article = hit.publication ? `Article on ${hit.publication}` : "Article";
  meta.textContent = [hit.kind === "post" ? article : show, hit.section]
    .filter(Boolean)
    .join(" · ");
  const title = document.createElement("strong");
  title.textContent =
    hit.kind === "episode" ? hit.title.replace(/^This Week in AI \| /i, "") : hit.title;
  text.append(meta, title);
  const words = passage(hit);
  if (words) {
    const snippet = document.createElement("span");
    snippet.className = "site-search-snippet";
    snippet.append(...excerpt(words, terms));
    text.append(snippet);
  }
  if (hit.kind === "episode") {
    a.href = `https://www.youtube.com/watch?v=${hit.video}&t=${hit.start}s`;
    a.target = "_blank";
    a.className = "site-search-episode";
    const frame = document.createElement("span");
    frame.className = "site-search-frame";
    const cover = document.createElement("img");
    cover.src = `https://i.ytimg.com/vi/${hit.video}/mqdefault.jpg`;
    cover.alt = "";
    cover.loading = "lazy";
    frame.append(cover);
    a.append(frame);
    a.addEventListener("pointerenter", () => preview(frame, hit));
    a.addEventListener("pointerleave", () => stopPreview(frame));
    a.addEventListener("focus", () => preview(frame, hit));
    a.addEventListener("blur", () => stopPreview(frame));
  } else {
    a.href = hit.url;
    if (hit.publication) a.target = "_blank";
  }
  a.append(text);
  li.append(a);
  return li;
}

async function search() {
  const query = input.value.trim();
  if (voice && !voice.stopped) return;
  if (!query) {
    results.replaceChildren();
    if (ready) status.textContent = "";
    return;
  }
  await loadIndex();
  if (!ready) {
    // Keywords until the model is ready; the status keeps showing its progress.
    const hits = arrange(keywordRank(query));
    render(hits, tokens(query));
    if (failed) {
      status.textContent =
        "Search by meaning isn't available on this device, so these are keyword matches.";
    } else if (!worker) {
      status.textContent = hits.length ? "" : "No keyword matches.";
    }
    return;
  }
  const started = performance.now();
  const { id, vector } = await embed({ query });
  if (id !== latest) return; // A newer keystroke has already been sent.
  if (!vector) return search(); // The model failed; fail() switched to keywords.
  const meaning = rank(vector);
  const words = keywordRank(query);
  const fallback = !meaning.length;
  const hits = fallback
    ? arrange(words.filter((hit) => hit.matched >= 0.5))
    : arrange(meaning, words);
  render(hits, tokens(query));
  const took = Math.round(performance.now() - started);
  status.textContent = !hits.length
    ? "Nothing matched. Try different words."
    : fallback
      ? "Nothing close in meaning, so these are keyword matches."
      : `${hits.length} results from ${index.items.length.toLocaleString()} passages in ${took} ms`;
}

// --- Live voice search -----------------------------------------------------

// The microphone streams 16 kHz mono into a buffer. While someone talks, what
// they've said so far is embedded again as soon as the previous embedding
// returns, so results refine as they speak. A pause ends the search.
const RATE = 16000;
const MAX_SAMPLES = 30 * RATE;
const PRE_ROLL = 0.3 * RATE;
// Wait for enough speech to mean something, then update after each further
// stretch rather than every chunk, so results don't churn.
const MIN_SPEECH = 1.5 * RATE;
const UPDATE_EVERY = 0.75 * RATE;
// Speech is louder than both this and NOISE_RATIO times the background level.
// Listening ends after PAUSE_MS of quiet, once they've talked for MIN_TALK_MS,
// so a breath between phrases doesn't cut them off.
const VOICE_RMS = 0.004;
const NOISE_RATIO = 3;
const PAUSE_MS = 2500;
const MIN_TALK_MS = 2000;

const CAPTURE = `registerProcessor("capture", class extends AudioWorkletProcessor {
  process([input]) {
    if (input[0]) this.port.postMessage(input[0].slice());
    return true;
  }
});`;

// Voice needs a secure page, a microphone API and audio worklets.
const canListen = Boolean(navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode);

// The latest voice search, still listening until `stopped`.
let voice;

// Some browsers only record at the device's rate (Firefox won't connect a
// microphone to a 16 kHz context), so average each stretch of input samples
// down to one 16 kHz sample.
function downsampler(from) {
  const step = from / RATE;
  let sum = 0;
  let count = 0;
  let due = step;
  return (chunk) => {
    const out = new Float32Array(Math.ceil(chunk.length / step) + 1);
    let n = 0;
    for (const sample of chunk) {
      sum += sample;
      count++;
      if (count >= due) {
        out[n++] = sum / count;
        due += step - count;
        sum = 0;
        count = 0;
      }
    }
    return out.subarray(0, n);
  };
}

async function hear(session) {
  if (!ready || session.busy || !session.speaking) return;
  if (session.length < MIN_SPEECH || session.received === session.embedded) return;
  if (!session.stopped && session.received - session.embedded < UPDATE_EVERY) return;
  if (failed) return;
  session.busy = true;
  session.embedded = session.received;
  // Once listening has stopped, this is the whole question.
  const final = session.stopped;
  const audio = new Float32Array(session.length);
  let offset = 0;
  for (const chunk of session.chunks) {
    audio.set(chunk, offset);
    offset += chunk.length;
  }
  const words = final ? audio.slice() : null;
  if (final) session.transcribing = true;
  const { id, vector } = await embed({ audio }, [audio.buffer]);
  session.busy = false;
  if (!vector) return;
  if (id === latest) {
    session.smoothed ??= new Float32Array(index.items.length).fill(NaN);
    const hits = arrange(rank(vector, { spoken: true, smoothed: session.smoothed }));
    render(hits);
    // The status is announced to screen readers, so it only changes once
    // listening ends, not on every update.
    if (final) {
      status.textContent = "Closest to what you said.";
      await nameFromVoice(session, words, hits);
    }
  }
  session.transcribing = false;
  // Catch up on anything said while that ran, including after a pause.
  if (session === voice) hear(session);
}

async function listen() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
  } catch {
    open();
    status.textContent = "Voice search needs microphone access.";
    return;
  }
  let context;
  let node;
  try {
    context = new AudioContext();
    await context.resume();
    const url = URL.createObjectURL(new Blob([CAPTURE], { type: "text/javascript" }));
    await context.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    node = new AudioWorkletNode(context, "capture");
    context.createMediaStreamSource(stream).connect(node);
  } catch (error) {
    console.warn("Voice search couldn't record:", error);
    stream.getTracks().forEach((track) => track.stop());
    context?.close();
    open();
    status.textContent = "Voice search doesn't work in this browser, but typing does.";
    return;
  }
  const resample = downsampler(context.sampleRate);

  const session = {
    stream,
    context,
    chunks: [],
    length: 0,
    received: 0,
    embedded: 0,
  };
  voice = session;
  showWave(session);
  node.port.onmessage = (message) => {
    if (session.stopped) return;
    const data = resample(message.data);
    if (!data.length) return;
    let energy = 0;
    for (const sample of data) energy += sample * sample;
    const now = performance.now();
    // Smooth the level over a few tens of milliseconds, and track the room's
    // background level so speech is whatever stands well clear of it.
    const rms = Math.sqrt(energy / data.length);
    session.level = session.level === undefined ? rms : session.level * 0.8 + rms * 0.2;
    session.floor ??= session.level;
    if (session.level > Math.max(VOICE_RMS, session.floor * NOISE_RATIO)) {
      if (!session.speaking) session.spokeAt = now;
      session.speaking = true;
      session.heardAt = now;
    } else {
      // Only between words, so talking doesn't raise it. It falls straight
      // to a quieter room and rises slowly with a louder one.
      session.floor = Math.min(session.floor * 1.001, session.level);
    }
    session.chunks.push(data);
    session.length += data.length;
    session.received += data.length;
    // Keep a moment of lead-in before speech, and at most MAX_SAMPLES after.
    const keep = session.speaking ? MAX_SAMPLES : PRE_ROLL;
    while (session.length - session.chunks[0].length > keep) {
      session.length -= session.chunks.shift().length;
    }
    const paused = now - session.heardAt > PAUSE_MS;
    if (session.speaking && paused && now - session.spokeAt > MIN_TALK_MS) stopListening();
    else hear(session);
  };

  input.value = "";
  results.replaceChildren();
  open();
  mic.setAttribute("aria-pressed", "true");
  mic.setAttribute("aria-label", "Stop voice search");
  if (ready) status.textContent = "Listening… ask about anything I've written or said.";
}

// --- Naming a video out loud --------------------------------------------------

// Embeddings can't tell asking for a video by name from asking about its topic
// (eval.py names), so Whisper transcribes the finished question and
// search-names.js checks it against the video titles. A named video goes to
// the top, playing from the start.
let videos;

function namedVideo(text) {
  if (!videos) {
    const first = new Map();
    index.items.forEach((item, at) => {
      if (item.kind === "episode" && !first.has(videoOf(item).video))
        first.set(videoOf(item).video, at);
    });
    videos = [...first.values()];
    videos.named = namer(videos.map((at) => index.items[at].title));
  }
  const which = videos.named(text);
  return which === null ? null : videos[which];
}

async function nameFromVoice(session, audio, hits) {
  const text = (await transcribe(audio)).trim();
  if (session !== voice || !text) return;
  // Show what was heard; typing from here searches as usual.
  input.value = text;
  const at = namedVideo(text);
  if (at === null) {
    status.textContent = `Closest to “${text}”.`;
    return;
  }
  const item = index.items[at];
  const whole = {
    ...item,
    video: videoOf(item).video,
    start: 0,
    at,
    section: "Full video",
    score: Infinity,
  };
  const others = hits.filter(
    (hit) => !(hit.kind === "episode" && hit.start === 0 && hit.video === whole.video),
  );
  render(
    [
      whole,
      ...others.filter((hit) => hit.kind === "episode"),
      ...others.filter((hit) => hit.kind === "post"),
    ].slice(0, LIMIT),
  );
  status.textContent = `Heard “${text}”, so the top result plays from the start.`;
}

// --- Listening animation ----------------------------------------------------

// A row of rounded bars in the search box, driven by the microphone level:
// tallest in the middle, each wobbling at its own pace so it reads as a
// voice. When listening stops, the bars settle into dots that ripple until
// the last results arrive, then fade away.
const wave = root.querySelector(".site-search-wave");
const BARS = 28;
let waveFrame;

// Microphone level (RMS) to 0–1 on a decibel scale: quiet rooms sit near 0,
// ordinary speech around 0.6–0.9.
function loudness(level = 0) {
  const db = 20 * Math.log10(level + 1e-6);
  return Math.min(1, Math.max(0, (db + 55) / 40));
}

function showWave(session) {
  const box = input.parentElement;
  const context = wave.getContext("2d");
  const heights = new Float32Array(BARS);
  const phases = Array.from({ length: BARS }, (_, i) => i * 2.399);
  const speeds = Array.from({ length: BARS }, (_, i) => 5 + ((i * 7) % 5));
  const envelope = Array.from({ length: BARS }, (_, i) => {
    const x = (i - (BARS - 1) / 2) / (BARS * 0.3);
    return 0.18 + 0.82 * Math.exp(-x * x);
  });
  const color = getComputedStyle(wave).getPropertyValue("--accent").trim() || "#4f46e5";
  let fading = false;

  cancelAnimationFrame(waveFrame);
  wave.hidden = false;
  requestAnimationFrame(() => box.classList.add("is-listening"));

  const draw = (now) => {
    const t = now / 1000;
    const { width, height } = wave.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    if (wave.width !== Math.round(width * ratio)) {
      wave.width = Math.round(width * ratio);
      wave.height = Math.round(height * ratio);
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const finishing =
      session === voice &&
      session.stopped &&
      session.speaking &&
      (session.busy || session.transcribing || session.received !== session.embedded || !ready);
    const level = session.stopped ? 0 : loudness(session.level);
    const step = width / BARS;
    const bar = Math.min(3, step * 0.55);
    context.fillStyle = color;
    for (let i = 0; i < BARS; i++) {
      let target;
      if (finishing && !calm.matches) {
        // A soft ripple runs along the dots while the final results come in.
        target = 0.12 + 0.12 * Math.max(0, Math.sin(t * 7 - i * 0.45));
      } else {
        const wobble = calm.matches ? 1 : 0.55 + 0.45 * Math.sin(t * speeds[i] + phases[i]);
        target = level * envelope[i] * wobble;
      }
      // Rise quickly, fall back gently.
      heights[i] += (target - heights[i]) * (target > heights[i] ? 0.45 : 0.12);
      const h = Math.max(bar, heights[i] * (height - 6));
      context.globalAlpha = 0.45 + 0.55 * envelope[i];
      context.beginPath();
      context.roundRect(i * step + (step - bar) / 2, (height - h) / 2, bar, h, bar / 2);
      context.fill();
    }

    if (session.stopped && !finishing && !fading) {
      fading = true;
      box.classList.remove("is-listening");
      setTimeout(() => {
        // Unless a new voice search has started and taken over the canvas.
        if (!voice || voice === session || voice.stopped) {
          cancelAnimationFrame(waveFrame);
          wave.hidden = true;
        }
      }, 300);
    }
    if (!wave.hidden) waveFrame = requestAnimationFrame(draw);
  };
  waveFrame = requestAnimationFrame(draw);
}

function stopListening() {
  const session = voice;
  if (!session || session.stopped) return;
  session.stopped = true;
  session.stream.getTracks().forEach((track) => track.stop());
  session.context.close();
  mic.setAttribute("aria-pressed", "false");
  mic.setAttribute("aria-label", "Search by voice");
  if (!session.speaking) {
    voice = undefined;
    status.textContent = "Didn't hear anything. Try again?";
    return;
  }
  // One last pass over everything said. If an embedding is running, it
  // catches up when it returns; if the model is loading, it runs when ready.
  hear(session);
}

// --- Wiring ----------------------------------------------------------------

function open() {
  panel.hidden = false;
  input.setAttribute("aria-expanded", "true");
  showSetting();
  loadIndex();
  if (enabled()) start();
}

function close() {
  stopListening();
  panel.hidden = true;
  input.setAttribute("aria-expanded", "false");
}

// Turning AI features on opens search, so the download progress shows.
function turnOn() {
  remove.hidden = true;
  remember(true);
  open();
  input.focus();
  search();
}

// Stop using EmbeddingGemma 2, back to keywords only. Its files stay in the
// browser cache unless the visitor chooses to delete them.
async function turnOff() {
  remember(false);
  showSetting();
  stopListening();
  voice = undefined;
  worker?.terminate();
  worker = undefined;
  ready = false;
  failed = false;
  showSetting();
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
  for (const resolve of transcripts.values()) resolve("");
  transcripts.clear();
  progress.hidden = true;
  resetProgress();
  open();
  search();
  if (await downloaded_()) {
    status.textContent = "AI features are off. Delete EmbeddingGemma 2 from this device too?";
    remove.hidden = false;
  } else {
    status.textContent = "AI features are off.";
  }
}

const CACHES = ["transformers-cache", "experimental_transformers-hash-cache"];

async function downloaded_() {
  try {
    return await caches.has(CACHES[0]);
  } catch {
    return false;
  }
}

deleteModel.addEventListener("click", async () => {
  remove.hidden = true;
  try {
    for (const name of CACHES) await caches.delete(name);
    status.textContent = "EmbeddingGemma 2 is deleted from this device.";
  } catch {
    status.textContent =
      "Couldn't delete EmbeddingGemma 2. Clearing this site's data in your browser will.";
  }
});
keepModel.addEventListener("click", () => {
  remove.hidden = true;
  status.textContent = "Kept. Turning AI features back on won't download it again.";
});

input.addEventListener("focus", open);
input.addEventListener("input", () => {
  stopListening();
  voice = undefined;
  open();
  clearTimeout(timer);
  timer = setTimeout(search, DEBOUNCE_MS);
});
// Down arrow moves from the box into the results, arrows move between them,
// Enter opens the top result, and Escape closes.
const links = () => [...results.querySelectorAll("a")];

input.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    close();
    input.blur();
  } else if (event.key === "ArrowDown" && links().length) {
    event.preventDefault();
    links()[0].focus();
  } else if (event.key === "Enter" && links().length) {
    event.preventDefault();
    links()[0].click();
  }
});
results.addEventListener("keydown", (event) => {
  const all = links();
  const at = all.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = at + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0) input.focus();
    else all[Math.min(next, all.length - 1)].focus();
  } else if (event.key === "Escape") {
    close();
    input.focus();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!root.contains(event.target)) close();
});

showSetting();

// Each page load starts EmbeddingGemma 2 afresh (pages don't share memory),
// so with AI features on, start it as soon as the page is idle rather than
// waiting for the search box.
if (enabled()) {
  (window.requestIdleCallback ?? setTimeout)(() => {
    loadIndex();
    start();
  });
}

mic.addEventListener("click", () => {
  if (voice && !voice.stopped) return stopListening();
  listen();
});

// Turning on downloads about 370 MB, so the switch first explains what it does.
function showExplainer() {
  close();
  explain.hidden = false;
  confirmOn.focus();
}

function hideExplainer() {
  if (explain.hidden) return;
  explain.hidden = true;
  toggle.focus();
}

toggle.addEventListener("change", async () => {
  if (!toggle.checked) return turnOff();
  remove.hidden = true;
  if (await downloaded_()) return turnOn();
  toggle.checked = false;
  showExplainer();
});
confirmOn.addEventListener("click", () => {
  explain.hidden = true;
  turnOn();
});
notNow.addEventListener("click", hideExplainer);
explain.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideExplainer();
});
document.addEventListener("pointerdown", (event) => {
  if (
    !explain.hidden &&
    !explain.contains(event.target) &&
    !toggle.parentElement.contains(event.target)
  ) {
    explain.hidden = true;
  }
});
