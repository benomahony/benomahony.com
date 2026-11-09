"""Read the string fields of a SuperMD page's frontmatter."""

import re

FIELD = re.compile(r'^\s*\.(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"', re.M)


def front_matter(text: str) -> dict[str, str]:
    """Map each string field to its first value, so a top-level field wins over
    a same-named one nested later (such as an alternative's `.layout`)."""
    fields: dict[str, str] = {}
    for name, value in FIELD.findall(text.split("---", 2)[1]):
        fields.setdefault(name, value)
    return fields


DRAFT = re.compile(r"^\.draft\s*=\s*(\S+?),?\s*$", re.M)


def is_draft(text: str) -> bool:
    """Whether the page's top-level `.draft` is true. Anything other than true
    or false is rejected, like the Markdown publisher's parser."""
    found = DRAFT.search(text.split("---", 2)[1])
    if not found:
        return False
    value = found[1]
    if value not in ("true", "false"):
        raise ValueError(f"invalid .draft value: {value}")
    return value == "true"
