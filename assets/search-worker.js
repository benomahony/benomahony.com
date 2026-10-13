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

async function load() {
  const device = (await navigator.gpu?.requestAdapter()) ? "webgpu" : "wasm";
  // Text and audio queries; leave out the image encoder.
  const config = await AutoConfig.from_pretrained(MODEL);
  delete config.vision_config;
  // fp16 weights need WebGPU; the CPU fallback uses plain 4-bit.
  const dtype = device === "webgpu" ? "q4f16" : "q4";
  [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(MODEL),
    AutoModel.from_pretrained(MODEL, {
      config,
      device,
      dtype: { model: dtype, audio_encoder: dtype },
      progress_callback,
    }),
  ]);
  // Warm up both paths so the first real search is fast.
  await embed(processor(["task: search result | query: warm up"]));
  await embed(processor(null, null, [new Float32Array(16000)]));
  self.postMessage({ type: "ready", device });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") return await load();
    const vector = data.audio
      ? await embed(processor(null, null, [data.audio]))
      : await embed(processor([`task: search result | query: ${data.query}`]));
    self.postMessage({ type: "embedding", id: data.id, vector });
  } catch (error) {
    self.postMessage({ type: "error", message: String(error?.message ?? error) });
  }
};
