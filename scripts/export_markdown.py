"""Export the agentic engineering rules from Zine SuperMD to plain Markdown."""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "content/blog/my-10-rules-for-agentic-engineering.smd"
OUTPUT = ROOT / "assets/blog/my-10-rules-for-agentic-engineering.md"
HEADING_LINK = re.compile(r"\[([^\]\n]+)\]\(\$heading\.id\('[a-z0-9-]+'\)\)")


def to_markdown(source: str) -> str:
    assert source.startswith("---\n"), "Expected SuperMD frontmatter"
    header, separator, body = source[4:].partition("\n---\n")
    assert separator, "Missing closing frontmatter"

    title = re.search(r'^\.title\s*=\s*"([^"]+)"', header, flags=re.MULTILINE)
    assert title is not None, "Missing article title"
    markdown = HEADING_LINK.sub(r"\1", body).strip()
    assert not re.search(r"\]\(\$", markdown), "Unsupported SuperMD link directive"
    return f"# {title.group(1)}\n\n{markdown}\n"


def main() -> None:
    markdown = to_markdown(SOURCE.read_text(encoding="utf-8"))
    assert markdown.startswith("# ")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(markdown, encoding="utf-8")
    assert OUTPUT.is_file()


if __name__ == "__main__":
    main()
