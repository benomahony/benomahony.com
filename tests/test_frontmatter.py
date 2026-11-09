import pytest
from search.frontmatter import front_matter, is_draft


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


def test_draft_flag():
    assert is_draft('---\n.title = "T",\n.draft = true,\n---\n')
    assert not is_draft('---\n.title = "T",\n.draft = false,\n---\n')
    assert not is_draft('---\n.title = "T",\n---\n\n.draft = true,\n')


def test_invalid_draft_value_fails_closed():
    with pytest.raises(ValueError):
        is_draft("---\n.draft = sometimes,\n---\n")
