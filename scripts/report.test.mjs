import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, lotValue, summarize, lotEvent, expiredLots, expiringSoon } from '../frontend/shared/report.js';

// A fixed "now": Sunday 20 Sep 2026, 18:00 local. D(k, m) is m minutes before the same
// time k days earlier, which is always the same calendar day k days back (18:00 is
// nowhere near midnight), and never after `now`.
const NOW = new Date(2026, 8, 20, 18, 0, 0).getTime();
const D = (k, minutesEarlier = 0) => NOW - k * DAY - minutesEarlier * 60_000;

const COST = { stock: 0.4, basil: 0.4, cream: 0.5, onion: 0.3, tomatoes: 0.5, spinach: 0.7, eggs: 0.3, 'arborio rice': 0.5 };
const costFor = key => COST[key] ?? 0;
const lots = [{ id: 'm1', key: 'milk', name: 'Milk', price: 3.5, initial: 8, deducted: 1, burn: 0, purchase: D(2), expiry: D(-5) }];

// Two weeks (and a little more) of what the app writes. A `cook` with a key is one lot's
// servings going into a dish; a `cook` without a key is the meal itself.
const EVENTS = [
  { type: 'cook', title: 'Risotto', dishId: 'd1', at: D(0, 1) },
  { type: 'cook', key: 'arborio rice', name: 'Arborio rice', servings: 2, value: 1.0, beforeExpiry: true, dishId: 'd1', at: D(0) },
  { type: 'cook', key: 'stock', name: 'Stock', servings: 1, beforeExpiry: true, dishId: 'd1', at: D(0) },          // no value: costFor
  { type: 'cook', title: 'Omelette', dishId: 'd2', at: D(1, 1) },
  { type: 'cook', key: 'eggs', name: 'Eggs', servings: 2, value: 0.6, beforeExpiry: true, dishId: 'd2', at: D(1) },
  { type: 'checkin', key: 'milk', name: 'Milk', servings: 1, beforeExpiry: true, at: D(1) },                        // no value: the priced lot
  { type: 'added', key: 'milk', name: 'Milk', servings: 8, at: D(1) },                                              // ignored by every tally
  { type: 'cook', title: 'Stir-fry', dishId: 'd3', at: D(2, 1) },
  { type: 'cook', key: 'spinach', name: 'Spinach', servings: 1, value: 0.7, beforeExpiry: false, dishId: 'd3', at: D(2) },   // after expiry: not "used before expiring"
  { type: 'expired', key: 'basil', name: 'Basil', servings: 2, at: D(3) },
  { type: 'gone', key: 'cream', name: 'Cream', servings: 1, wasted: true, at: D(4) },
  { type: 'gone', key: 'onion', name: 'Onion', servings: 0.5, wasted: false, at: D(4) },                             // used up, not wasted
  { type: 'cook', title: 'Soup', dishId: 'd4', at: D(4, 1) },
  { type: 'cook', title: 'Tacos', dishId: 'd5', at: D(9, 1) },
  { type: 'cook', key: 'tomatoes', name: 'Tomatoes', servings: 2, value: 1.0, beforeExpiry: true, dishId: 'd5', at: D(9) },
  { type: 'expired', key: 'tomatoes', name: 'Tomatoes', servings: 1, at: D(9) },
  { type: 'cook', key: 'eggs', name: 'Eggs', servings: 1, value: 0.3, beforeExpiry: true, at: D(16) },
  { type: 'cook', key: 'eggs', name: 'Eggs', servings: 1, value: 0.3, beforeExpiry: true, at: D(23) },
  { type: 'cook', key: 'eggs', name: 'Eggs', servings: 1, value: 0.3, beforeExpiry: true, at: D(31) },
  { type: 'cook', key: 'ghost', at: 'not a time' },                                                                 // junk is skipped
];

test('lotValue: the receipt price wins, else cost per serving × initial servings', () => {
  assert.equal(lotValue({ price: 3.5, initial: 8 }, 0.35), 3.5);
  assert.equal(lotValue({ price: '4.20', initial: 8 }, 0.35), 4.2);
  assert.equal(lotValue({ price: null, initial: 8 }, 0.35), 2.8);
  assert.equal(lotValue({ initial: 8 }, 0.35), 2.8);
  assert.equal(lotValue({ price: 'abc', initial: 8 }, 0.35), 2.8);
  assert.equal(lotValue({ price: -1, initial: 8 }, 0.35), 2.8);
  assert.equal(lotValue({ initial: 0 }, 0.35), 0);
  assert.equal(lotValue({ initial: 3 }, undefined), 0);
  assert.equal(lotValue(null, 1), 0);
});

