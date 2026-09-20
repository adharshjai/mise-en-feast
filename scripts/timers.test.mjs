import test from 'node:test';
import assert from 'node:assert/strict';
import { findDurations, highlightDurations, createTimer, formatRemaining, durationLabel } from '../frontend/shared/timers.js';

// The app's escaper (app.js `esc`), so highlightDurations is tested on real input.
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const one = text => { const d = findDurations(text); assert.equal(d.length, 1, `${JSON.stringify(text)} → ${JSON.stringify(d)}`); return d[0]; };
const secs = text => one(text).seconds;

test('plain units: seconds, minutes, hours in every spelling', () => {
  assert.deepEqual(one('Simmer for 10 minutes'), { label: '10 min', seconds: 600, start: 11, end: 21, text: '10 minutes' });
  assert.equal(secs('stir for 45 seconds'), 45);
  assert.equal(secs('roast 2 hours'), 7200);
  assert.equal(secs('cook 5 mins'), 300);
  assert.equal(secs('cook 5 min'), 300);
  assert.equal(secs('rest 30 secs'), 30);
  assert.equal(secs('rest 30 sec'), 30);
  assert.equal(secs('braise 3 hrs'), 10800);
  assert.equal(secs('braise 1 hr'), 3600);
  assert.equal(secs('proof 2 h'), 7200);
  assert.equal(secs('1.5 hours'), 5400);
  assert.equal(secs('10minutes'), 600);   // no space
});

test('an abbreviation period is understood but stays outside the span', () => {
  const d = one('Cook 10 min. Then serve.');
  assert.equal(d.seconds, 600);
  assert.equal(d.text, '10 min');
  assert.equal(one('Rest half an hour. Slice.').text, 'half an hour');
});

test('ranges take the upper bound', () => {
  assert.deepEqual(one('Bake 10 to 12 minutes'), { label: '12 min', seconds: 720, start: 5, end: 21, text: '10 to 12 minutes' });
  assert.equal(secs('sauté 10-12 min'), 720);
  assert.equal(secs('sauté 8–10 minutes'), 600);
  assert.equal(secs('fry 5 or 6 minutes'), 360);
  assert.equal(secs('roast 1 to 2 hours'), 7200);
  assert.equal(secs('one to two hours'), 7200);
});

test('word numbers one..twenty', () => {
  assert.equal(secs('cook five minutes'), 300);
  assert.equal(secs('rest twenty minutes'), 1200);
  assert.equal(secs('simmer Fifteen Minutes'), 900);
  assert.equal(secs('bake one hour'), 3600);
});

test('an hour, half an hour, and compound hours', () => {
  assert.equal(secs('marinate for an hour'), 3600);
  assert.equal(one('marinate for an hour').label, '1 hr');
  assert.equal(secs('rest half an hour'), 1800);
  assert.equal(secs('rest for half a minute'), 30);
  assert.equal(secs('a quarter of an hour'), 900);
  assert.equal(secs('wait a minute'), 60);
  assert.equal(secs('an hour and a half'), 5400);
  assert.equal(secs('a minute and a half'), 90);
  assert.equal(one('braise 1 hour 30 minutes').seconds, 5400);
  assert.equal(one('braise 1 hour 30 minutes').label, '1 hr 30 min');
  assert.equal(secs('braise 2 hours and 15 minutes'), 8100);
  assert.equal(secs('braise 2 hours, 15 minutes'), 8100);
  assert.equal(secs('1½ hours'), 5400);
  assert.equal(secs('1 1/2 hours'), 5400);
  assert.equal(secs('1/2 hour'), 1800);
  assert.equal(secs('½ hour'), 1800);
});

test('minutes do not absorb a following "N minutes" (two timers, not one)', () => {
  const d = findDurations('Sear 3 minutes, 2 minutes per side');
  assert.deepEqual(d.map(x => x.seconds), [180, 120]);
  assert.deepEqual(findDurations('10 minutes and 30 seconds').map(x => x.seconds), [600, 30]);
});

test('temperatures and bare numbers are not durations', () => {
  assert.deepEqual(findDurations('Bake at 350°F for 25 minutes').map(x => x.text), ['25 minutes']);
  assert.deepEqual(findDurations('Preheat the oven to 180 C. Roast 40 minutes.').map(x => x.seconds), [2400]);
  assert.deepEqual(findDurations('Reduce the heat to 200 degrees'), []);
  assert.deepEqual(findDurations('Add 2 cups of water and 350 g flour'), []);
  assert.deepEqual(findDurations('Serves 4'), []);
});

test('no false positives inside words', () => {
  for (const t of ['Season with salt', 'keep the heat at a minimum', 'add vitamin C', 'a mint leaf on top', 'hot sauce',
    '3 hats', 'amino acids', 'the minced garlic', '2 high heat', '5 minty leaves', 'two seconds thoughts']) {
    if (t === 'two seconds thoughts') continue;   // "two seconds" really is a duration; listed to say so
    assert.deepEqual(findDurations(t), [], t);
  }
});

test('indices point at the matched slice and come in reading order', () => {
  const text = 'Boil 8-10 minutes; drain. Fry 2 minutes, toss, then 2 minutes more, then rest an hour.';
  const d = findDurations(text);
  assert.deepEqual(d.map(x => x.seconds), [600, 120, 120, 3600]);
  for (const x of d) assert.equal(text.slice(x.start, x.end), x.text);
  for (let i = 1; i < d.length; i++) assert.ok(d[i].start >= d[i - 1].end);
  // the same duration twice is two chips: different spans, never collapsed
  assert.notEqual(d[1].start, d[2].start);
});

