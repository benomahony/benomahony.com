// The list of search results: article and video rows with highlighted
// snippets, gliding to their new places as live results change.

import { clock, passage } from "./search-rank.js";

const results = document.querySelector(".site-search .site-search-results");
export const calm = matchMedia("(prefers-reduced-motion: reduce)");

// --- Snippets --------------------------------------------------------------

// The words of a result to show: for typed searches, the stretch around the
// first word that matches, so it's clear why it matched; otherwise the start.
const SNIPPET = 220;

function excerpt(text, terms) {
  const words = [...text.matchAll(/\S+/g)];
  const matches = (word) => {
    const lower = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    return terms.some((term) => lower.startsWith(term));
  };
  const first = terms.length ? words.findIndex(([word]) => matches(word)) : -1;
  let from = 0;
  if (first > 0) {
    // Start a few words before the match, so it reads in context.
    from = words[Math.max(0, first - 6)].index;
  }
  let to = from + SNIPPET;
  if (to < text.length) to = text.lastIndexOf(" ", to);
  const shown = text.slice(from, to > from ? to : from + SNIPPET);
  const pieces = [];
  if (from > 0) pieces.push("…");
  for (const [i, part] of shown.split(/(\s+)/).entries()) {
    if (i % 2 === 0 && part && matches(part)) {
      const mark = document.createElement("mark");
      mark.textContent = part;
      pieces.push(mark);
    } else {
      pieces.push(part);
    }
  }
  if (from + shown.length < text.length) pieces.push("…");
  return pieces;
}

// --- Results ---------------------------------------------------------------

// Hovering an episode swaps its cover for a muted clip from the matched moment.
let hoverTimer;

function preview(frame, hit) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (frame.querySelector("iframe")) return;
    const player = document.createElement("iframe");
    const end = hit.end ? `&end=${hit.end}` : "";
    player.src = `https://www.youtube-nocookie.com/embed/${hit.video}?start=${hit.start}${end}&autoplay=1&mute=1&controls=0&playsinline=1&rel=0`;
    player.allow = "autoplay; encrypted-media";
    player.title = `${hit.title}, from ${clock(hit.start)}`;
    frame.append(player);
  }, 250);
}

function stopPreview(frame) {
  clearTimeout(hoverTimer);
  frame.querySelector("iframe")?.remove();
}

// Results that stay in the list keep their element and glide to their new
// place, so live updates read as movement rather than a redraw.
let shown = new Map();

// `terms` are the typed words to highlight in snippets.
export function render(index, hits, terms = []) {
  const before = new Map([...shown].map(([key, li]) => [key, li.getBoundingClientRect().top]));
  const next = new Map();
  const highlight = terms.join(" ");
  const groups = new Set(hits.map((hit) => hit.kind)).size > 1;
  for (const [i, hit] of hits.entries()) {
    if (groups && hit.kind !== hits[i - 1]?.kind) {
      const key = `group:${hit.kind}`;
      next.set(key, shown.get(key) ?? heading(hit.kind === "post" ? "Articles" : "Videos"));
    }
    const key = hit.kind === "post" ? hit.url : `${hit.video}@${hit.start}@${hit.at}`;
    const kept = shown.get(key);
    next.set(key, kept?.dataset.highlight === highlight ? kept : result(index, hit, terms));
    next.get(key).dataset.highlight = highlight;
  }
  results.replaceChildren(...next.values());
  shown = next;
  if (calm.matches) return;
  for (const [key, li] of next) {
    const top = before.get(key);
    if (top === undefined) {
      li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
      continue;
    }
    const moved = top - li.getBoundingClientRect().top;
    if (moved) {
      li.animate([{ transform: `translateY(${moved}px)` }, { transform: "none" }], {
        duration: 250,
        easing: "ease-out",
      });
    }
  }
}

function heading(text) {
  const li = document.createElement("li");
  li.className = "site-search-group";
  li.setAttribute("role", "presentation");
  li.textContent = text;
  return li;
}

function span(className) {
  const element = document.createElement("span");
  element.className = className;
  return element;
}

function result(index, hit, terms) {
  const li = document.createElement("li");
  const a = document.createElement("a");
  const text = span("site-search-text");
  const meta = span("site-search-meta");
  const show = /^This Week in AI/i.test(hit.title) ? "This Week in AI" : "YouTube";
  const article = hit.publication ? `Article on ${hit.publication}` : "Article";
  meta.textContent = [hit.kind === "post" ? article : show, hit.section]
    .filter(Boolean)
    .join(" · ");
  const title = document.createElement("strong");
  title.textContent =
    hit.kind === "episode" ? hit.title.replace(/^This Week in AI \| /i, "") : hit.title;
  text.append(meta, title);
  const words = passage(index, hit);
  if (words) {
    const snippet = span("site-search-snippet");
    snippet.append(...excerpt(words, terms));
    text.append(snippet);
  }
  if (hit.kind === "episode") {
    a.href = `https://www.youtube.com/watch?v=${hit.video}&t=${hit.start}s`;
    a.target = "_blank";
    a.className = "site-search-episode";
    const frame = span("site-search-frame");
    const cover = document.createElement("img");
    cover.src = `https://i.ytimg.com/vi/${hit.video}/mqdefault.jpg`;
    cover.alt = "";
    cover.loading = "lazy";
    frame.append(cover);
    a.append(frame);
    a.addEventListener("pointerenter", () => preview(frame, hit));
    a.addEventListener("pointerleave", () => stopPreview(frame));
    a.addEventListener("focus", () => preview(frame, hit));
    a.addEventListener("blur", () => stopPreview(frame));
  } else {
    a.href = hit.url;
    if (hit.publication) a.target = "_blank";
  }
  a.append(text);
  li.append(a);
  return li;
}