test('this week: used, wasted, cooked, saved, streak', () => {
  const r = summarize({ events: EVENTS, lots, now: NOW, days: 7, costFor });
  assert.deepEqual(r.window, { from: NOW - 7 * DAY, to: NOW });
  assert.deepEqual(r.used, { items: 4, servings: 6, value: 2.44 });          // 1.0 + 0.4 (stock) + 0.6 + 0.4375 (milk at 3.5/8)
  assert.deepEqual(r.wasted, { items: 2, servings: 3, value: 1.3 });         // basil 2 × 0.4 + cream 1 × 0.5
  assert.deepEqual(r.cooked, { meals: 4, titles: ['Risotto', 'Omelette', 'Stir-fry', 'Soup'] });
  assert.equal(r.savedValue, 2.44);
  assert.equal(r.streakDays, 3);                                             // today, yesterday, two days ago; day 3 had basil expire
});

test('weekly: the last four 7-day windows, oldest first', () => {
  const r = summarize({ events: EVENTS, lots, now: NOW, days: 7, costFor });
  assert.equal(r.weekly.length, 4);
  assert.deepEqual(r.weekly.map(w => w.from), [NOW - 28 * DAY, NOW - 21 * DAY, NOW - 14 * DAY, NOW - 7 * DAY]);
  assert.deepEqual(r.weekly.map(w => w.to), [NOW - 21 * DAY, NOW - 14 * DAY, NOW - 7 * DAY, NOW]);
  assert.deepEqual(r.weekly.map(w => [w.used, w.wasted, w.value, w.wastedValue]), [
    [1, 0, 0.3, 0],     // D(23)
    [1, 0, 0.3, 0],     // D(16)
    [1, 1, 1.0, 0.5],   // D(9): tomatoes cooked and tomatoes expired
    [4, 2, 2.44, 1.3],  // this week
  ]);
});

test('month and all time widen the window; the weekly bars stay weekly', () => {
  const month = summarize({ events: EVENTS, lots, now: NOW, days: 30, costFor });
  assert.deepEqual(month.used, { items: 5, servings: 10, value: 4.04 });    // + tomatoes 1.0, eggs 0.3, eggs 0.3
  assert.deepEqual(month.wasted, { items: 3, servings: 4, value: 1.8 });
  assert.equal(month.cooked.meals, 5);
  assert.deepEqual(month.cooked.titles, ['Risotto', 'Omelette', 'Stir-fry', 'Soup', 'Tacos']);
  assert.equal(month.weekly.length, 4);
  assert.deepEqual(month.weekly[3], summarize({ events: EVENTS, lots, now: NOW, days: 7, costFor }).weekly[3]);
  for (const days of ['all', 0, Infinity, null, -1]) {
    const all = summarize({ events: EVENTS, lots, now: NOW, days, costFor });
    assert.deepEqual(all.used, { items: 5, servings: 11, value: 4.34 }, String(days));
    assert.ok(all.window.from < D(31), String(days));
    assert.equal(all.window.to, NOW);
  }
});

test('the window is (from, to]: an event exactly `days` ago is out, one just inside is in', () => {
  const edge = [{ type: 'cook', key: 'eggs', servings: 1, value: 1, beforeExpiry: true, at: NOW - 7 * DAY }];
  assert.equal(summarize({ events: edge, now: NOW, days: 7 }).used.items, 0);
  assert.equal(summarize({ events: edge, now: NOW, days: 8 }).used.items, 1);
  const future = [{ type: 'cook', key: 'eggs', servings: 1, value: 1, beforeExpiry: true, at: NOW + 1 }];
  assert.equal(summarize({ events: future, now: NOW, days: 7 }).used.items, 0);
});

test('streak: a morning with nothing cooked yet counts from yesterday; an expired lot today ends it', () => {
  assert.equal(summarize({ events: EVENTS, now: NOW + DAY, days: 7 }).streakDays, 3);
  const broken = [...EVENTS, { type: 'expired', key: 'milk', servings: 1, at: NOW + DAY - 60_000 }];
  assert.equal(summarize({ events: broken, now: NOW + DAY, days: 7 }).streakDays, 0);
  const today = [...EVENTS, { type: 'expired', key: 'milk', servings: 1, at: NOW - 60_000 }];
  assert.equal(summarize({ events: today, now: NOW, days: 7 }).streakDays, 0);
  // meal-only cook events keep a streak alive too
  const meals = [0, 1, 2, 3, 4].map(k => ({ type: 'cook', title: 'x', at: D(k) }));
  assert.equal(summarize({ events: meals, now: NOW }).streakDays, 5);
});

