"""Test that every YouTube video the site links to is in the search index."""

import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).parent.parent
INDEX = ROOT / "assets" / "search-index.json"
VIDEO = re.compile(
    r"(?:youtube(?:-nocookie)?\.com/(?:embed/|watch\?v=)|youtu\.be/)([A-Za-z0-9_-]{11})"
)
INDEXED = re.compile(r"watch\?v=([A-Za-z0-9_-]{11})")


def linked_videos() -> list[tuple[str, str]]:
    return sorted(
        {
            (video, str(path.relative_to(ROOT)))
            for folder in ("content", "layouts")
            for path in (ROOT / folder).rglob("*")
            if path.is_file()
            for video in VIDEO.findall(path.read_text("utf-8", errors="ignore"))
        }
    )


def indexed_videos() -> set[str]:
    items = json.loads(INDEX.read_text("utf-8"))["items"]
    return {match for item in items for match in INDEXED.findall(item["url"])}


@pytest.mark.parametrize(("video", "source"), linked_videos(), ids=lambda v: v)
def test_linked_video_is_indexed(video: str, source: str):
    assert video in indexed_videos(), (
        f"{source} links to YouTube video {video}, which is not in the search index. "
        "Run `uv run scripts/search/index.py` to index it."
    )
