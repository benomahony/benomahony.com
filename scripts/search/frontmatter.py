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
