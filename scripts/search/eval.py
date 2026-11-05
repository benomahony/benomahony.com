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
"""Evaluate search on the test cases in eval.json.

    uv run scripts/search/eval.py [variant ...]   compare ways of embedding videos
    uv run scripts/search/eval.py names           spoken requests for a whole video

Scores each variant the way the browser does: 256 dimensions, calibrated
(z-scored) similarity, and the same cut-off for "nothing matched". Uses only
cached videos, so run index.py first; uncached variants are computed and
cached on the way.

Each score is shown against baseline.json, and the run exits 1 if any got
worse. Add --update to save this run's scores as the new baseline.
"""

import json
import re
import subprocess
import sys

import numpy as np

import index

MIN_SCORE = 1.5  # As in assets/search.js.


def ranks(scores: np.ndarray, correct: np.ndarray) -> int | None:
    """1-based rank of the best correct item, or None."""
    order = np.argsort(-scores)
    hits = np.flatnonzero(correct[order])
    return int(hits[0]) + 1 if len(hits) else None


def summary(found: list[int | None]) -> dict[str, float]:
    n = len(found)
    return {
        "cases": n,
        "top1": round(sum(r == 1 for r in found) / n, 4),
        "top5": round(sum(r is not None and r <= 5 for r in found) / n, 4),
        "MRR": round(sum(1 / r for r in found if r) / n, 4),
    }


BASELINE = index.HERE / "baseline.json"
FORMAT = {"top1": "{:.0%}", "top5": "{:.0%}", "MRR": "{:.2f}"}
LOWER_IS_BETTER = {"off-topic shown", "wrong"}


def report(row: str, now: dict, baseline: dict, worse: list[str]) -> str:
    """One row of scores, each with its change since the baseline. Rows whose
    case count changed are shown but not judged: their scores aren't comparable."""
    then = baseline.get(row, {})
    comparable = then.get("cases") == now["cases"]
    parts = [f"{now['cases']} cases"]
    for key, value in now.items():
        if key == "cases":
            continue
        shape = FORMAT.get(key, "{}")
        text = f"{key} {shape.format(value)}"
        if key in then and comparable:
            change = round(value - then[key], 4)
            if change:
                text += f" ({'+' if change > 0 else ''}{shape.format(change)})"
            if change * (-1 if key in LOWER_IS_BETTER else 1) < 0:
                worse.append(f"{row} {key}")
        parts.append(text)
    if then and not comparable:
        parts.append(f"(baseline had {then.get('cases')} cases: not compared)")
    return f"{row:>22}  " + "  ".join(parts)


SPOKEN = index.CACHE / "spoken"
WHISPER = "mlx-community/whisper-tiny"  # Same size as the browser's onnx-community/whisper-tiny.


def names(baseline: dict, results: dict, worse: list[str]) -> None:
    """Speak each case with macOS `say`, transcribe it with Whisper tiny, and
    score assets/search-names.js on what was heard (via names.mjs). Cases: every
    video title in full, the partial names in eval.json, and the video topic
    queries, which must not be taken as naming a video."""
    import mlx_whisper

    tests = json.loads((index.HERE / "eval.json").read_text())
    episodes = [
        e
        for e in index.episodes(offline=True)
        if (index.CACHE / "audio" / f"{e['id']}.opus").exists()
    ]
    cases = [
        ("full titles", f"the video {e['title'].replace('|', ',')}", e["id"]) for e in episodes
    ]
    cases += [("partial names", n["query"], n["video"]) for n in tests["named"]]
    cases += [("topics", t["query"], None) for t in tests["videos"]]

    SPOKEN.mkdir(parents=True, exist_ok=True)
    heard_path = SPOKEN / "heard.json"
    heard = json.loads(heard_path.read_text()) if heard_path.exists() else {}
    for _, text, _ in cases:
        if text not in heard:
            clip = SPOKEN / f"{len(heard)}.aiff"
            subprocess.run(["say", "-v", "Daniel", "-o", str(clip), text], check=True)
            heard[text] = mlx_whisper.transcribe(str(clip), path_or_hf_repo=WHISPER, language="en")[
                "text"
            ]
    heard_path.write_text(json.dumps(heard, indent=1))

    fixture = SPOKEN / "cases.json"
    fixture.write_text(
        json.dumps(
            {
                "titles": [e["title"] for e in episodes],
                "ids": [e["id"] for e in episodes],
                "cases": [{"group": g, "heard": heard[t], "video": v} for g, t, v in cases],
            }
        )
    )
    scored = subprocess.run(
        ["node", str(index.HERE / "names.mjs"), str(fixture)],
        check=True,
        capture_output=True,
        text=True,
    )
    for line in scored.stdout.splitlines():
        group = re.match(
            r"\s*(.+?)  (?:named correctly|left as moments) (\d+)/(\d+), wrong (\d+)$", line
        )
        if not group:
            print(line)
            continue
        row = f"names: {group[1]}"
        results[row] = {"cases": int(group[3]), "correct": int(group[2]), "wrong": int(group[4])}
        print(report(row, results[row], baseline, worse))


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--update"]
    baseline = json.loads(BASELINE.read_text()) if BASELINE.exists() else {}
    results: dict[str, dict] = {}
    worse: list[str] = []
    if args == ["names"]:
        names(baseline, results, worse)
    else:
        retrieval(args or list(index.VARIANTS), baseline, results, worse)
    if "--update" in sys.argv[1:]:
        BASELINE.write_text(json.dumps(baseline | results, indent=1, sort_keys=True) + "\n")
        print(f"saved {', '.join(results)} to {BASELINE.name}")
    elif worse:
        sys.exit(f"worse than {BASELINE.name}: {', '.join(worse)}")


def retrieval(variants: list[str], baseline: dict, results: dict, worse: list[str]) -> None:
    tests = json.loads((index.HERE / "eval.json").read_text())
    queries = index.truncate(
        index.text_vectors([index.QUERY.format(t["query"]) for t in tests["videos"]])
    )
    offtopic = index.truncate(
        index.text_vectors([index.QUERY.format(q) for q in tests["offtopic"]])
    )

    posts = index.posts()
    post_matrix = np.stack([p["vector"] for p in posts])
    post_mean, post_std = index.calibrate(post_matrix)
    post_queries = index.truncate(
        index.text_vectors([index.QUERY.format(t["query"]) for t in tests["posts"]])
    )
    z = (post_queries @ index.truncate(post_matrix).T - post_mean) / post_std
    urls = np.array([p["url"] for p in posts])
    found = [ranks(z[i], urls == t["url"]) for i, t in enumerate(tests["posts"])]
    results["posts among posts"] = summary(found)
    print(report("posts among posts", results["posts among posts"], baseline, worse))

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
            ranks(
                z[i],
                np.any(
                    [
                        (video == m["video"]) & (np.abs(start - m["start"]) <= 30)
                        for m in [t, *t.get("also", [])]
                    ],
                    axis=0,
                ),
            )
            for i, t in enumerate(tests["videos"])
        ]
        noise = ((offtopic @ unit.T - mean) / std).max(axis=1)
        results[variant] = summary(found) | {"off-topic shown": int(sum(noise >= MIN_SCORE))}
        print(
            f"{report(variant, results[variant], baseline, worse)}"
            f"  (of {len(noise)}, best {', '.join(f'{x:.1f}' for x in noise)})"
        )


if __name__ == "__main__":
    main()
