# /// script
# requires-python = ">=3.12"
# dependencies = ["mlx-whisper>=0.4"]
# ///
"""Add what's said in each video window to the search index.

Run after `npm run index`. Transcribes each indexed video's cached audio with
Whisper (cached per video in .cache/transcripts), then gives every episode
window the transcript of its first HOP seconds as `text`. A window's full
transcript is its own `text` plus the next window's, so overlapping windows
don't store the same words twice. The browser uses it for result snippets
and keyword search inside videos.

Needs Apple silicon (mlx-whisper) and ffmpeg.
"""

import json
import re
from pathlib import Path

import mlx_whisper

HERE = Path(__file__).parent
INDEX = HERE.parent.parent / "assets" / "search-index.json"
AUDIO = HERE / ".cache" / "audio"
TRANSCRIPTS = HERE / ".cache" / "transcripts"
MODEL = "mlx-community/whisper-large-v3-turbo"
HOP = 30  # Matches build-index.js.


def transcript(video: str) -> list[dict]:
    path = TRANSCRIPTS / f"{video}.json"
    if not path.exists():
        print(f"transcribing {video}")
        result = mlx_whisper.transcribe(
            str(AUDIO / f"{video}.opus"),
            path_or_hf_repo=MODEL,
            # Stops one misheard stretch from turning into a repeating loop.
            condition_on_previous_text=False,
        )
        path.write_text(json.dumps(result, allow_nan=False, default=lambda _: None))
    return json.loads(path.read_text())["segments"]


def clean(segments: list[dict]) -> list[dict]:
    """Drop Whisper's repeated filler, like the same 'Yeah.' many times over."""
    kept = []
    for segment in segments:
        text = segment["text"].strip()
        if text and not (kept and kept[-1]["text"] == text):
            kept.append({"start": segment["start"], "text": text})
    return kept


def main() -> None:
    TRANSCRIPTS.mkdir(parents=True, exist_ok=True)
    index = json.loads(INDEX.read_text())
    by_video: dict[str, list[dict]] = {}
    for item in index["items"]:
        if item["kind"] != "episode":
            continue
        video, start = re.search(r"v=([\w-]+)&t=(\d+)", item["url"]).groups()
        if video not in by_video:
            by_video[video] = clean(transcript(video))
        start = int(start)
        item["text"] = " ".join(
            s["text"] for s in by_video[video] if start <= s["start"] < start + HOP
        )
    INDEX.write_text(json.dumps(index, separators=(",", ":"), ensure_ascii=False))
    print(f"{len(by_video)} videos transcribed into {INDEX}")


if __name__ == "__main__":
    main()
