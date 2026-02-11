"""Test that all code examples in blog posts are valid and well-formatted."""

import pytest
from pathlib import Path
from pytest_examples import CodeExample, EvalExample, find_examples

BLOG_DIR = Path(__file__).parent.parent / "docs" / "blog"


@pytest.mark.examples
@pytest.mark.parametrize(
    "example",
    find_examples(BLOG_DIR / "hardening-codebases-for-agentic-coding.md"),
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
