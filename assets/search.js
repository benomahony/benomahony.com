// Live, in-browser semantic search over posts and podcast audio (spike).
//
// The model only downloads after the visitor opts in. From then on, focusing
// the box starts it from the browser cache while they type.

const root = document.querySelector(".site-search");
const input = root.querySelector("input");
const panel = root.querySelector(".site-search-panel");
const enable = root.querySelector(".site-search-enable");
const enableButton = enable.querySelector("button");
const status = root.querySelector(".site-search-status");
const progress = root.querySelector(".site-search-progress");
let downloaded = 0;
const results = root.querySelector(".site-search-results");

const LIMIT = 8;
const DEBOUNCE_MS = 120;
// Calibrated scores below this are noise: off-topic queries score around -2,
// real hits in testing scored 2 to 6.
const MIN_SCORE = 1.5;

let worker;
let index;
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

// The small config and tokenizer files finish first, so the combined total
// only means something once the model weights (well over this size) start.
const WEIGHTS_STARTED = 50e6;
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

async function start() {
  if (worker) return;
  status.textContent = "Starting the model…";
  worker = new Worker(root.dataset.worker, { type: "module" });
  worker.onmessage = ({ data }) => {
    if (data.type === "progress") {
      showProgress(data);
    } else if (data.type === "ready") {
      ready = true;
      progress.hidden = true;
      status.textContent = "";
      search();
    } else if (data.type === "embedding") {
      pending.get(data.id)?.(data.vector);
      pending.delete(data.id);
    } else if (data.type === "error") {
      status.textContent = `Search failed to start: ${data.message}`;
    }
  };
  index = decodeIndex(await (await fetch(root.dataset.index)).json());
  worker.postMessage({ type: "load" });
}

function embed(query) {
  const id = ++latest;
  return new Promise((resolve) => {
    pending.set(id, (vector) => resolve({ id, vector }));
    worker.postMessage({ type: "query", id, query });
  });
}

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

function rank(query) {
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
    const [, video, start] = item.url.match(/v=([\w-]+)&t=(\d+)/) ?? [];
    return {
      ...item,
      video,
      start: Number(start),
      score: ((dot * scales[i]) / norm - item.mean) / item.std,
    };
  });

  const hits = scored.filter((item) => item.kind === "post" && item.score >= MIN_SCORE);

  // For each episode, grow its best window into the run of neighbouring
  // windows that also match, so a result covers the whole stretch of talk.
  const episodes = Map.groupBy(
    scored.filter((item) => item.kind === "episode"),
    (item) => item.video,
  );
  for (const windows of episodes.values()) {
    const best = windows.reduce((a, b) => (b.score > a.score ? b : a));
    if (best.score < MIN_SCORE) continue;
    const byStart = new Map(windows.map((w) => [w.start, w]));
    let from = best.start;
    let to = best.start;
    while (byStart.get(from - HOP)?.score >= MIN_SCORE) from -= HOP;
    while (byStart.get(to + HOP)?.score >= MIN_SCORE) to += HOP;
    hits.push({
      ...best,
      start: from,
      end: to + WINDOW,
      section: `${clock(from)} – ${clock(to + WINDOW)}`,
    });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, LIMIT);
}

// Hovering an episode swaps its cover for a muted clip from the matched moment.
let hoverTimer;

function preview(frame, hit) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (frame.querySelector("iframe")) return;
    const player = document.createElement("iframe");
    player.src = `https://www.youtube-nocookie.com/embed/${hit.video}?start=${hit.start}&end=${hit.end}&autoplay=1&mute=1&controls=0&playsinline=1&rel=0`;
    player.allow = "autoplay; encrypted-media";
    player.title = `${hit.title}, from ${clock(hit.start)}`;
    frame.append(player);
  }, 250);
}

function stopPreview(frame) {
  clearTimeout(hoverTimer);
  frame.querySelector("iframe")?.remove();
}

function render(hits) {
  results.replaceChildren(
    ...hits.map((hit) => {
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
    }),
  );
}

async function search() {
  const query = input.value.trim();
  if (!ready) return;
  if (!query) {
    results.replaceChildren();
    status.textContent = "";
    return;
  }
  const started = performance.now();
  const { id, vector } = await embed(query);
  if (id !== latest) return; // A newer keystroke has already been sent.
  const hits = rank(vector);
  render(hits);
  const took = Math.round(performance.now() - started);
  status.textContent = hits.length
    ? `${index.items.length} passages in ${took} ms`
    : "Nothing matched strongly. Try different words.";
}

function open() {
  panel.hidden = false;
  enable.hidden = enabled();
  if (enabled()) start();
}

input.addEventListener("focus", open);
input.addEventListener("input", () => {
  open();
  clearTimeout(timer);
  timer = setTimeout(search, DEBOUNCE_MS);
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    panel.hidden = true;
    input.blur();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!root.contains(event.target)) panel.hidden = true;
});

enableButton.addEventListener("click", () => {
  try {
    localStorage.setItem("search-enabled", "1");
  } catch {}
  enable.hidden = true;
  start();
  input.focus();
});
