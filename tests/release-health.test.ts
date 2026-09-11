import assert from 'node:assert/strict';
import test from 'node:test';
import release from '../src/middlewares/release';

test('release health proves database access and returns only the serving revision', async () => {
  let reads = 0;
  const headers: Record<string, string> = {};
  const ctx = { path: '/api/release', method: 'GET', status: 0, body: undefined as unknown, set: (name: string, value: string) => { headers[name] = value; } };
  const handler = release({}, { strapi: { db: { connection: { raw: async () => { reads++; } } } } } as any);
  await handler(ctx as any, async () => assert.fail('release must handle this route'));
  assert.equal(reads, 1);
  assert.equal(ctx.status, 200);
  assert.deepEqual(ctx.body, { status: 'ok', revision: process.env.GTHDF_REVISION || 'development' });
  assert.match(headers['Cache-Control'], /no-store/);
});

test('release health returns an unavailable response without leaking database failures', async () => {
  const headers: Record<string, string> = {};
  const ctx = { path: '/api/release', method: 'GET', status: 0, body: undefined as unknown, set: (name: string, value: string) => { headers[name] = value; } };
  const handler = release({}, { strapi: { db: { connection: { raw: async () => { throw new Error('private database detail'); } } } } } as any);
  await handler(ctx as any, async () => assert.fail('release must handle this route'));
  assert.equal(ctx.status, 503);
  assert.deepEqual(ctx.body, { status: 'unavailable' });
  assert.match(headers['Cache-Control'], /no-store/);
});
