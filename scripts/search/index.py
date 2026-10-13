# /// script
# requires-python = ">=3.12"
# dependencies = [
#   "librosa",
#   "mlx-whisper>=0.4",
#   "numpy",
#   "pillow",
#   "sentence-transformers>=6",
#   "torch",
#   "torchaudio",
#   "torchvision",
#   "yt-dlp[default,curl-cffi]",
# ]
# ///
"""Build assets/search-index.json for the in-browser search.

    uv run scripts/search/index.py

Blog posts are embedded per section as text, and posts published elsewhere
by title and description. Every upload and past livestream on the YouTube
channel (including This Week in AI) is transcribed with Whisper and embedded
in overlapping one-minute windows, from the audio and its transcript
together.

Downloads, transcripts and embeddings are cached in scripts/search/.cache, so
reruns only process what's new. Needs Apple silicon (for Whisper) and ffmpeg.
"""

import argparse
import base64
import hashlib
import json
import re
import subprocess
import time
from pathlib import Path

import mlx_whisper
import numpy as np
import torch
import yt_dlp
from sentence_transformers import SentenceTransformer

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
CACHE = HERE / ".cache"
OUT = ROOT / "assets" / "search-index.json"

# The browser embeds queries with the ONNX export of the same model.
MODEL = "google/embeddinggemma-2"
BROWSER_MODEL = "onnx-community/embeddinggemma-2-ONNX"
WHISPER = "mlx-community/whisper-large-v3-turbo"
DIMS = 256  # Matryoshka truncation shared with the browser.
CHANNEL = "https://www.youtube.com/@Ben_OMahony"
CHANNEL_TABS = ["videos", "streams"]
WINDOW = 60
HOP = 30
RATE = 16000

# How each video window becomes one vector. "mixed" embeds the transcript and
# the audio as a single interleaved input; "sum" adds separate audio and
# transcript vectors; "audio" and "text" use only one of them. See eval.py.
VARIANTS = ("mixed", "sum", "audio", "text")
QUERY = "task: search result | query: {}"


def document(title: str, text: str) -> str:
    return f"title: {title} | text: {text}"


# --- Model -----------------------------------------------------------------

_model = None


def model() -> SentenceTransformer:
    global _model
    if _model is None:
        device = "mps" if torch.backends.mps.is_available() else "cpu"
        # bfloat16 on Apple GPUs; float16 overflows this model.
        dtype = torch.bfloat16 if device == "mps" else torch.float32
        _model = SentenceTransformer(
            MODEL,
            device=device,
            config_kwargs={"vision_config": None},
            model_kwargs={"torch_dtype": dtype},
        )
    return _model


def embed(inputs: list) -> np.ndarray:
    return model().encode(inputs, batch_size=4, convert_to_numpy=True).astype(np.float32)


def cached_vectors(name: str, compute) -> np.ndarray:
    path = CACHE / "vectors" / f"{name}.npy"
    if path.exists():
        return np.load(path)
    vectors = compute()
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, vectors)
    return vectors


def text_vectors(texts: list[str]) -> np.ndarray:
    """Embed texts, caching each by content."""
    keys = [hashlib.sha256((MODEL + t).encode()).hexdigest()[:32] for t in texts]
    missing = [t for t, k in zip(texts, keys) if not (CACHE / "vectors" / f"text-{k}.npy").exists()]
    if missing:
        for t, v in zip(missing, embed(missing)):
            k = hashlib.sha256((MODEL + t).encode()).hexdigest()[:32]
            cached_vectors(f"text-{k}", lambda v=v: v)
    return np.stack([np.load(CACHE / "vectors" / f"text-{k}.npy") for k in keys])


# --- Blog posts --------------------------------------------------------------


def front_matter(text: str) -> dict[str, str]:
    header = text.split("---")[1]
    return dict(re.findall(r'^\s*\.(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"', header, re.M))


def plain(markdown: str) -> str:
    for pattern, repl in [
        (r"```[\s\S]*?```", " "),
        (r"\[\^[^\]]*\]", ""),
        (r"!?\[([^\]]*)\]\([^)]*\)", r"\1"),
        (r"<[^>]+>", " "),
        (r"[*_`>#|]", ""),
        (r"\s+", " "),
    ]:
        markdown = re.sub(pattern, repl, markdown)
    return markdown.strip()


