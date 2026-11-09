from pathlib import Path

from search.frontmatter import front_matter

BLOG = Path(__file__).parent.parent / "content" / "blog"


def test_reads_top_level_and_nested_string_fields():
    meta = front_matter(
        '---\n.title = "Elsewhere",\n.layout = "external.shtml",\n'
        '.custom = .{\n    .external_url = "https://example.com",\n},\n---\n\nBody\n'
    )
    assert meta == {
        "title": "Elsewhere",
        "layout": "external.shtml",
        "external_url": "https://example.com",
    }


def test_top_level_field_wins_over_nested_one():
    meta = front_matter(
        '---\n.layout = "blog.shtml",\n.alternatives = [.{\n    .layout = "blog.xml",\n}],\n---\n'
    )
    assert meta["layout"] == "blog.shtml"


def test_escaped_quotes_stay_in_the_value():
    assert (
        front_matter('---\n.title = "A \\"quoted\\" word",\n---\n')["title"]
        == 'A \\"quoted\\" word'
    )


def test_body_is_not_read_as_frontmatter():
    assert "layout" not in front_matter('---\n.title = "T",\n---\n\n.layout = "post.shtml"\n')


def test_blog_index_keeps_its_page_layout():
    assert front_matter((BLOG / "index.smd").read_text())["layout"] == "blog.shtml"
