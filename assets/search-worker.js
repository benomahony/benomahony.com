// Embeds typed and spoken search queries with EmbeddingGemma 2, off the main
// thread.

import {
  AutoConfig,
  AutoModel,
  AutoProcessor,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";

const MODEL = "onnx-community/embeddinggemma-2-ONNX";
env.allowLocalModels = false;

let device;
let processor;
let model;
let lastProgress = 0;

// Progress summed across the model files, at most ten updates a second.
const files = new Map();
function progress_callback(event) {
  if (event.status !== "progress") return;
  files.set(event.file, event);
  if (performance.now() - lastProgress < 100 && event.loaded < event.total) return;
  lastProgress = performance.now();
  let loaded = 0;
  let total = 0;
  for (const file of files.values()) {
    loaded += file.loaded;
    total += file.total;
  }
  self.postMessage({ type: "progress", loaded, total });
}

async function embed(inputs) {
  const { sentence_embedding } = await model(await inputs);
  return sentence_embedding.data;
}

async function loadOn(target) {
  device = target;
  files.clear();
  // Text and audio queries; leave out the image encoder.
  const config = await AutoConfig.from_pretrained(MODEL);
  delete config.vision_config;
  // fp16 weights need WebGPU; the CPU fallback uses plain 4-bit.
  const dtype = device === "webgpu" ? "q4f16" : "q4";
  processor ??= await AutoProcessor.from_pretrained(MODEL);
  await model?.dispose();
  model = await AutoModel.from_pretrained(MODEL, {
    config,
    device,
    dtype: { model: dtype, audio_encoder: dtype },
    progress_callback,
  });
  // Warm up both paths so the first real search is fast, and so a GPU that
  // can't run the model fails here rather than on the first search.
  await embed(processor(["task: search result | query: warm up"]));
  await embed(processor(null, null, [new Float32Array(16000)]));
}

// WebGPU can be missing, refuse the model, run out of memory or lose its
// device. Each time, carry on with the slower CPU build.
async function onCpu(error) {
  if (device !== "webgpu") throw error;
  console.warn("Search model failed on WebGPU, switching to the CPU:", error);
  self.postMessage({ type: "fallback" });
  await loadOn("wasm");
}

async function load() {
  const gpu = await navigator.gpu?.requestAdapter().catch(() => null);
  try {
    await loadOn(gpu ? "webgpu" : "wasm");
  } catch (error) {
    await onCpu(error);
  }
  self.postMessage({ type: "ready", device });
}

async function query(data) {
  const inputs = () =>
    data.audio
      ? processor(null, null, [data.audio])
      : processor([`task: search result | query: ${data.query}`]);
  try {
    return await embed(inputs());
  } catch (error) {
    await onCpu(error);
    return await embed(inputs());
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === "load") {
    try {
      await load();
    } catch (error) {
      self.postMessage({ type: "failed", message: String(error?.message ?? error) });
    }
    return;
  }
  try {
    self.postMessage({ type: "embedding", id: data.id, vector: await query(data) });
  } catch (error) {
    // Report the failure first, so the page has switched to keywords by the
    // time this query comes back empty.
    self.postMessage({ type: "failed", message: String(error?.message ?? error) });
    self.postMessage({ type: "embedding", id: data.id, vector: null });
  }
};
