// Build assets/search-index.json for the in-browser search spike.
//
// Blog posts are embedded per section as text. YouTube videos and livestreams
// (including This Week in AI) are embedded straight from their audio in
// overlapping one-minute windows, so the search matches what was said
// without needing transcripts.
//
//   cd scripts/search && npm install && npm run index
//
// Needs ffmpeg and uv (for yt-dlp). Downloads and embeddings are cached in
// scripts/search/.cache, so reruns only process new posts and episodes.

import { AutoModel, AutoProcessor } from "@huggingface/transformers";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const CACHE = join(HERE, ".cache");
const OUT = join(ROOT, "assets", "search-index.json");

const MODEL = "onnx-community/embeddinggemma-2-ONNX";
const DIMS = 256;
const CHANNEL = "https://www.youtube.com/@Ben_OMahony";
const CHANNEL_TABS = ["videos", "streams"];
const WINDOW = 60;
const HOP = 30;
const RATE = 16000;

mkdirSync(join(CACHE, "audio"), { recursive: true });
mkdirSync(join(CACHE, "embeddings"), { recursive: true });

const processor = await AutoProcessor.from_pretrained(MODEL);
const model = await AutoModel.from_pretrained(MODEL, { device: "cpu", dtype: "q8" });

async function embed(inputs) {
  const { sentence_embedding } = await model(await inputs);
  return Array.from(sentence_embedding.data);
}

function cached(key, compute) {
  const path = join(CACHE, "embeddings", `${key}.json`);
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  return compute().then((value) => {
    writeFileSync(path, JSON.stringify(value));
    return value;
  });
}

// --- Blog posts ------------------------------------------------------------

function frontMatter(text) {
  const header = text.split("---")[1];
  const fields = {};
  for (const [, key, value] of header.matchAll(/^\.(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"/gm)) {
    fields[key] = value;
  }
  return fields;
}

function plain(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\^[^\]]*\]/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_`>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sections(slug, text) {
  const body = text.split("---").slice(2).join("---");
  const parts = [{ heading: null, anchor: "", lines: [] }];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const heading = !fenced && line.match(/^#{1,2} \[(.+)\]\(\$heading\.id\('([^']+)'\)\)/);
    if (heading) parts.push({ heading: heading[1], anchor: `#${heading[2]}`, lines: [] });
    else parts.at(-1).lines.push(line);
  }
  return parts
    .map((part) => ({ ...part, text: plain(part.lines.join("\n")) }))
    .filter((part) => part.text.length > 40)
    .map((part) => ({ ...part, url: `/blog/${slug}/${part.anchor}` }));
}

async function posts() {
  const dir = join(ROOT, "content", "blog");
  const items = [];
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".smd"))
    .sort()) {
    const text = readFileSync(join(dir, file), "utf8");
    const meta = frontMatter(text);
    if (meta.layout !== "post.shtml") continue;
    const slug = file.replace(/\.smd$/, "");
    for (const section of sections(slug, text)) {
      const title = section.heading ? `${meta.title}: ${section.heading}` : meta.title;
      const doc = `title: ${title} | text: ${section.text}`;
      const key = createHash("sha256")
        .update(MODEL + doc)
        .digest("hex")
        .slice(0, 32);
      items.push({
        kind: "post",
        title: meta.title,
        section: section.heading,
        url: section.url,
        snippet: section.text.slice(0, 220),
        vector: await cached(key, () => embed(processor([doc]))),
      });
    }
    console.log(`post ${slug}`);
  }
  return items;
}

// --- Podcast audio ---------------------------------------------------------

function ytDlp(...args) {
  return execFileSync("uvx", ["--from", "yt-dlp[default,curl-cffi]", "yt-dlp", ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
}

function episodes() {
  // Every upload and past livestream on the channel, which includes This Week in AI.
  const listed = CHANNEL_TABS.flatMap((tab) =>
    ytDlp("--flat-playlist", "--print", "%(id)s\t%(title)s", `${CHANNEL}/${tab}`)
      .trim()
      .split("\n")
      .filter(Boolean),
  );
  const videos = new Map();
  for (const [id, title] of listed.map((line) => line.split("\t"))) {
    videos.set(id, { id, title: title.replace(/\s+/g, " ").trim() });
  }
  return [...videos.values()];
}

async function download(id, file) {
  // YouTube intermittently refuses downloads (403/429), so back off and retry.
  for (let attempt = 1; ; attempt++) {
    try {
      return ytDlp(
        "-q",
        "-f",
        "bestaudio",
        "-x",
        "--audio-format",
        "opus",
        "-o",
        file,
        `https://www.youtube.com/watch?v=${id}`,
      );
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30_000 * attempt));
    }
  }
}

