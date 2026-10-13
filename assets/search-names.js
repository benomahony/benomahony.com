// Did a spoken search name a video? Shared by the site (search.js) and the
// evaluation (scripts/search/names.mjs), so the tuned rule can't drift.
//
// The words Whisper heard are matched against every video title. Words that
// are rare across titles count most ("this week in AI" is in nearly all of
// them, a date or "cognitive surrender" in one), dates and ordinals are
// normalised ("the twenty-first of May" = "21st May"), and long words may be
// two letters out, to absorb small transcription slips. A video is named when
// the words cover enough of its title, it beats the next title by at least one
// rare word, and little else was said that isn't in any title (otherwise it's
// a question about something in the video, not a request for the video).

const COVERAGE = 0.4;
const MARGIN = 1.0;
const EXTRA_WORDS = 2;

const STOP = new Set(
  "a an and are as at be but by for from has have how i in is it its of on or that the this to was what when where which who why will with you your video episode one play show me about".split(
    " ",
  ),
);
const ORDINALS = Object.fromEntries(
  "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth"
    .split(" ")
    .map((word, i) => [word, String(i + 1)]),
);
ORDINALS.thirtieth = "30";
const MONTHS =
  "january february march april may june july august september october november december".split(
    " ",
  );

export function words(text) {
  const spoken = text
    .toLowerCase()
    .replace(/\btwenty[- ](\w+)/g, (all, unit) =>
      ORDINALS[unit] ? String(20 + Number(ORDINALS[unit])) : all,
    )
    .replace(/\bthirty[- ]first\b/g, "31");
  const out = [];
  for (let word of spoken.match(/[a-z0-9]+/g) ?? []) {
    word = ORDINALS[word] ?? word.replace(/^(\d+)(st|nd|rd|th)$/, "$1");
    const month = word.length >= 3 && MONTHS.find((m) => m.startsWith(word));
    if (month) word = month;
    if (!STOP.has(word) && (word.length > 1 || /\d/.test(word))) out.push(word);
  }
  return out;
}

// Within two edits, for words long enough that a slip is still unambiguous.
function close(a, b) {
  if (a.length < 6 || b.length < 6 || Math.abs(a.length - b.length) > 2) return a === b;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] !== b[j - 1]),
      );
    }
    previous = current;
  }
  return previous[b.length] <= 2;
}

// Returns a function from heard text to the index of the named title, or null.
export function namer(titles) {
  const sets = titles.map((title) => new Set(words(title)));
  const df = new Map();
  for (const set of sets) for (const word of set) df.set(word, (df.get(word) ?? 0) + 1);
  const idf = new Map([...df].map(([word, n]) => [word, Math.log(1 + titles.length / n)]));
  const weights = sets.map((set) => [...set].reduce((sum, word) => sum + idf.get(word), 0));

  return (text) => {
    const heard = new Set(
      words(text).map((word) =>
        idf.has(word) ? word : ([...idf.keys()].find((known) => close(word, known)) ?? word),
      ),
    );
    const covered = sets.map((set) =>
      [...set].reduce((sum, word) => sum + (heard.has(word) ? idf.get(word) : 0), 0),
    );
    const order = covered.map((_, i) => i).sort((a, b) => covered[b] - covered[a]);
    const [best, next] = order;
    const extra = [...heard].filter((word) => !idf.has(word)).length;
    return covered[best] / weights[best] >= COVERAGE &&
      covered[best] - covered[next] >= MARGIN &&
      extra <= EXTRA_WORDS
      ? best
      : null;
  };
}
