"""Test that all code examples in blog posts actually work."""

import pytest
from pathlib import Path
from pytest_examples import find_examples, CodeExample, EvalExample

BLOG_DIR = Path(__file__).parent.parent / "docs" / "blog"


@pytest.mark.examples
@pytest.mark.parametrize("example", find_examples(BLOG_DIR / "hardening-codebases-for-agentic-coding.md"), ids=str)
def test_hardening_codebases_examples(example: CodeExample, eval_example: EvalExample):
    """Test all code examples in the hardening codebases article."""
    if eval_example.update_examples:
        eval_example.format(example)
    else:
        eval_example.lint(example)
        eval_example.run_print_check(example)
