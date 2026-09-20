/* mise en feast — cooking timers (pure ESM: no DOM, no imports, no clocks of its own).

   Cook mode reads a step like "simmer 10 to 12 minutes, then rest for half an hour"
   and offers a tappable timer for each duration. This module does the reading and
   the arithmetic; the UI owns the ticking, the beep and the pixels:

     findDurations(text)                 -> [{ label, seconds, start, end, text }]
     highlightDurations(html, durs, fn)  -> the step with each span wrapped by fn()
     createTimer({ id, label, seconds, now }) -> a timer that only does maths on
                                            the `now` timestamps it is handed
     formatRemaining(seconds)            -> 'mm:ss' / 'h:mm:ss'

   Every time-dependent method takes `now` (ms) as an argument instead of calling
   Date.now(), so a test can move the clock by hand and the UI can tick every
   timer from one setInterval. */

const MIN = 60, HOUR = 3600;

/* ---------- reading durations out of a step ---------- */

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};
const FRACTIONS = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };
const FRAC = `[${Object.keys(FRACTIONS).join('')}]`;
// "10", "1.5", "1½", "1 1/2", "1/2", "½"
const DIGITS = `(?:\\d+(?:\\.\\d+)?(?:\\s*${FRAC}|\\s+\\d+\\s*/\\s*\\d+)?|\\d+\\s*/\\s*\\d+|${FRAC})`;
// "five", "a" / "an" (as in "an hour"). A word number must be followed by a space or a
// hyphen so "vitamin C" and "amino" never read as "a min".
const NUM = `(?:${DIGITS}|(?:${Object.keys(WORD_NUMBERS).join('|')}|an?)(?=[\\s-]))`;
// Between the number and its unit: "10 minutes", "10min", "5-minute".
const SEP = '\\s*-?\\s*';
const RANGE = '\\s*(?:-|–|—|to|or)\\s*';
// Seconds, minutes and hours in the spellings recipes use. The unit must end the word
// ("5 mins," yes, "5 minutely" no) so "2 h" is a duration and "2 high" is not. An
// abbreviation's period ("10 min.") is left outside the span so a chip never wraps
// the full stop of the sentence.
const HOURS = 'h(?:ou)?rs?|h';
const MINS = 'min(?:ute)?s?';
const SECS = 'sec(?:ond)?s?';
const END = '(?![a-z])';
const AND_A_HALF = '(?:\\s+and\\s+a\\s+half(?![a-z]))';
// Three shapes, tried in order:
//   "half an hour" / "a quarter of an hour"
//   hours, with an optional minutes tail so "1 hour 30 minutes" is one 90-minute timer
//   minutes or seconds (no tail: "10 minutes, 5 minutes per side" is two timers)
const DURATION_RE = new RegExp(
  `(?<![\\w.])(?:`
  + `(?<half>half|quarter)\\s+(?:of\\s+)?an?\\s+(?<halfUnit>${HOURS}|${MINS})${END}`
  + `|(?<hnum>${NUM})(?:${RANGE}(?<hnum2>${NUM}))?${SEP}(?<hunit>${HOURS})${END}`
  + `(?:${AND_A_HALF}|(?:\\s*,?\\s*(?:and\\s+)?(?<mnum>${NUM})${SEP}(?:${MINS})${END})?)?`
  + `|(?<num>${NUM})(?:${RANGE}(?<num2>${NUM}))?${SEP}(?<unit>${MINS}|${SECS})${END}${AND_A_HALF}?`
  + `)`,
  'giu',
);

function numberValue(token) {
  const t = String(token || '').trim().toLowerCase();
  if (!t) return NaN;
  if (t === 'a' || t === 'an') return 1;
  if (WORD_NUMBERS[t] != null) return WORD_NUMBERS[t];
  if (FRACTIONS[t] != null) return FRACTIONS[t];
  // "1½", "1 1/2", "1/2", "1.5"
  const m = /^(\d+(?:\.\d+)?)?\s*(?:([¼½¾⅓⅔⅛])|(\d+)\s*\/\s*(\d+))?$/u.exec(t);
  if (!m) return NaN;
  let n = m[1] != null ? Number(m[1]) : 0;
  if (m[2]) n += FRACTIONS[m[2]];
  else if (m[3]) n += Number(m[3]) / (Number(m[4]) || 1);
  return n;
}

function unitSeconds(unit) {
  const u = String(unit || '').toLowerCase();
  if (u.startsWith('s')) return 1;
  if (u.startsWith('m')) return MIN;
  return HOUR;
}

/** "10 min", "45 sec", "1 hr 30 min": the chip text for a number of seconds. */
export function durationLabel(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < MIN) return `${s} sec`;
  if (s < HOUR) {
    const m = Math.floor(s / MIN), r = s % MIN;
    return r ? `${m} min ${r} sec` : `${m} min`;
  }
  const h = Math.floor(s / HOUR), m = Math.round((s % HOUR) / MIN);
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/**
 * Every cooking duration in a step, in reading order, as
 * `{ label: '10 min', seconds: 600, start, end, text }` where `start`/`end` are the
 * indices of the match in `stepText` (end exclusive) and `text` is the matched slice.
 * Ranges take the upper bound ("10 to 12 minutes" is a 12-minute timer, because an
 * early beep is a reminder to check and a late one is a burnt dinner). Word numbers
 * one..twenty, "an hour", "half an hour" and "1 hour 30 minutes" are understood;
 * temperatures ("350°F", "180 C", "200 degrees") have no time unit and are never
 * matched. Each occurrence is its own timer ("5 minutes per side, then 5 minutes
 * more" is two chips); identical or overlapping spans are collapsed to the first.
 */
