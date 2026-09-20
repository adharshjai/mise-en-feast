import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertTolerant } from '../frontend/shared/store.js';

// A fake PostgREST client that rejects any row naming a column the "project" lacks.
// The error it answers with is the one a real project answers with, verified against
// https://kfzgofybljvahvrxdhav.supabase.co with `price` unmigrated: a WRITE naming a
// missing column never reaches Postgres, so it is PostgREST's own schema-cache error
//   { code: 'PGRST204', message: "Could not find the 'price' column of 'pantry_items' in the schema cache" }
// and NOT Postgres' 42703 "column pantry_items.price does not exist", which is what a
// SELECT of a missing column returns. An earlier version of this test asserted against
// the 42703 wording, so it passed while every real save still threw.
function fakeClient(missing, shape = 'write') {
  const calls = [];
  const reject = (table, c) => shape === 'write'
    ? { code: 'PGRST204', details: null, hint: null, message: `Could not find the '${c}' column of '${table}' in the schema cache` }
    : { code: '42703', details: null, hint: null, message: `column ${table}.${c} does not exist` };
  return {
    calls,
    from: table => ({
      upsert: (rows, opts) => {
        const list = Array.isArray(rows) ? rows : [rows];
        calls.push({ table, rows: list, opts });
        for (const r of list) for (const c of missing) if (c in r) return Promise.resolve({ error: reject(table, c) });
        return Promise.resolve({ error: null });
      },
    }),
  };
}

test('a pantry save survives a column the project has not migrated yet', async () => {
  const client = fakeClient(['price']);
  const rows = [{ id: 'a', name: 'Milk', price: 3.5 }, { id: 'b', name: 'Eggs' }];
  await upsertTolerant(client, 'pantry_items', rows, { onConflict: 'id' });
  assert.equal(client.calls.length, 2);                                   // rejected once, retried without price
  assert.equal('price' in client.calls[1].rows[0], false);
  assert.equal(client.calls[1].rows[1].name, 'Eggs');
  // the column is remembered: the next save does not pay the failed round trip
  await upsertTolerant(client, 'pantry_items', [{ id: 'c', price: 1 }], { onConflict: 'id' });
  assert.equal(client.calls.length, 3);
  assert.equal('price' in client.calls[2].rows[0], false);
});

test('any other error still throws', async () => {
  const client = { from: () => ({ upsert: () => Promise.resolve({ error: { code: '23505', message: 'duplicate key' } }) }) };
  await assert.rejects(() => upsertTolerant(client, 'pantry_items', [{ id: 'x' }], {}), /duplicate/);
});

test('the 42703 wording a select returns is understood too', async () => {
  // A column no earlier test has taught the module about: `missingColumns` is module-level
  // and remembering `price` would hide the round trip this test is here to see.
  const client = fakeClient(['sourced_from'], 'select');
  await upsertTolerant(client, 'pantry_items', [{ id: 'a', name: 'Milk', sourced_from: 'receipt' }], { onConflict: 'id' });
  assert.equal(client.calls.length, 2);
  assert.equal('sourced_from' in client.calls[1].rows[0], false);
});

test('an app_state save survives every column 0006 and 0007 add', async () => {
  // What the live project was actually missing: 0007 whole, and 0006 bar `shopping`.
  const client = fakeClient(['plan', 'plan_at', 'ratings', 'cooked_log', 'events']);
  await upsertTolerant(client, 'app_state', { user_id: 'u1', shopping: [], plan: { a: 1 }, plan_at: 'x', ratings: {}, cooked_log: [], events: [] }, { onConflict: 'user_id' });
  const last = client.calls[client.calls.length - 1].rows[0];
  assert.deepEqual(Object.keys(last).sort(), ['shopping', 'user_id']);   // what the project can hold is still saved
});

test('an error naming no column throws instead of burning the retry budget', async () => {
  // A 42703 whose message cannot be parsed used to yield '' -- which stripped nothing,
  // re-sent the identical payload six times, and only then threw.
  let calls = 0;
  const client = { from: () => ({ upsert: () => { calls++; return Promise.resolve({ error: { code: '42703', message: 'some wording we do not know' } }); } }) };
  await assert.rejects(() => upsertTolerant(client, 'pantry_items', [{ id: 'x' }], {}), /wording/);
  assert.equal(calls, 1);
});