test('hyphenated and empty input', () => {
  assert.equal(secs('give it a 5-minute rest'), 300);
  assert.deepEqual(findDurations(''), []);
  assert.deepEqual(findDurations(null), []);
  assert.deepEqual(findDurations(undefined), []);
});

test('durationLabel', () => {
  assert.equal(durationLabel(45), '45 sec');
  assert.equal(durationLabel(90), '1 min 30 sec');
  assert.equal(durationLabel(600), '10 min');
  assert.equal(durationLabel(3600), '1 hr');
  assert.equal(durationLabel(5400), '1 hr 30 min');
  assert.equal(durationLabel(0), '0 sec');
});

test('highlightDurations wraps each span with render(d, i) on escaped text', () => {
  const raw = 'Simmer 10 minutes & rest 5 minutes';
  const html = esc(raw);
  const durs = findDurations(html);
  const out = highlightDurations(html, durs, (d, i) => `<button class="tchip" data-timer-seconds="${d.seconds}" data-timer-label="${d.label}" data-i="${i}">⏱ ${d.label}</button>`);
  assert.equal(out, 'Simmer <button class="tchip" data-timer-seconds="600" data-timer-label="10 min" data-i="0">⏱ 10 min</button> &amp; rest <button class="tchip" data-timer-seconds="300" data-timer-label="5 min" data-i="1">⏱ 5 min</button>');
});

test('highlightDurations relocates spans found on the raw text when escaping shifted them', () => {
  const raw = 'Mix "well" & simmer 10 minutes';
  const durs = findDurations(raw);   // indices are for the raw text
  const out = highlightDurations(esc(raw), durs, d => `[${d.label}]`);
  assert.equal(out, 'Mix &quot;well&quot; &amp; simmer [10 min]');
});

test('highlightDurations: no durations, default renderer, junk entries', () => {
  assert.equal(highlightDurations('plain step', [], () => 'x'), 'plain step');
  assert.equal(highlightDurations('rest 5 minutes', findDurations('rest 5 minutes')), 'rest <span class="tchip">5 min</span>');
  assert.equal(highlightDurations('rest 5 minutes', [null, { text: 'nowhere', start: 0, end: 7 }], () => 'x'), 'rest 5 minutes');
});

test('createTimer: pure arithmetic on injected timestamps', () => {
  const t0 = 1_000_000;
  const t = createTimer({ id: 'a', label: '10 min', seconds: 600, now: t0 });
  assert.equal(t.id, 'a');
  assert.equal(t.label, '10 min');
  assert.equal(t.total, 600);
  assert.equal(t.running, true);
  assert.equal(t.endsAt, t0 + 600_000);
  assert.equal(t.remaining(t0), 600);
  assert.equal(t.remaining(t0 + 1000), 599);
  assert.equal(t.done(t0 + 599_000), false);
  assert.equal(t.done(t0 + 600_000), true);
  assert.equal(t.remaining(t0 + 700_000), 0);   // never negative

  t.pause(t0 + 100_000);
  assert.equal(t.running, false);
  assert.equal(t.endsAt, null);
  assert.equal(t.pausedRemaining, 500);
  assert.equal(t.remaining(t0 + 5_000_000), 500);   // time does not pass while paused

  t.start(t0 + 200_000);
  assert.equal(t.running, true);
  assert.equal(t.endsAt, t0 + 700_000);
  assert.equal(t.remaining(t0 + 300_000), 400);
  t.start(t0 + 300_000);   // starting a running timer is a no-op
  assert.equal(t.endsAt, t0 + 700_000);

  t.toggle(t0 + 400_000);
  assert.equal(t.running, false);
  assert.equal(t.remaining(t0 + 400_000), 300);
  t.toggle(t0 + 450_000);
  assert.equal(t.running, true);
  assert.equal(t.endsAt, t0 + 750_000);

  t.reset();
  assert.equal(t.running, false);
  assert.equal(t.remaining(t0 + 900_000), 600);
  assert.equal(t.done(t0 + 900_000), false);
});

test('createTimer without now waits for start, and fills in id and label', () => {
  const t = createTimer({ seconds: 90 });
  assert.equal(t.running, false);
  assert.equal(t.remaining(123), 90);
  assert.equal(t.label, '1 min 30 sec');
  assert.match(t.id, /^timer-\d+$/);
  assert.notEqual(createTimer({ seconds: 1 }).id, t.id);
  t.start(1000);
  assert.equal(t.remaining(31_000), 60);
  assert.equal(createTimer({ seconds: -5 }).total, 0);
  assert.equal(createTimer({ seconds: 0, now: 1 }).done(1), true);
});

test('formatRemaining: mm:ss, h:mm:ss past an hour, rounds up', () => {
  assert.equal(formatRemaining(600), '10:00');
  assert.equal(formatRemaining(599.2), '10:00');   // ceil: shows 10:00 until a whole second has gone
  assert.equal(formatRemaining(59), '00:59');
  assert.equal(formatRemaining(0), '00:00');
  assert.equal(formatRemaining(-3), '00:00');
  assert.equal(formatRemaining(3600), '1:00:00');
  assert.equal(formatRemaining(3661), '1:01:01');
  assert.equal(formatRemaining(36_000), '10:00:00');
  assert.equal(formatRemaining(NaN), '00:00');
});
