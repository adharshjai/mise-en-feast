import test from 'node:test';
import assert from 'node:assert/strict';
import { keepUnsaved, readUnsaved, clearUnsaved, parkedWins, UNSAVED_KEY } from '../frontend/shared/store.js';

// store.js reaches for a bare `localStorage`, so a global stands in for the browser's.
function fakeStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: k => { map.delete(k); },
  };
  return map;
}

const lot = (id, name) => ({ id, name, key: name.toLowerCase(), qty: '1', raw: '', initial: 10, purchase: 1, expiry: 2, burn: 1, deducted: 0 });
const stateWith = (...lots) => ({ pantry: lots, skipped: [], cooked: [], chosen: [] });

test('a save the project would not take comes back on the next load', () => {
  fakeStorage();
  keepUnsaved('user-1', stateWith(lot('a', 'Cereal'), lot('b', 'Eggs')));
  const back = readUnsaved('user-1');
  assert.equal(back.pantry.length, 2);
  assert.deepEqual(back.pantry.map(it => it.name), ['Cereal', 'Eggs']);
});

test('a parked pantry never leaks to the other account in the same browser', () => {
  fakeStorage();
  keepUnsaved('user-1', stateWith(lot('a', 'Cereal')));
  assert.equal(readUnsaved('user-2'), null);
  assert.equal(readUnsaved(''), null);
  assert.equal(readUnsaved(undefined), null);
  assert.equal(readUnsaved('user-1').pantry.length, 1);
});

test('once the save lands the parked copy is dropped', () => {
  const map = fakeStorage();
  keepUnsaved('user-1', stateWith(lot('a', 'Cereal')));
  assert.equal(map.has(UNSAVED_KEY), true);
  clearUnsaved();
  assert.equal(readUnsaved('user-1'), null);
});

test('the parked copy wins only while it holds a lot the project has never seen', () => {
  const two = stateWith(lot('a', 'Cereal'), lot('b', 'Eggs'));
  // the save never landed: the project has nothing, or not these lots
  assert.equal(parkedWins(two, null), true);
  assert.equal(parkedWins(two, stateWith(lot('a', 'Cereal'))), true);
  // the save did land: leave the project's copy alone
  assert.equal(parkedWins(two, two), false);
  assert.equal(parkedWins(two, stateWith(lot('a', 'Cereal'), lot('b', 'Eggs'), lot('c', 'Rice'))), false);
  // the case a count comparison gets wrong: a receipt added two lots while two were cleared,
  // so the counts match but none of the park's food is on the server.
  assert.equal(parkedWins(two, stateWith(lot('x', 'Rice'), lot('y', 'Beans'))), true);
  // a pantry emptied on another device must not be refilled by a stale park
  assert.equal(parkedWins(stateWith(), stateWith()), false);
  assert.equal(parkedWins(stateWith(), null), false);
  assert.equal(parkedWins(null, null), false);
});

test('a park too old to trust is left alone', () => {
  const one = stateWith(lot('a', 'Cereal'));
  assert.equal(parkedWins(one, null, Date.now() - 86400000), true);        // yesterday: rescue it
  assert.equal(parkedWins(one, null, Date.now() - 30 * 86400000), false);  // a month: too stale
  assert.equal(parkedWins(one, null, 0), true);                            // no timestamp: no bound
});

test('readUnsaved reports when the copy was parked', () => {
  fakeStorage();
  keepUnsaved('user-1', stateWith(lot('a', 'Cereal')), 1);
  const back = readUnsaved('user-1');
  assert.equal(typeof back.parkedAt, 'number');
  assert.equal(back.parkedAt > 0, true);
});

test('unreadable or foreign storage is not fatal', () => {
  globalThis.localStorage = { getItem: () => 'not json', setItem: () => {}, removeItem: () => {} };
  assert.equal(readUnsaved('user-1'), null);
  globalThis.localStorage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} };
  assert.equal(readUnsaved('user-1'), null);
  keepUnsaved('user-1', stateWith(lot('a', 'Cereal')));   // must not throw
  delete globalThis.localStorage;
});

test('an earlier save landing does not clear a later save still waiting to go out', () => {
  fakeStorage();
  keepUnsaved('user-1', stateWith(lot('a', 'Cereal')), 1);
  keepUnsaved('user-1', stateWith(lot('a', 'Cereal'), lot('b', 'Eggs')), 2);   // a newer edit parks over it
  clearUnsaved(1);                                                            // save #1 lands
  const still = readUnsaved('user-1');
  assert.equal(still.pantry.length, 2, 'save #2 is still parked');
  clearUnsaved(2);                                                            // then #2 lands
  assert.equal(readUnsaved('user-1'), null);
});

test('clearUnsaved with no sequence drops whatever is parked (sign-out)', () => {
  fakeStorage();
  keepUnsaved('user-1', stateWith(lot('a', 'Cereal')), 7);
  clearUnsaved();
  assert.equal(readUnsaved('user-1'), null);
});