async function decode(id) {
  const file = join(CACHE, "audio", `${id}.opus`);
  if (!existsSync(file)) await download(id, file);
  const pcm = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", file, "-ac", "1", "-ar", String(RATE), "-f", "f32le", "-"],
    { maxBuffer: 1 << 30 },
  );
  return new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
}

function clock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

async function podcast() {
  const items = [];
  for (const episode of episodes()) {
    let windows;
    try {
      windows = await cached(`audio-${episode.id}-${WINDOW}-${HOP}`, async () => {
        const audio = await decode(episode.id);
        const out = [];
        for (let start = 0; start * RATE < audio.length - RATE * 10; start += HOP) {
          const clip = audio.subarray(start * RATE, (start + WINDOW) * RATE);
          out.push({ start, vector: await embed(processor(null, null, [clip])) });
        }
        return out;
      });
    } catch (error) {
      console.warn(
        `skipped episode ${episode.id} ${episode.title}: ${error.stderr?.trim() ?? error}`,
      );
      continue;
    }
    for (const { start, vector } of windows) {
      items.push({
        kind: "episode",
        title: episode.title,
        section: `${clock(start)} – ${clock(start + WINDOW)}`,
        url: `https://www.youtube.com/watch?v=${episode.id}&t=${start}s`,
        snippet: "",
        vector,
      });
    }
    console.log(`episode ${episode.id} ${episode.title} (${windows.length} windows)`);
  }
  return items;
}

// --- Calibration -----------------------------------------------------------

// Some passages (silence, music, crosstalk) score well against almost any
// query, and text and audio passages score on different scales. Recording
// each passage's mean and spread against a bank of unrelated queries lets the
// browser rank by how unusually well a passage matches, i.e. a z-score.
const BANK = [
  "latest frontier model release",
  "open-weight models",
  "model pricing and cost per token",
  "benchmarks and leaderboards",
  "AI regulation and policy",
  "copyright and training data",
  "coding agents in the terminal",
  "agent frameworks and harnesses",
  "evaluating LLM applications",
  "retrieval-augmented generation",
  "vector databases",
  "fine-tuning small language models",
  "GPU shortages and data centres",
  "chip makers and acquisitions",
  "AI startups raising money",
  "jailbreaks and prompt injection",
  "AI safety research",
  "hallucinations in production",
  "voice assistants and speech models",
  "image and video generation",
  "robotics and embodied AI",
  "self-driving cars",
  "AI in healthcare",
  "AI in education",
  "enterprise AI adoption",
  "developer productivity",
  "pair programming with AI",
  "testing and continuous integration",
  "platform engineering",
  "observability and telemetry",
  "data products and governance",
  "knowledge management",
  "consulting and client work",
  "hiring and careers in tech",
  "remote work",
  "open source licensing",
  "cloud providers",
  "mobile apps",
  "privacy and on-device AI",
  "search engines",
  "social media",
  "the weather this week",
  "football results",
  "cooking dinner",
  "travel plans",
  "a funny story",
  "music and podcasts",
];

async function calibrate(items) {
  const bank = [];
  for (const query of BANK) {
    bank.push(
      await cached(
        `bank-${createHash("sha256")
          .update(MODEL + query)
          .digest("hex")
          .slice(0, 24)}`,
        () => embed(processor([`task: search result | query: ${query}`])),
      ),
    );
  }
  for (const item of items) {
    const head = item.vector.slice(0, DIMS);
    const norm = Math.hypot(...head);
    const scores = bank.map((q) => {
      const qn = Math.hypot(...q.slice(0, DIMS));
      return head.reduce((sum, x, d) => sum + x * q[d], 0) / (norm * qn);
    });
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const std = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length);
    item.mean = Number(mean.toFixed(4));
    item.std = Number(std.toFixed(4));
  }
}

// --- Index -----------------------------------------------------------------

// Truncate to DIMS (Matryoshka), renormalise, then store as int8 with a
// per-vector scale so the browser can rank by dot product.
function quantise(vector) {
  const head = vector.slice(0, DIMS);
  const norm = Math.hypot(...head);
  const unit = head.map((x) => x / norm);
  const scale = Math.max(...unit.map(Math.abs)) / 127;
  return { scale, bytes: Int8Array.from(unit, (x) => Math.round(x / scale)) };
}

const items = [...(await posts()), ...(await podcast())];
await calibrate(items);
const packed = new Int8Array(items.length * DIMS);
const scales = [];
items.forEach((item, i) => {
  const { scale, bytes } = quantise(item.vector);
  packed.set(bytes, i * DIMS);
  scales.push(Number(scale.toPrecision(6)));
  delete item.vector;
});

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({
    model: MODEL,
    dims: DIMS,
    items,
    scales,
    vectors: Buffer.from(packed.buffer).toString("base64"),
  }),
);
console.log(`${items.length} items -> ${OUT}`);
