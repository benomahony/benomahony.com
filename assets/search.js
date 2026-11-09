// Live, in-browser semantic search over posts and video audio (spike).
//
// Typing finds keyword (BM25) matches straight away. Once the visitor turns
// on AI features with the switch beside the box, EmbeddingGemma 2 runs on
// their device and matches by meaning, from typed text or live from the
// microphone, falling back to keywords when nothing is close. From then on,
// focusing the box starts the model from the browser cache.
//
// Ranking lives in search-rank.js, the results list in search-results.js,
// the model download in search-download.js and the microphone in
// search-voice.js. This file holds the search's state and wires it up.

import {
  checkCache,
  deleteDownload,
  hideProgress,
  isDownloaded,
  resetProgress,
  showProgress,
} from "./search-download.js";
import {
  arrange,
  bm25,
  decodeIndex,
  keywordRank,
  LIMIT,
  namedVideo,
  rank,
  tokens,
  videoOf,
} from "./search-rank.js";
import { render } from "./search-results.js";
import { enabled, onConfirm, remember, showExplainer } from "./search-setting.js";
import { addChunk, canListen, capture, due, joined, microphone, showWave } from "./search-voice.js";

const root = document.querySelector(".site-search");
const input = root.querySelector("input");
const mic = root.querySelector(".site-search-mic");
const panel = root.querySelector(".site-search-panel");
const about = root.querySelector(".site-search-about");
const toggle = root.querySelector(".site-search-switch input");
const remove = root.querySelector(".site-search-remove");
const [deleteModel, keepModel] = remove.querySelectorAll("button");
const status = root.querySelector(".site-search-status");
const results = root.querySelector(".site-search-results");

const DEBOUNCE_MS = 120;

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

// Voice search only appears once AI features are on.
function showSetting() {
  const on = enabled();
  toggle.checked = on;
  about.hidden = on;
  mic.hidden = !on || failed || !canListen;
}

// The index holds the text for keyword search as well as the vectors, so it
// loads as soon as someone opens search, before they opt in to the model.
function loadIndex() {
  indexing ??= fetch(root.dataset.index)
    .then((response) => response.json())
    .then((raw) => {
      index = decodeIndex(raw);
      keywords = bm25(index);
    });
  return indexing;
}

function background(task) {
  task.catch((error) => {
    console.error("Search failed:", error);
    status.textContent = "Search hit a problem. Try again?";
  });
}

// Without the model, typing still finds keyword matches; voice needs it.
function fail(message) {
  console.warn("Search model unavailable:", message);
  failed = true;
  ready = false;
  hideProgress();
  stopListening();
  voice = undefined;
  showSetting();
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
  for (const resolve of transcripts.values()) resolve("");
  transcripts.clear();
  status.textContent =
    "EmbeddingGemma 2 couldn't start on this device, so search matches keywords.";
  if (input.value.trim()) background(search());
}