export function findDurations(stepText) {
  const text = String(stepText ?? '');
  const out = [];
  const seen = new Set();
  DURATION_RE.lastIndex = 0;
  let m;
  while ((m = DURATION_RE.exec(text)) !== null) {
    if (m[0].length === 0) { DURATION_RE.lastIndex++; continue; }
    const g = m.groups || {};
    let seconds;
    if (g.half) {
      seconds = (g.half.toLowerCase() === 'half' ? 0.5 : 0.25) * unitSeconds(g.halfUnit);
    } else {
      const hours = g.hunit != null;
      const unit = hours ? g.hunit : g.unit;
      let n = numberValue(hours ? g.hnum : g.num);
      const second = hours ? g.hnum2 : g.num2;
      if (second != null) { const n2 = numberValue(second); if (Number.isFinite(n2)) n = Math.max(n, n2); }
      if (!Number.isFinite(n)) continue;
      seconds = n * unitSeconds(unit);
      if (/\band\s+a\s+half$/i.test(m[0])) seconds += 0.5 * unitSeconds(unit);
      else if (g.mnum != null) {
        const extra = numberValue(g.mnum);
        if (Number.isFinite(extra)) seconds += extra * MIN;
      }
    }
    seconds = Math.round(seconds);
    if (!(seconds > 0)) continue;
    const start = m.index, end = m.index + m[0].length;
    const id = `${start}|${end}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (out.length && start < out[out.length - 1].end) continue;   // overlaps the previous span: keep the earlier one
    out.push({ label: durationLabel(seconds), seconds, start, end, text: m[0] });
  }
  return out;
}

/**
 * Wrap each duration span of an already-escaped step in `render(d, i)` (which returns
 * HTML) and return the whole step as HTML. Run findDurations on the same escaped
 * string for exact indices; if the indices do not line up (durations were found on
 * the raw text and an `&` or `<` before the span shifted them), the span is re-located
 * by its `text`, so either order of operations renders correctly.
 */
export function highlightDurations(escapedStepHtml, durations, render) {
  const html = String(escapedStepHtml ?? '');
  const list = Array.isArray(durations) ? durations.slice() : [];
  const fn = typeof render === 'function' ? render : (d => `<span class="tchip">${d.label}</span>`);
  if (!list.length) return html;
  let cursor = 0, out = '';
  const spans = [];
  for (const d of list) {
    if (!d) continue;
    let start = Number(d.start), end = Number(d.end);
    const text = typeof d.text === 'string' ? d.text : (Number.isFinite(start) && Number.isFinite(end) ? html.slice(start, end) : '');
    if (!text) continue;
    if (!(Number.isFinite(start) && Number.isFinite(end) && html.slice(start, end) === text)) {
      const at = html.indexOf(text, cursor);
      if (at < 0) continue;
      start = at; end = at + text.length;
    }
    if (start < cursor) continue;   // overlaps the previous span
    spans.push({ d, start, end });
    cursor = end;
  }
  cursor = 0;
  spans.forEach(({ d, start, end }, i) => {
    out += html.slice(cursor, start) + fn(d, i);
    cursor = end;
  });
  return out + html.slice(cursor);
}

/* ---------- timers ---------- */

let timerSeq = 0;

/**
 * A countdown that only does arithmetic on the timestamps it is given. When `now` is
 * passed the timer starts at once (a tapped chip should run immediately); without it
 * the timer waits for start(now). Shape:
 *   { id, label, total, running, endsAt, pausedRemaining, createdAt,
 *     remaining(now), start(now), pause(now), toggle(now), reset(), done(now) }
 * `remaining(now)` is in seconds and never negative; `done(now)` is true once it hits 0.
 * `reset()` stops the timer and refills it; call start(now) to run it again.
 */
export function createTimer({ id, label, seconds, now } = {}) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const t = {
    id: id != null && id !== '' ? String(id) : `timer-${++timerSeq}`,
    label: label != null && label !== '' ? String(label) : durationLabel(total),
    total,
    running: false,
    endsAt: null,              // ms timestamp while running
    pausedRemaining: total,    // seconds left while paused
    createdAt: Number.isFinite(now) ? now : null,
    remaining(at) {
      if (t.running && t.endsAt != null && Number.isFinite(at)) return Math.max(0, (t.endsAt - at) / 1000);
      return Math.max(0, t.pausedRemaining ?? t.total);
    },
    start(at) {
      if (t.running || !Number.isFinite(at)) return t;
      t.endsAt = at + t.remaining(at) * 1000;
      t.pausedRemaining = null;
      t.running = true;
      return t;
    },
    pause(at) {
      if (!t.running) return t;
      t.pausedRemaining = t.remaining(at);
      t.running = false;
      t.endsAt = null;
      return t;
    },
    toggle(at) { return t.running ? t.pause(at) : t.start(at); },
    reset() {
      t.running = false;
      t.endsAt = null;
      t.pausedRemaining = t.total;
      return t;
    },
    done(at) { return t.remaining(at) <= 0; },
  };
  if (Number.isFinite(now)) t.start(now);
  return t;
}

/** 'mm:ss', or 'h:mm:ss' from an hour up. Rounds up so a timer shows 10:00 until it truly ticks. */
export function formatRemaining(seconds) {
  const s = Math.ceil(Math.max(0, Number(seconds) || 0));
  const h = Math.floor(s / HOUR), m = Math.floor((s % HOUR) / MIN), r = s % MIN;
  const mm = String(m).padStart(2, '0'), ss = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
