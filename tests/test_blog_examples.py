"""Test that all code examples in blog posts are valid and well-formatted."""

from pathlib import Path
from uuid import uuid4

import pytest
from pytest_examples import CodeExample, EvalExample
from pytest_examples.find_examples import _extract_code_chunks

BLOG_DIR = Path(__file__).parent.parent / "content" / "blog"
ARTICLE = BLOG_DIR / "hardening-codebases-for-agentic-coding.smd"


def find_supermd_examples(path: Path):
    """Extract examples from SuperMD, which pytest-examples does not recognise yet."""
    return _extract_code_chunks(path, path.read_text("utf-8"), uuid4())


@pytest.mark.examples
@pytest.mark.parametrize(
    "example",
    find_supermd_examples(ARTICLE),
    ids=str,
)
def test_hardening_codebases_examples(example: CodeExample, eval_example: EvalExample):
    """
    Test all code examples in the hardening codebases article.

    Validates:
    - Syntax correctness (can parse as Python)
    - Code formatting (ruff format)
    - Import organization (ruff check)

    Does NOT validate:
    - Execution (many examples are illustrative snippets)
    - Import availability (examples reference external code)
    """
    # Format check only - ensures examples follow style guide
    if eval_example.update_examples:
        eval_example.format(example)
    else:
        # Just check formatting, don't try to execute
        eval_example.lint(example)
