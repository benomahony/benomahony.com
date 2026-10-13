// Scores the spoken-name rule in assets/search-names.js on the transcribed
// test clips that eval.py writes: node scripts/search/names.mjs <heard.json>
import { readFileSync } from "node:fs";
import { namer } from "../../assets/search-names.js";

const { titles, ids, cases } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const named = namer(titles);
const tally = {};
for (const { group, heard, video } of cases) {
  const got = named(heard);
  const t = (tally[group] ??= { right: 0, wrong: 0, total: 0, misses: [] });
  t.total++;
  if (video === null) {
    if (got !== null) t.wrong++, t.misses.push(`${heard.trim()} -> ${titles[got]}`);
    else t.right++;
  } else if (got !== null && ids[got] === video) t.right++;
  else {
    if (got !== null) t.wrong++;
    t.misses.push(heard.trim());
  }
}
for (const [group, t] of Object.entries(tally)) {
  const label = group === "topics" ? "left as moments" : "named correctly";
  console.log(`${group.padStart(22)}  ${label} ${t.right}/${t.total}, wrong ${t.wrong}`);
  for (const miss of t.misses) console.log(`${"".padStart(24)}miss: ${miss}`);
}
