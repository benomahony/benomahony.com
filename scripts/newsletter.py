# /// script
# requires-python = ">=3.13"
# dependencies = ["httpx>=0.28", "typer>=0.12"]
# ///
import os
import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx
import typer

ROOT = Path(__file__).resolve().parent.parent
FEED = ROOT / "public" / "blog" / "index.xml"
HOST = "https://benomahony.com"
KIT = "https://api.kit.com/v4"


def recent_posts(since: datetime) -> list[dict[str, str]]:
    return [
        {
            "title": item.findtext("title", ""),
            "link": item.findtext("link", ""),
            "content": item.findtext("description", ""),
        }
        for item in ET.parse(FEED).getroot().iter("item")
        if item.findtext("link", "").startswith(HOST)
        and parsedate_to_datetime(item.findtext("pubDate", "")) >= since
    ]


def absolute(html: str) -> str:
    return re.sub(r'(href|src)="/', rf'\1="{HOST}/', html)


def broadcast_links(client: httpx.Client) -> set[str]:
    links: set[str] = set()
    params: dict[str, str | int] = {"per_page": 1000}
    while True:
        page = client.get("/broadcasts", params=params).raise_for_status().json()
        links |= {broadcast.get("description") or "" for broadcast in page["broadcasts"]}
        if not page["pagination"]["has_next_page"]:
            return links
        params["after"] = page["pagination"]["end_cursor"]


def main(days: int = 14, dry_run: bool = False) -> None:
    since = datetime.now(UTC) - timedelta(days=days)
    headers = {"X-Kit-Api-Key": os.environ["KIT_API_KEY"]}
    with httpx.Client(base_url=KIT, headers=headers, timeout=30) as client:
        drafted = broadcast_links(client)
        for post in recent_posts(since):
            if post["link"] in drafted:
                continue
            typer.echo(f"Drafting {post['title']}")
            if dry_run:
                continue
            footer = f'<p><a href="{post["link"]}">Read it on benomahony.com</a></p>'
            client.post(
                "/broadcasts",
                json={
                    "subject": post["title"],
                    "description": post["link"],
                    "content": absolute(post["content"]) + footer,
                    "public": False,
                    "send_at": None,
                },
            ).raise_for_status()


if __name__ == "__main__":
    typer.run(main)
