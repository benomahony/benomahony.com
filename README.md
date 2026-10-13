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

## Search spike

The header search box is an experiment, shown only on the `zine` dev server for now (remove the `$build.development` condition in `layouts/templates/base.shtml` to ship it). It searches the blog and the audio of every video and livestream on the YouTube channel (including This Week in AI) with [EmbeddingGemma 2](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX), running in the visitor's browser, with results updating as they type or speak. Posts are embedded per section as text; videos are embedded straight from their audio in one-minute windows, without transcripts. The microphone button embeds the visitor's voice with the model's audio encoder, re-ranking live while they talk and stopping after a pause. Before the model is enabled or loaded, and when nothing is close in meaning, typing falls back to keyword (BM25) matches over post text and video titles.

The index (`assets/search-index.json`) is committed, because building it downloads every episode and takes a couple of hours. Rebuild it after publishing a post or video, which needs Node, ffmpeg and uv:

```sh
cd scripts/search
npm install
npm run index
```

Downloads and embeddings are cached in `scripts/search/.cache/`, so reruns only process what's new.

## Test article examples

The Python snippets in the agentic coding article are checked with pytest-examples:

```sh
uv sync --extra dev
uv run pytest
```
