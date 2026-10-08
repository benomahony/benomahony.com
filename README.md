# benomahony.com

My personal website, built with [Zine](https://zine-ssg.io/).

## Develop

Install Zine 0.14.0, then start its development server from the repository root:

```sh
zine
```

Zine rebuilds the site and refreshes the browser as files change.

## Writing

- Add `.draft = true,` to an article's frontmatter to hide it from release builds. Preview drafts with `zine --drafts`.
- Tag articles with topic slugs, e.g. `.tags = ["agentic-coding"],`. Each tag needs a matching page in `content/topics/`, or the build fails.
- For a large social preview image, put it next to the article (`content/blog/<slug>/card.png`) and add `.custom = .{ .og_image = "card.png" },`. Otherwise the headshot is used.
- Link to other pages with `[text]($link.page('blog/knowledge-products'))` and to headings with `$link.page('blog/knowledge-products').ref('in-short')`, so broken internal links fail the build.

## Build

```sh
zine release
```

The production site is written to `public/`.

## Test article examples

The Python snippets in the agentic coding article are checked with pytest-examples:

```sh
uv sync --extra dev
uv run pytest
```
