# benomahony.com

My personal website, built with [Zine](https://zine-ssg.io/).

## Develop

Install Zine 0.14.0 and [uv](https://docs.astral.sh/uv/), generate the social cards, then start Zine's development server from the repository root:

```sh
uv run scripts/cards.py
zine
```

Zine rebuilds the site and refreshes the browser as files change.

## Writing

- Add `.draft = true,` to an article's frontmatter to hide it from release builds. Preview drafts with `zine --drafts`.
- Tag articles with topic slugs, e.g. `.tags = ["agentic-engineering"],`. Each tag needs a matching page in `content/topics/`, or the build fails.
- Every `post.shtml` article gets a social preview card, rendered from its title by `scripts/cards.py` into `assets/cards/<slug>.png` (not committed). Rerun the script after adding a post or changing a title. Other pages use the headshot.
- Link to other pages with `[text]($link.page('blog/knowledge-products'))` and to headings with `$link.page('blog/knowledge-products').ref('in-short')`, so broken internal links fail the build.

## Build

```sh
uv run scripts/cards.py
zine release
```

The production site is written to `public/`.

## Test article examples

The Python snippets in the agentic coding article are checked with pytest-examples:

```sh
uv sync --extra dev
uv run pytest
```
