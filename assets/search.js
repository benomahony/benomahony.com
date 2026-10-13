// Live, in-browser semantic search over posts and video audio (spike).
//
// Typing finds keyword (BM25) matches straight away. Once the visitor opts in,
// EmbeddingGemma 2 runs on their device and matches by meaning, from typed
// text or live from the microphone, falling back to keywords when nothing is
// close. After opting in, focusing the box starts the model from the browser
// cache.

const root = document.querySelector(".site-search");
const input = root.querySelector("input");
const mic = root.querySelector(".site-search-mic");
const panel = root.querySelector(".site-search-panel");
const enable = root.querySelector(".site-search-enable");
const enableButton = enable.querySelector("button");
const status = root.querySelector(".site-search-status");
const progress = root.querySelector(".site-search-progress");
const results = root.querySelector(".site-search-results");

const LIMIT = 8;
const DEBOUNCE_MS = 120;
// Calibrated scores below this are noise: off-topic queries score around -2,
// real hits in testing scored 2 to 6.
const MIN_SCORE = 1.5;

let worker;
let index;
let indexing;
let keywords;
let ready = false;
let latest = 0;
let timer;
const pending = new Map();

function enabled() {
  try {
    return localStorage.getItem("search-enabled") === "1";
  } catch {
    return false;
  }
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
    status.textContent = "Starting the model…";
    return;
  }
  // Text changes twice a second at most, so the numbers are readable.
  if (now - lastText < 500) return;
  lastText = now;
  const mb = (bytes) => (bytes / 1e6).toFixed(0);
  const parts = [
    `Downloading the model: ${mb(loaded)}${total >= WEIGHTS_STARTED ? ` of ${mb(total)}` : ""} MB`,
  ];
  if (speed > 0) parts.push(`${(speed / 1e6).toFixed(1)} MB/s`);
  if (speed > 0 && total >= WEIGHTS_STARTED) {
    const seconds = Math.ceil((total - loaded) / speed);
    parts.push(seconds < 60 ? `${seconds} s left` : `${Math.ceil(seconds / 60)} min left`);
  }
  status.textContent = parts.join(" · ");
}

function start() {
  if (worker) return;
  status.textContent = "Starting the model…";
  worker = new Worker(root.dataset.worker, { type: "module" });
  worker.onmessage = async ({ data }) => {
    if (data.type === "progress") {
      showProgress(data);
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
    } else if (data.type === "error") {
      status.textContent = `Search failed to start: ${data.message}`;
    }
  };
  worker.postMessage({ type: "load" });
}

function embed(message, transfer = []) {
  const id = ++latest;
  return new Promise((resolve) => {
    pending.set(id, (vector) => resolve({ id, vector }));
    worker.postMessage({ type: "query", id, ...message }, transfer);
  });
}

// --- Ranking by meaning ----------------------------------------------------

// Episode windows are one minute long and start every HOP seconds
// (see scripts/search/build-index.js).
const WINDOW = 60;
const HOP = 30;

function clock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
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
  // scripts/search/build-index.js), so silence and audio-vs-text scale don't win.
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

  return hits.sort((a, b) => b.score - a.score).slice(0, LIMIT);
}

// --- Keyword ranking (BM25) ------------------------------------------------

