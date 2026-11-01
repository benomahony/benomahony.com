"""Keep the published Markdown synchronized with the Zine article."""

from scripts.export_markdown import OUTPUT, ROOT, SOURCE, to_markdown


def test_markdown_matches_source() -> None:
    markdown = to_markdown(SOURCE.read_text(encoding="utf-8"))
    assert OUTPUT.read_text(encoding="utf-8") == markdown
    assert markdown.startswith("# My Ten Rules of Agentic Engineering\n")
    assert markdown.count("\n# ") == 10
    assert "$heading.id" not in markdown
    assert ".layout =" not in markdown


def test_markdown_is_published_by_zine() -> None:
    config = (ROOT / "zine.ziggy").read_text(encoding="utf-8")
    assert '"blog/my-10-rules-for-agentic-engineering.md"' in config
    assert OUTPUT.is_file()
