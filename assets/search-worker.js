// Embeds search queries with EmbeddingGemma 2, off the main thread.

import { env, pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js";

const MODEL = "onnx-community/embeddinggemma-2-ONNX";
env.allowLocalModels = false;

let extractor;

async function load() {
  const device = (await navigator.gpu?.requestAdapter()) ? "webgpu" : "wasm";
  extractor = await pipeline("feature-extraction", MODEL, {
    device,
    // fp16 weights need WebGPU; the CPU fallback uses plain 4-bit.
    dtype: device === "webgpu" ? "q4f16" : "q4",
    progress_callback: (event) => {
      if (event.status === "progress" && event.file.endsWith(".onnx_data")) {
        self.postMessage({ type: "progress", loaded: event.loaded, total: event.total });
      }
    },
  });
  // Warm up so the first real search is fast.
  await extractor(["task: search result | query: warm up"], { pooling: "mean", normalize: true });
  self.postMessage({ type: "ready", device });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") return await load();
    const output = await extractor([`task: search result | query: ${data.query}`], {
      pooling: "mean",
      normalize: true,
    });
    self.postMessage({ type: "embedding", id: data.id, vector: output.data });
  } catch (error) {
    self.postMessage({ type: "error", message: String(error?.message ?? error) });
  }
};