async function fromWorker({ data }) {
  if (data.type === "progress") {
    showProgress(data);
  } else if (data.type === "fallback") {
    resetProgress();
    status.textContent =
      "Your GPU couldn't run EmbeddingGemma 2, so switching to its slower CPU version…";
  } else if (data.type === "ready") {
    await loadIndex();
    ready = true;
    hideProgress();
    status.textContent = "";
    // Anything said while the model loaded is searched now.
    if (voice) {
      if (!voice.stopped) status.textContent = "Listening…";
      background(hear(voice));
    } else {
      background(search());
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
}

function start() {
  if (worker || failed) return;
  status.textContent = "Starting EmbeddingGemma 2…";
  checkCache();
  worker = new Worker(root.dataset.worker, { type: "module" });
  // The worker script or the library it imports couldn't load.
  worker.addEventListener("error", (event) => {
    event.preventDefault();
    fail(event.message);
  });
  worker.addEventListener("message", fromWorker);
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
    const hits = arrange(keywordRank(keywords, query));
    render(index, hits, tokens(query));
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
  const meaning = rank(index, vector);
  const words = keywordRank(keywords, query);
  const fallback = !meaning.length;
  const hits = fallback
    ? arrange(words.filter((hit) => hit.matched >= 0.5))
    : arrange(meaning, words);
  render(index, hits, tokens(query));
  const took = Math.round(performance.now() - started);
  status.textContent = !hits.length
    ? "Nothing matched. Try different words."
    : fallback
      ? "Nothing close in meaning, so these are keyword matches."
      : `${hits.length} results from ${index.items.length.toLocaleString()} passages in ${took} ms`;
}

// --- Live voice search -----------------------------------------------------

// The latest voice search, still listening until `stopped`.
let voice;

async function hear(session) {
  if (!ready || failed || !due(session)) return;
  session.busy = true;
  session.embedded = session.received;
  // Once listening has stopped, this is the whole question.
  const final = session.stopped;
  if (final) session.transcribing = true;
  const audio = joined(session);
  const { id, vector } = await embed({ audio }, [audio.buffer]);
  session.busy = false;
  if (!vector) return;
  if (id === latest) {
    session.smoothed ??= new Float32Array(index.items.length).fill(NaN);
    const hits = arrange(rank(index, vector, { spoken: true, smoothed: session.smoothed }));
    render(index, hits);
    // The status is announced to screen readers, so it only changes once
    // listening ends, not on every update.
    if (final) {
      status.textContent = "Closest to what you said.";
      // `audio` went to the worker, but a stopped session takes no more
      // samples, so it still holds exactly what was just embedded.
      await nameFromVoice(session, joined(session), hits);
    }
  }
  session.transcribing = false;
  // Catch up on anything said while that ran, including after a pause.
  if (session === voice) background(hear(session));
}

async function listen() {
  let stream;
  try {
    stream = await microphone();
  } catch {
    open();
    status.textContent = "Voice search needs microphone access.";
    return;
  }
  let recorder;
  try {
    recorder = await capture(stream);
  } catch (error) {
    console.warn("Voice search couldn't record:", error);
    open();
    status.textContent = "Voice search doesn't work in this browser, but typing does.";
    return;
  }

  const session = {
    stream,
    context: recorder.context,
    chunks: [],
    length: 0,
    received: 0,
    embedded: 0,
  };
  voice = session;
  showWave(session, () => ({ voice, ready }));
  const { port } = recorder.node;
  port.addEventListener("message", ({ data }) => {
    if (session.stopped) return;
    const samples = recorder.resample(data);
    if (!samples.length) return;
    if (addChunk(session, samples)) stopListening();
    else background(hear(session));
  });
  // Unlike setting onmessage, a listener doesn't start the port by itself.
  port.start();

  input.value = "";
  results.replaceChildren();
  open();
  mic.setAttribute("aria-pressed", "true");
  mic.setAttribute("aria-label", "Stop voice search");
  if (ready) status.textContent = "Listening… ask about anything I've written or said.";
}

// A named video goes to the top, playing from the start.
async function nameFromVoice(session, audio, hits) {
  const text = (await transcribe(audio)).trim();
  if (session !== voice || !text) return;
  // Show what was heard; typing from here searches as usual.
  input.value = text;
  const at = namedVideo(index, text);
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
    index,
    [
      whole,
      ...others.filter((hit) => hit.kind === "episode"),
      ...others.filter((hit) => hit.kind === "post"),
    ].slice(0, LIMIT),
  );
  status.textContent = `Heard “${text}”, so the top result plays from the start.`;
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
  background(hear(session));
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
  background(search());
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
  hideProgress();
  resetProgress();
  open();
  background(search());
  if (await isDownloaded()) {
    status.textContent = "AI features are off. Delete EmbeddingGemma 2 from this device too?";
    remove.hidden = false;
  } else {
    status.textContent = "AI features are off.";
  }
}

deleteModel.addEventListener("click", async () => {
  remove.hidden = true;
  status.textContent = (await deleteDownload())
    ? "EmbeddingGemma 2 is deleted from this device."
    : "Couldn't delete EmbeddingGemma 2. Clearing this site's data in your browser will.";
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
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const all = links();
    const next = all.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : -1);
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
  background(listen());
});

toggle.addEventListener("change", async () => {
  if (!toggle.checked) return turnOff();
  remove.hidden = true;
  if (await isDownloaded()) return turnOn();
  toggle.checked = false;
  close();
  showExplainer();
});
onConfirm(turnOn);
