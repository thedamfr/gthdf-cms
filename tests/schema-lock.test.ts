import assert from 'node:assert/strict';
import test from 'node:test';
import { withSchemaLock } from '../src/infrastructure/schema-lock';

test('schema synchronization waits for the PostgreSQL lock before any schema work', async () => {
  const calls: string[] = [];
  const connection = { transaction: async (callback: (trx: unknown) => Promise<string>) => {
    const result = await callback({ raw: async (sql: string, values: number[]) => {
      assert.equal(sql, 'SELECT pg_advisory_xact_lock(?)');
      assert.deepEqual(values, [0x47544853]);
      calls.push('lock');
    } });
    calls.push('commit');
    return result;
  } };
  const result = await withSchemaLock(connection as any, async () => { calls.push('synchronize'); return 'UNCHANGED'; });
  assert.equal(result, 'UNCHANGED');
  assert.deepEqual(calls, ['lock', 'synchronize', 'commit']);
});

test('a failed lock acquisition prevents schema synchronization', async () => {
  let synchronized = false;
  const failure = new Error('lock unavailable');
  const connection = { transaction: async (callback: (trx: unknown) => Promise<unknown>) => callback({ raw: async () => { throw failure; } }) };
  await assert.rejects(withSchemaLock(connection as any, async () => { synchronized = true; }), failure);
  assert.equal(synchronized, false);
});
