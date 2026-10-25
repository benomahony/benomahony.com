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

## Search

The header search box searches the blog and every video and livestream on the YouTube channel (including This Week in AI) with [EmbeddingGemma 2](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX), running in the visitor's browser, with results updating as they type or speak.

- **Index.** Posts are embedded per section, and posts published elsewhere by title and description. Videos are transcribed with Whisper and embedded in one-minute windows every 30 s, each from its transcript and audio interleaved into a single input.
- **Opt-in.** Visitors turn on the AI switch beside the search box, which explains the 370 MB download (EmbeddingGemma 2 and Whisper tiny) first; turning it off asks whether to delete them from the browser cache. With it on, the model starts from the cache when search is opened, falls back from WebGPU to the CPU if it has to, and to keywords if it can't run at all.
- **Ranking.** Typed searches fuse meaning and keyword (BM25) rankings, separately for articles and videos. Video results show what's said in the matched minute.
- **Memory.** Inference runs one request at a time, keeping only the newest waiting search. Whisper loads only after a spoken question needs transcription, rather than alongside EmbeddingGemma at startup.
- **Voice.** The microphone embeds the visitor's voice with the model's audio encoder, re-ranking live while they talk and stopping after a pause. Whisper tiny then transcribes the question, and if it names a video, that video goes to the top, playing from the start.

The index (`assets/search-index.json`) is committed, because building it downloads and transcribes every video. Rebuild it after publishing a post or video, which needs uv, ffmpeg and Apple silicon (for Whisper):

```sh
uv run scripts/search/index.py
```

Downloads, transcripts and embeddings are cached in `scripts/search/.cache/`, so reruns only process what's new (`--offline` skips checking YouTube). `uv run scripts/search/eval.py` scores ways of embedding the videos against the test queries in `scripts/search/eval.json`, and `uv run scripts/search/eval.py names` scores how well spoken requests for a whole video are recognised (macOS `say` voices them, Whisper transcribes them, and `scripts/search/names.mjs` applies the site's rule from `assets/search-names.js`, so it needs Node).

## Diagnosing AI search problems

Open search, expand **Search diagnostics**, and select **Copy diagnostics**. The report contains browser capabilities, model initialization, CPU fallback, operation durations, categorized failures, and visibility changes. It records neither queries nor microphone audio/transcripts, and never sends the report automatically. The existing Cloudflare analytics beacon is unchanged; there is no central error collector.

The last 80 events and in-flight operation markers are kept in per-tab session storage. Reopening/reloading a tab after an unfinished operation adds `previous-operation-interrupted`. This is a clue, not proof of an out-of-memory crash: abrupt closure or reload can also leave the marker. Normal `pagehide` clears active markers. Storage denial is tolerated, but then diagnostics cannot survive a reload. **Clear history** removes recorded events.

## Test search lifecycle

Run the dependency-free worker regression checks (using fake inference sessions):

```sh
node --test tests/search-*.test.mjs
```

These check scheduling and cleanup, not model memory usage on physical phones.

## Test article examples

The Python snippets in the agentic coding article are checked with pytest-examples:

```sh
uv sync --extra dev
uv run pytest
```
