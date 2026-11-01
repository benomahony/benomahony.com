# /// script
# requires-python = ">=3.13"
# dependencies = ["httpx>=0.28", "typer>=0.12"]
# ///
import os
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import httpx
import typer

ROOT = Path(__file__).resolve().parent.parent
FEED = ROOT / "public" / "blog" / "index.xml"
HOST = "https://benomahony.com"
LIVE_FEED = f"{HOST}/blog/index.xml"
KIT = "https://api.kit.com/v4"


def built_posts() -> list[dict[str, str]]:
    return [
        {
            "title": item.findtext("title", ""),
            "link": item.findtext("link", ""),
            "content": item.findtext("description", ""),
        }
        for item in ET.parse(FEED).getroot().iter("item")
        if item.findtext("link", "").startswith(HOST)
    ]


def live_links() -> set[str]:
    feed = httpx.get(LIVE_FEED, timeout=30, follow_redirects=True).raise_for_status()
    return {item.findtext("link", "") for item in ET.fromstring(feed.content).iter("item")}


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


def main(dry_run: bool = False) -> None:
    published = live_links()
    headers = {"X-Kit-Api-Key": os.environ["KIT_API_KEY"]}
    with httpx.Client(base_url=KIT, headers=headers, timeout=30) as client:
        drafted = broadcast_links(client)
        for post in built_posts():
            if post["link"] in published or post["link"] in drafted:
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