test('money: an explicit value (even 0) wins over costs; a priced lot beats costFor', () => {
  const ev = [
    { type: 'cook', key: 'milk', servings: 2, value: 0, beforeExpiry: true, at: D(0) },
    { type: 'cook', key: 'milk', servings: 2, beforeExpiry: true, at: D(0) },       // 2 × 3.5/8
    { type: 'cook', key: 'stock', servings: 3, beforeExpiry: true, at: D(0) },      // 3 × 0.4
    { type: 'cook', key: 'unknown', servings: 3, beforeExpiry: true, at: D(0) },    // costFor gives nothing → 0
  ];
  const r = summarize({ events: ev, lots, now: NOW, costFor });
  assert.equal(r.used.value, 2.08);   // 0 + 0.875 + 1.2
  assert.equal(r.used.items, 3);
  // costFor may hand back a nutrition row; its `cost` is used
  const r2 = summarize({ events: ev.slice(2, 3), now: NOW, costFor: () => ({ kcal: 15, cost: 0.4 }) });
  assert.equal(r2.used.value, 1.2);
  // a throwing costFor never breaks the report
  assert.equal(summarize({ events: ev.slice(2, 3), now: NOW, costFor: () => { throw new Error('x'); } }).used.value, 0);
});

test('an empty log gives an honest empty report', () => {
  const r = summarize({ events: [], lots: [], now: NOW, costFor });
  assert.deepEqual(r.used, { items: 0, servings: 0, value: 0 });
  assert.deepEqual(r.wasted, { items: 0, servings: 0, value: 0 });
  assert.deepEqual(r.cooked, { meals: 0, titles: [] });
  assert.equal(r.savedValue, 0);
  assert.equal(r.streakDays, 0);
  assert.equal(r.weekly.length, 4);
  assert.ok(r.weekly.every(w => w.used === 0 && w.wasted === 0 && w.value === 0));
  assert.deepEqual(summarize().used, { items: 0, servings: 0, value: 0 });
  assert.deepEqual(summarize({ events: null, now: NOW }).cooked, { meals: 0, titles: [] });
});

test('lotEvent builds what summarize reads', () => {
  const milk = { key: 'milk', name: 'Milk', initial: 8, price: 3.5, expiry: NOW + DAY };
  const cook = lotEvent('cook', milk, { servings: 2, now: NOW, costPerServing: 0.35, dishId: 'd1' });
  assert.deepEqual(cook, { type: 'cook', key: 'milk', name: 'Milk', servings: 2, value: 0.88, at: NOW, beforeExpiry: true, dishId: 'd1' });
  const stale = { key: 'basil', name: 'Basil', initial: 4, expiry: NOW - DAY };
  const expired = lotEvent('expired', stale, { servings: 1.5, now: NOW, costPerServing: 0.4 });
  assert.deepEqual(expired, { type: 'expired', key: 'basil', name: 'Basil', servings: 1.5, value: 0.6, at: NOW, beforeExpiry: false });
  assert.equal(lotEvent('gone', stale, { servings: 1, now: NOW }).wasted, true);
  assert.equal(lotEvent('gone', stale, { servings: 0.02, now: NOW }).wasted, false);
  assert.equal(lotEvent('gone', stale, { servings: 1, now: NOW, wasted: false }).wasted, false);
  const meal = lotEvent('cook', null, { now: NOW, title: 'Risotto', dishId: 'd1' });
  assert.deepEqual(meal, { type: 'cook', key: undefined, name: undefined, servings: 0, value: 0, at: NOW, dishId: 'd1', title: 'Risotto' });
  // and the round trip: what lotEvent writes, summarize counts
  const r = summarize({ events: [cook, expired, meal], now: NOW, days: 7 });
  assert.deepEqual(r.used, { items: 1, servings: 2, value: 0.88 });
  assert.deepEqual(r.wasted, { items: 1, servings: 1.5, value: 0.6 });
  assert.equal(r.cooked.meals, 1);
});

test('expiredLots and expiringSoon read the pantry lot shape', () => {
  const lot = (id, key, expiryDays, extra = {}) => ({ id, key, name: key, initial: 4, burn: 0, purchase: D(10), deducted: 0, expiry: D(-expiryDays), ...extra });
  const pantry = [
    lot('a', 'basil', -1),                            // expired yesterday, 4 left
    lot('b', 'cream', -2, { wasteLogged: true }),     // already logged
    lot('c', 'milk', -3, { deducted: 4 }),            // expired but empty
    lot('d', 'eggs', 2),
    lot('e', 'spinach', 1),
    lot('f', 'stock', 5),
    lot('g', 'onion', 0.5, { deducted: 4 }),          // nothing left
  ];
  assert.deepEqual(expiredLots(pantry, NOW).map(x => x.id), ['a']);
  assert.deepEqual(expiringSoon(pantry, { now: NOW }).map(x => x.id), ['e', 'd', 'f']);
  assert.deepEqual(expiringSoon(pantry, { now: NOW, limit: 2 }).map(x => x.id), ['e', 'd']);
  assert.deepEqual(expiringSoon(null, { now: NOW }), []);
  assert.deepEqual(expiredLots(undefined, NOW), []);
});