def sections(slug: str, text: str) -> list[dict]:
    body = "---".join(text.split("---")[2:])
    parts = [{"heading": None, "anchor": "", "lines": []}]
    fenced = False
    for line in body.split("\n"):
        if line.startswith("```"):
            fenced = not fenced
        heading = not fenced and re.match(r"^#{1,2} \[(.+)\]\(\$heading\.id\('([^']+)'\)\)", line)
        if heading:
            parts.append({"heading": heading[1], "anchor": f"#{heading[2]}", "lines": []})
        else:
            parts[-1]["lines"].append(line)
    out = []
    for part in parts:
        text = plain("\n".join(part["lines"]))
        if len(text) > 40:
            out.append({"heading": part["heading"], "text": text, "url": f"/blog/{slug}/{part['anchor']}"})
    return out


def posts() -> list[dict]:
    items, docs = [], []
    for file in sorted((ROOT / "content" / "blog").glob("*.smd")):
        text = file.read_text()
        meta = front_matter(text)
        if meta.get("layout") == "external.shtml":
            # Published elsewhere: only the title and description live here,
            # and the result links straight to the publication.
            items.append({
                "kind": "post",
                "title": meta["title"],
                "section": None,
                "url": meta["external_url"],
                "publication": meta["publication"],
                "text": meta["description"],
            })
            docs.append(document(meta["title"], meta["description"]))
        elif meta.get("layout") == "post.shtml":
            for section in sections(file.stem, text):
                title = f"{meta['title']}: {section['heading']}" if section["heading"] else meta["title"]
                items.append({
                    "kind": "post",
                    "title": meta["title"],
                    "section": section["heading"],
                    "url": section["url"],
                    "text": section["text"],
                })
                docs.append(document(title, section["text"]))
    for item, vector in zip(items, text_vectors(docs)):
        item["vector"] = vector
    print(f"{len(items)} post sections")
    return items


# --- Videos ----------------------------------------------------------------


def episodes(offline: bool) -> list[dict]:
    """Every upload and past livestream on the channel, newest listing cached."""
    path = CACHE / "episodes.json"
    if not offline:
        listed: dict[str, dict] = {}
        with yt_dlp.YoutubeDL({"extract_flat": True, "quiet": True}) as ydl:
            for tab in CHANNEL_TABS:
                for entry in ydl.extract_info(f"{CHANNEL}/{tab}", download=False)["entries"]:
                    listed[entry["id"]] = {"id": entry["id"], "title": " ".join(entry["title"].split())}
        path.write_text(json.dumps(list(listed.values()), indent=1))
    return json.loads(path.read_text())


def audio(video: str) -> Path:
    path = CACHE / "audio" / f"{video}.opus"
    if path.exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    options = {
        "format": "bestaudio",
        "outtmpl": str(path.with_suffix(".%(ext)s")),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "opus"}],
        "quiet": True,
    }
    # YouTube intermittently refuses downloads (403/429), so back off and retry.
    for attempt in range(1, 5):
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                ydl.download([f"https://www.youtube.com/watch?v={video}"])
            return path
        except yt_dlp.utils.DownloadError:
            if attempt == 4:
                raise
            time.sleep(30 * attempt)


def samples(path: Path) -> np.ndarray:
    pcm = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(pcm, dtype=np.float32)


def transcript(video: str) -> list[dict]:
    path = CACHE / "transcripts" / f"{video}.json"
    if not path.exists():
        print(f"  transcribing {video}")
        result = mlx_whisper.transcribe(
            str(audio(video)),
            path_or_hf_repo=WHISPER,
            # Stops one misheard stretch from turning into a repeating loop.
            condition_on_previous_text=False,
            # Everything on the channel is in English. Left to guess from the
            # first 30 s, Whisper once heard an intro as Japanese and wrote
            # the whole episode in it.
            language="en",
        )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(result, default=lambda _: None).replace("NaN", "null"))
    # Drop Whisper's repeated filler, like the same "Yeah." many times over.
    kept: list[dict] = []
    for segment in json.loads(path.read_text())["segments"]:
        text = segment["text"].strip()
        if text and not (kept and kept[-1]["text"] == text):
            kept.append({"start": segment["start"], "text": text})
    # A transcript in the wrong script would quietly end up in snippets and
    # vectors, so stop instead. Delete the cached transcript to redo it.
    foreign = sum(bool(re.search(r"[^\x00-ɏ -⁯]", s["text"])) for s in kept)
    if foreign > len(kept) * 0.02:
        raise SystemExit(f"{path} has {foreign}/{len(kept)} non-Latin segments; delete it to re-transcribe")
    return kept


def said(segments: list[dict], start: float, end: float) -> str:
    return " ".join(s["text"] for s in segments if start <= s["start"] < end)


