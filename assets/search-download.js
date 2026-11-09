// EmbeddingGemma 2's download: the progress bar and status while it comes
// in, whether it's already in the browser cache, and deleting it.

const root = document.querySelector(".site-search");
const status = root.querySelector(".site-search-status");
const progress = root.querySelector(".site-search-progress");

// The small config and tokenizer files finish first, so the combined total
// only means something once the model weights (well over this size) start.
const WEIGHTS_STARTED = 50e6;
let downloaded = 0;
let speed = 0;
let lastSample;
let lastText = 0;
// Already downloaded, so progress is just reading the browser cache.
let fromCache = false;

export function showProgress({ loaded, total }) {
  const now = performance.now();
  if (lastSample && now > lastSample.at) {
    const instant = ((loaded - lastSample.loaded) * 1000) / (now - lastSample.at);
    speed = speed ? speed * 0.8 + instant * 0.2 : instant;
  }
  lastSample = { loaded, at: now };

  progress.hidden = false;
  const weighing = total >= WEIGHTS_STARTED;
  if (weighing) downloaded = Math.max(downloaded, loaded / total);
  progress.firstElementChild.style.transform = `scaleX(${downloaded})`;

  if (loaded >= total && weighing) {
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
  const parts = [`Downloading EmbeddingGemma 2: ${mb(loaded)}${weighing ? ` of ${mb(total)}` : ""} MB`];
  if (speed > 0) parts.push(`${(speed / 1e6).toFixed(1)} MB/s`);
  if (speed > 0 && weighing) {
    const seconds = Math.ceil((total - loaded) / speed);
    parts.push(seconds < 60 ? `${seconds} s left` : `${Math.ceil(seconds / 60)} min left`);
  }
  status.textContent = parts.join(" · ");
}

export function resetProgress() {
  downloaded = 0;
  speed = 0;
  lastSample = undefined;
  lastText = 0;
}

export function hideProgress() {
  progress.hidden = true;
}

// Note whether this load reads the model from the browser cache.
export async function checkCache() {
  fromCache = await isDownloaded();
}

const CACHES = ["transformers-cache", "experimental_transformers-hash-cache"];

export async function isDownloaded() {
  try {
    return await caches.has(CACHES[0]);
  } catch {
    return false;
  }
}

// True once the model's files are gone from the browser cache.
export async function deleteDownload() {
  try {
    for (const name of CACHES) await caches.delete(name);
    return true;
  } catch {
    return false;
  }
}
