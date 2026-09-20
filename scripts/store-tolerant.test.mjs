import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertTolerant } from '../frontend/shared/store.js';

// A fake PostgREST client that rejects any row naming a column the "project" lacks.
function fakeClient(missing) {
  const calls = [];
  return {
    calls,
    from: table => ({
      upsert: (rows, opts) => {
        const list = Array.isArray(rows) ? rows : [rows];
        calls.push({ table, rows: list, opts });
        for (const r of list) for (const c of missing) if (c in r) return Promise.resolve({ error: { code: '42703', message: `column ${table}.${c} does not exist` } });
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
