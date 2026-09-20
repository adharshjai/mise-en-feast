/* mise en feast — the kitchen report's maths (pure ESM: no DOM, no Date.now()).

   The app keeps a log of what happened to each lot: cooked, checked in, marked gone,
   found expired. This module turns that log into "9 items used before expiring,
   ~$14 saved" for a window of days, plus the four-week bars and the no-waste streak.
   Every function takes `now` so a test can pin the clock and the UI can pass the
   same instant to every call of one render.

   Events (written by the app; see BRIEF2 J5):
     { type: 'cook'|'checkin'|'gone'|'expired'|'added', key, name, servings, value, at,
       beforeExpiry?, wasted?, dishId?, title? }
     A `cook` event WITH a `key` is one lot's servings going into a dish; a `cook`
     event WITHOUT a key is the meal itself ({ type: 'cook', title, dishId? }), which
     is what "Meals cooked" counts.

   Money is an estimate: `value` on an event wins; otherwise servings × the lot's
   receipt price per serving when a priced lot of that key exists, else costFor(key). */

import { currentAmount, OUT } from './pantry-model.js';

export const DAY = 86400000;
const WEEK = 7 * DAY;

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = v => Math.round(num(v) * 100) / 100;

/** What a lot is worth: its receipt price when it has one, else cost per serving × its initial servings. */
export function lotValue(lot, costPerServing) {
  if (!lot) return 0;
  const price = Number(lot.price);
  if (lot.price != null && lot.price !== '' && Number.isFinite(price) && price >= 0) return round2(price);
  return round2(num(costPerServing) * Math.max(0, num(lot.initial)));
}

/* ---------- classifying events ---------- */

const isLotCook = e => e.type === 'cook' && !!e.key;
const isMeal = e => e.type === 'cook' && !e.key;
// Used before expiring: a cook or check-in that the event says happened in date. An event
// with no `beforeExpiry` at all (a lot with no expiry) counts as in date.
const isUsed = e => (isLotCook(e) || e.type === 'checkin') && e.beforeExpiry !== false && num(e.servings) > 0;
const isWasted = e => (e.type === 'expired' || (e.type === 'gone' && e.wasted === true)) && num(e.servings) > 0;
const keyOf = e => String(e.key || e.name || '').toLowerCase().trim();

// Local calendar day of a timestamp, so "today" is the cook's today, not UTC's.
function dayKey(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function previousDay(at) {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12).getTime();
}

/* ---------- money ---------- */

// Cost of one serving of `key`: a priced lot's price spread over its initial servings,
// else the catalog's typical cost. Memoised per summarize() call.
function perServingCostFn(lots, costFor) {
  const priced = new Map();
  for (const lot of Array.isArray(lots) ? lots : []) {
    if (!lot || !lot.key) continue;
    const k = String(lot.key).toLowerCase();
    if (priced.has(k)) continue;
    const price = Number(lot.price), initial = num(lot.initial);
    if (lot.price != null && lot.price !== '' && Number.isFinite(price) && price >= 0 && initial > 0) priced.set(k, price / initial);
  }
  const cache = new Map();
  return key => {
    if (cache.has(key)) return cache.get(key);
    let c = priced.get(key);
    if (c == null) {
      try { c = typeof costFor === 'function' ? costFor(key) : 0; } catch { c = 0; }
      if (c && typeof c === 'object') c = c.cost;   // a nutrition row was passed through
    }
    c = Math.max(0, num(c));
    cache.set(key, c);
    return c;
  };
}

function eventValue(e, perServing) {
  if (e.value != null && e.value !== '' && Number.isFinite(Number(e.value))) return Math.max(0, Number(e.value));
  return num(e.servings) * perServing(keyOf(e));
}

function tally(events, pick, perServing) {
  const keys = new Set();
  let servings = 0, value = 0;
  for (const e of events) {
    if (!pick(e)) continue;
    keys.add(keyOf(e));
    servings += num(e.servings);
    value += eventValue(e, perServing);
  }
  return { items: keys.size, servings: round2(servings), value: round2(value) };
}

/* ---------- the summary ---------- */

/**
 * The report for the `days` ending at `now` (rolling, so "this week" is the last seven
 * days). `days` that is not a positive number means all time.
 * Returns:
 *   { window: { from, to },                      ms timestamps; events with from < at <= to count
 *     used:   { items, servings, value },        cook + checkin events in date (distinct keys, sum, $)
 *     wasted: { items, servings, value },        expired events + gone events flagged wasted
 *     cooked: { meals, titles },                 meal events; titles unique, newest first
 *     savedValue,                                = used.value
 *     streakDays,                                consecutive days ending today with a cook and no expired event
 *     weekly: [{ from, to, used, wasted, value, wastedValue }] }   last four 7-day windows, oldest first
 * `streakDays` counts today only once something was cooked today; a morning with nothing
 * cooked yet starts the count from yesterday instead of showing 0.
 */