// Each post section is a document, as is each video by its title: there are
// no transcripts, so keywords can't find moments inside a video.
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
  const videos = new Set();
  const docs = [];
  for (const item of items) {
    if (item.kind === "post") {
      docs.push({
        item,
        terms: tokens(`${item.title} ${item.section ?? ""} ${item.text}`),
      });
      continue;
    }
    const { video } = videoOf(item);
    if (videos.has(video)) continue;
    videos.add(video);
    docs.push({
      item: { ...item, video, start: 0, section: null },
      terms: tokens(item.title),
    });
  }
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
  return docs
    .map((doc) => {
      let score = 0;
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
      }
      return { ...doc.item, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT);
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

function render(hits) {
  const before = new Map([...shown].map(([key, li]) => [key, li.getBoundingClientRect().top]));
  const next = new Map();
  for (const hit of hits) {
    const key = hit.kind === "post" ? hit.url : `${hit.video}@${hit.start}`;
    next.set(key, shown.get(key) ?? result(hit));
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

function result(hit) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  const text = document.createElement("span");
  text.className = "site-search-text";
  const meta = document.createElement("span");
  meta.className = "site-search-meta";
  const show = /^This Week in AI/i.test(hit.title) ? "This Week in AI" : "YouTube";
  meta.textContent = [hit.kind === "post" ? "Article" : show, hit.section]
    .filter(Boolean)
    .join(" · ");
  const title = document.createElement("strong");
  title.textContent =
    hit.kind === "episode" ? hit.title.replace(/^This Week in AI \| /i, "") : hit.title;
  text.append(meta, title);
  if (hit.snippet) {
    const snippet = document.createElement("span");
    snippet.className = "site-search-snippet";
    snippet.textContent = hit.snippet;
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
    const hits = keywordRank(query);
    render(hits);
    if (!worker) status.textContent = hits.length ? "" : "No keyword matches.";
    return;
  }
  const started = performance.now();
  const { id, vector } = await embed({ query });
  if (id !== latest) return; // A newer keystroke has already been sent.
  let hits = rank(vector);
  const fallback = !hits.length;
  if (fallback) hits = keywordRank(query);
  render(hits);
  const took = Math.round(performance.now() - started);
  status.textContent = !hits.length
    ? "Nothing matched. Try different words."
    : fallback
      ? "Nothing close in meaning, so these are keyword matches."
      : `${index.items.length} passages in ${took} ms`;
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
const VOICE_RMS = 0.01;
const PAUSE_MS = 1500;

const CAPTURE = `registerProcessor("capture", class extends AudioWorkletProcessor {
  process([input]) {
    if (input[0]) this.port.postMessage(input[0].slice());
    return true;
  }
});`;

// The latest voice search, still listening until `stopped`.
let voice;

async function hear(session) {
  if (!ready || session.busy || !session.speaking) return;
  if (session.length < MIN_SPEECH || session.received === session.embedded) return;
  if (!session.stopped && session.received - session.embedded < UPDATE_EVERY) return;
  session.busy = true;
  session.embedded = session.received;
  const audio = new Float32Array(session.length);
  let offset = 0;
  for (const chunk of session.chunks) {
    audio.set(chunk, offset);
    offset += chunk.length;
  }
  const { id, vector } = await embed({ audio }, [audio.buffer]);
  session.busy = false;
  if (id === latest) {
    session.smoothed ??= new Float32Array(index.items.length).fill(NaN);
    render(rank(vector, { spoken: true, smoothed: session.smoothed }));
    const seconds = (offset / RATE).toFixed(1);
    status.textContent = session.stopped
      ? `Closest to what you said (${seconds} s).`
      : `Listening… ${seconds} s`;
  }
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
  const context = new AudioContext({ sampleRate: RATE });
  await context.resume();
  const url = URL.createObjectURL(new Blob([CAPTURE], { type: "text/javascript" }));
  await context.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const node = new AudioWorkletNode(context, "capture");
  context.createMediaStreamSource(stream).connect(node);

  const session = {
    stream,
    context,
    chunks: [],
    length: 0,
    received: 0,
    embedded: 0,
  };
  voice = session;
  node.port.onmessage = ({ data }) => {
    if (session.stopped) return;
    let energy = 0;
    for (const sample of data) energy += sample * sample;
    const now = performance.now();
    if (Math.sqrt(energy / data.length) > VOICE_RMS) {
      session.speaking = true;
      session.heardAt = now;
    }
    session.chunks.push(data);
    session.length += data.length;
    session.received += data.length;
    // Keep a moment of lead-in before speech, and at most MAX_SAMPLES after.
    const keep = session.speaking ? MAX_SAMPLES : PRE_ROLL;
    while (session.length - session.chunks[0].length > keep) {
      session.length -= session.chunks.shift().length;
    }
    if (session.speaking && now - session.heardAt > PAUSE_MS) stopListening();
    else hear(session);
  };

  input.value = "";
  results.replaceChildren();
  open();
  mic.setAttribute("aria-pressed", "true");
  mic.setAttribute("aria-label", "Stop voice search");
  if (ready) status.textContent = "Listening… ask about anything I've written or said.";
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
  enable.hidden = enabled();
  loadIndex();
  if (enabled()) start();
}

function optIn() {
  try {
    localStorage.setItem("search-enabled", "1");
  } catch {}
  enable.hidden = true;
  start();
}

input.addEventListener("focus", open);
input.addEventListener("input", () => {
  stopListening();
  voice = undefined;
  open();
  clearTimeout(timer);
  timer = setTimeout(search, DEBOUNCE_MS);
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    stopListening();
    panel.hidden = true;
    input.blur();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!root.contains(event.target)) panel.hidden = true;
});

// Voice is the main way in, so the microphone opts in to the model too.
mic.addEventListener("click", () => {
  if (voice && !voice.stopped) return stopListening();
  if (!enabled()) optIn();
  listen();
});

enableButton.addEventListener("click", () => {
  optIn();
  input.focus();
  search();
});
