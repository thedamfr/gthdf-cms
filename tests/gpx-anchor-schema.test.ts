import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function readSchema(relativePath: string) {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), 'utf8'));
}

test('GPX geometry fields use double precision storage', () => {
  const anchorSchema = readSchema('../src/components/chapter/gpx-anchor.json');
  const junctionSchema = readSchema('../src/components/chapter/gpx-junction.json');
  const anchorFields = [
    'fraction',
    'chainageMetres',
    'projectedLatitude',
    'projectedLongitude',
    'distanceToCityMetres',
  ];

  for (const field of anchorFields) {
    assert.equal(anchorSchema.attributes[field]?.type, 'float', field);
  }
  assert.equal(junctionSchema.attributes.gapMetres?.type, 'float', 'gapMetres');
});