export function summarize({ events = [], lots = [], now, days = 7, costFor } = {}) {
  const list = (Array.isArray(events) ? events : []).filter(e => e && Number.isFinite(Number(e.at)));
  const to = Number.isFinite(Number(now)) ? Number(now) : list.reduce((m, e) => Math.max(m, Number(e.at)), 0);
  const span = Number(days);
  const allTime = !(Number.isFinite(span) && span > 0);
  const from = allTime ? Math.min(to, ...list.map(e => Number(e.at))) - 1 : to - span * DAY;
  const perServing = perServingCostFn(lots, costFor);
  const within = (a, b) => list.filter(e => Number(e.at) > a && Number(e.at) <= b);

  const inWindow = within(from, to);
  const used = tally(inWindow, isUsed, perServing);
  const wasted = tally(inWindow, isWasted, perServing);
  const meals = inWindow.filter(isMeal).sort((a, b) => Number(b.at) - Number(a.at));
  const titles = [];
  for (const e of meals) { const t = String(e.title || '').trim(); if (t && !titles.includes(t)) titles.push(t); }

  // streak: walk back from today over local calendar days
  const cookDays = new Set(), expiredDays = new Set();
  for (const e of list) {
    if (Number(e.at) > to) continue;
    if (e.type === 'cook') cookDays.add(dayKey(e.at));
    if (e.type === 'expired') expiredDays.add(dayKey(e.at));
  }
  let streakDays = 0;
  let cursor = to;
  if (!cookDays.has(dayKey(cursor)) && !expiredDays.has(dayKey(cursor))) cursor = previousDay(cursor);
  while (cookDays.has(dayKey(cursor)) && !expiredDays.has(dayKey(cursor))) {
    streakDays++;
    cursor = previousDay(cursor);
  }

  const weekly = [];
  for (let k = 3; k >= 0; k--) {
    const wTo = to - k * WEEK, wFrom = wTo - WEEK;
    const slice = within(wFrom, wTo);
    const u = tally(slice, isUsed, perServing), w = tally(slice, isWasted, perServing);
    weekly.push({ from: wFrom, to: wTo, used: u.items, wasted: w.items, value: u.value, wastedValue: w.value });
  }

  return {
    window: { from, to },
    used,
    wasted,
    cooked: { meals: meals.length, titles },
    savedValue: used.value,
    streakDays,
    weekly,
  };
}

/* ---------- helpers for the app's event log ---------- */

/**
 * Build one lot event the way summarize() expects it, so the app and the report agree
 * on `value` and `beforeExpiry`. `servings` is what left the lot (or, for 'expired' and
 * 'gone', what was still in it). `costPerServing` is costFor(lot.key).
 */
export function lotEvent(type, lot, { servings, now, costPerServing = 0, dishId, title, wasted } = {}) {
  const s = Math.max(0, num(servings));
  const initial = Math.max(0, num(lot && lot.initial));
  const perServing = initial > 0 ? lotValue(lot, costPerServing) / initial : num(costPerServing);
  const e = {
    type,
    key: lot ? lot.key : undefined,
    name: lot ? lot.name : undefined,
    servings: round2(s),
    value: round2(s * perServing),
    at: num(now),
  };
  if (lot && lot.expiry != null) e.beforeExpiry = num(lot.expiry) > num(now);
  if (dishId != null) e.dishId = dishId;
  if (title != null) e.title = title;
  if (type === 'gone') e.wasted = wasted != null ? !!wasted : s > OUT;
  return e;
}

/** Lots past their expiry with something left that have not been logged as waste yet (the boot sweep). */
export function expiredLots(lots, now) {
  const at = num(now);
  return (Array.isArray(lots) ? lots : []).filter(it => it && !it.wasteLogged && num(it.expiry) < at && currentAmount(it, at) > OUT);
}

/** The `limit` soonest-expiring lots that still have something in them, for "Use these next". */
export function expiringSoon(lots, { now, limit = 5 } = {}) {
  const at = num(now);
  return (Array.isArray(lots) ? lots : [])
    .filter(it => it && currentAmount(it, at) > OUT && num(it.expiry) >= at)
    .sort((a, b) => num(a.expiry) - num(b.expiry) || String(a.name || '').localeCompare(String(b.name || '')))
    .slice(0, Math.max(0, num(limit)));
}
