# benomahony.com

My personal website, built with [Zine](https://zine-ssg.io/).

## Develop

Install Zine 0.14.0, then start its development server from the repository root:

```sh
zine
```

Zine rebuilds the site and refreshes the browser as files change.

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