def windows(episode: dict, variant: str) -> list[dict]:
    video = episode["id"]
    segments = transcript(video)
    clip_audio = samples(audio(video))
    starts = list(range(0, max(1, (len(clip_audio) - RATE * 10) // RATE), HOP))
    clips = [clip_audio[s * RATE : (s + WINDOW) * RATE] for s in starts]
    texts = [document(episode["title"], said(segments, s, s + WINDOW) or "none") for s in starts]

    def mixed():
        return embed([{"text": f"{t} <|audio|>", "audio": c} for t, c in zip(texts, clips)])

    def heard():
        return embed([{"audio": c} for c in clips])

    unit = lambda v: v / np.linalg.norm(v, axis=1, keepdims=True)
    if variant == "mixed":
        vectors = cached_vectors(f"{video}-{WINDOW}-{HOP}-mixed", mixed)
    elif variant == "text":
        vectors = text_vectors(texts)
    else:
        vectors = cached_vectors(f"{video}-{WINDOW}-{HOP}-audio", heard)
        if variant == "sum":
            vectors = unit(unit(vectors) + unit(text_vectors(texts)))
    return [
        {
            "kind": "episode",
            "title": episode["title"],
            "url": f"https://www.youtube.com/watch?v={video}&t={s}s",
            # Only the first HOP seconds: a window's full minute is its own
            # text plus the next window's, so overlaps aren't stored twice.
            "text": said(segments, s, s + HOP),
            "vector": v,
        }
        for s, v in zip(starts, vectors)
    ]


def videos(offline: bool, variant: str, limit: int | None) -> list[dict]:
    items = []
    for episode in episodes(offline)[:limit]:
        if offline and not (CACHE / "audio" / f"{episode['id']}.opus").exists():
            continue
        try:
            found = windows(episode, variant)
        except Exception as error:  # A video that won't download is skipped, not fatal.
            print(f"skipped {episode['id']} {episode['title']}: {error}")
            continue
        items.extend(found)
        print(f"video {episode['id']} {episode['title']} ({len(found)} windows)")
    return items


# --- Calibration -------------------------------------------------------------

# Some passages (silence, music, crosstalk) score well against almost any
# query. Recording each passage's mean and spread against a bank of unrelated
# queries lets the browser rank by how unusually well a passage matches.
BANK = [
    "latest frontier model release", "open-weight models", "model pricing and cost per token",
    "benchmarks and leaderboards", "AI regulation and policy", "copyright and training data",
    "coding agents in the terminal", "agent frameworks and harnesses",
    "evaluating LLM applications", "retrieval-augmented generation", "vector databases",
    "fine-tuning small language models", "GPU shortages and data centres",
    "chip makers and acquisitions", "AI startups raising money",
    "jailbreaks and prompt injection", "AI safety research", "hallucinations in production",
    "voice assistants and speech models", "image and video generation",
    "robotics and embodied AI", "self-driving cars", "AI in healthcare", "AI in education",
    "enterprise AI adoption", "developer productivity", "pair programming with AI",
    "testing and continuous integration", "platform engineering",
    "observability and telemetry", "data products and governance", "knowledge management",
    "consulting and client work", "hiring and careers in tech", "remote work",
    "open source licensing", "cloud providers", "mobile apps", "privacy and on-device AI",
    "search engines", "social media", "the weather this week", "football results",
    "cooking dinner", "travel plans", "a funny story", "music and podcasts",
]


def truncate(vectors: np.ndarray) -> np.ndarray:
    head = vectors[:, :DIMS]
    return head / np.linalg.norm(head, axis=1, keepdims=True)


def calibrate(matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    scores = truncate(matrix) @ truncate(text_vectors([QUERY.format(q) for q in BANK])).T
    return scores.mean(axis=1), scores.std(axis=1)


# --- Index -------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--variant", choices=VARIANTS, default="mixed")
    parser.add_argument("--offline", action="store_true", help="use only cached videos")
    parser.add_argument("--limit", type=int, help="index only this many videos (for testing)")
    args = parser.parse_args()

    items = posts() + videos(args.offline, args.variant, args.limit)
    matrix = np.stack([item.pop("vector") for item in items])
    mean, std = calibrate(matrix)
    unit = truncate(matrix)
    # int8 with a per-vector scale, so the browser ranks by dot product.
    scales = np.abs(unit).max(axis=1) / 127
    packed = np.round(unit / scales[:, None]).astype(np.int8)
    for item, m, s in zip(items, mean, std):
        item["mean"] = round(float(m), 4)
        item["std"] = round(float(s), 4)

    OUT.write_text(json.dumps({
        "model": BROWSER_MODEL,
        "dims": DIMS,
        "variant": args.variant,
        "items": items,
        "scales": [float(f"{s:.6g}") for s in scales],
        "vectors": base64.b64encode(packed.tobytes()).decode(),
    }, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(items)} items -> {OUT}")


if __name__ == "__main__":
    main()
