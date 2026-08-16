import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const citySchema = JSON.parse(readFileSync(
  new URL('../src/api/city/content-types/city/schema.json', import.meta.url),
  'utf8'
));

test('the city schema exposes optional bounded direction labels', () => {
  for (const field of ['fromLabel', 'toLabel']) {
    assert.partialDeepStrictEqual(
      citySchema.attributes[field],
      {
        type: 'string',
        maxLength: 180,
      }
    );
    assert.notEqual(citySchema.attributes[field].required, true);
  }
});
