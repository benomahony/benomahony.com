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
"""Compare ways of embedding video windows on the queries in eval.json.

    uv run scripts/search/eval.py [variant ...]

Scores each variant the way the browser does: 256 dimensions, calibrated
(z-scored) similarity, and the same cut-off for "nothing matched". Uses only
cached videos, so run index.py first; uncached variants are computed and
cached on the way.
"""

import json
import re
import sys

import numpy as np

import index

MIN_SCORE = 1.5  # As in assets/search.js.


def ranks(scores: np.ndarray, correct: np.ndarray) -> int | None:
    """1-based rank of the best correct item, or None."""
    order = np.argsort(-scores)
    hits = np.flatnonzero(correct[order])
    return int(hits[0]) + 1 if len(hits) else None


def summary(found: list[int | None]) -> str:
    n = len(found)
    top1 = sum(r == 1 for r in found) / n
    top5 = sum(r is not None and r <= 5 for r in found) / n
    mrr = sum(1 / r for r in found if r) / n
    return f"top1 {top1:4.0%}  top5 {top5:4.0%}  MRR {mrr:.2f}"


def main() -> None:
    tests = json.loads((index.HERE / "eval.json").read_text())
    variants = sys.argv[1:] or list(index.VARIANTS)
    queries = index.truncate(
        index.text_vectors([index.QUERY.format(t["query"]) for t in tests["videos"]])
    )
    offtopic = index.truncate(index.text_vectors([index.QUERY.format(q) for q in tests["offtopic"]]))

    posts = index.posts()
    post_matrix = np.stack([p["vector"] for p in posts])
    post_mean, post_std = index.calibrate(post_matrix)
    post_queries = index.truncate(
        index.text_vectors([index.QUERY.format(t["query"]) for t in tests["posts"]])
    )
    z = (post_queries @ index.truncate(post_matrix).T - post_mean) / post_std
    urls = np.array([p["url"] for p in posts])
    found = [ranks(z[i], urls == t["url"]) for i, t in enumerate(tests["posts"])]
    print(f"{'posts among posts':>22}  {summary(found)}")

    for variant in variants:
        items = index.videos(offline=True, variant=variant, limit=None)
        matrix = np.stack([item["vector"] for item in items])
        mean, std = index.calibrate(matrix)
        unit = index.truncate(matrix)
        where = [re.search(r"v=([\w-]+)&t=(\d+)", i["url"]).groups() for i in items]
        video = np.array([w[0] for w in where])
        start = np.array([int(w[1]) for w in where])

        z = (queries @ unit.T - mean) / std
        found = [
            ranks(z[i], (video == t["video"]) & (np.abs(start - t["start"]) <= 30))
            for i, t in enumerate(tests["videos"])
        ]
        noise = ((offtopic @ unit.T - mean) / std).max(axis=1)
        shown = sum(noise >= MIN_SCORE)
        print(
            f"{variant:>22}  {summary(found)}  off-topic shown {shown}/{len(noise)}"
            f" (best {', '.join(f'{x:.1f}' for x in noise)})"
        )


if __name__ == "__main__":
    main()
