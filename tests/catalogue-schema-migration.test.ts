import assert from 'node:assert/strict';
import test from 'node:test';

import migration from '../scripts/migrate-catalogue-schema.js';

const {
  buildCatalogueSchemaStatements,
  parseCatalogueSchemaMigrationArguments,
  validateCoordinatePrecision,
  validateMigrationSafety,
} = migration;

test('la migration City convertit explicitement latitude/longitude en double precision', () => {
  const sql = buildCatalogueSchemaStatements().join('\n');
  assert.match(sql, /ALTER COLUMN "latitude" TYPE double precision/);
  assert.match(sql, /ALTER COLUMN "longitude" TYPE double precision/);
  assert.doesNotMatch(sql, /numeric\(10,2\)/i);
});

test('la vérification conserve les décimales utiles des coordonnées', () => {
  assert.doesNotThrow(() => validateCoordinatePrecision([
    { documentId: 'hirson', beforeLatitude: '49.9202', afterLatitude: 49.9202, beforeLongitude: '4.0841', afterLongitude: 4.0841 },
  ]));
  assert.throws(() => validateCoordinatePrecision([
    { documentId: 'hirson', beforeLatitude: '49.9202', afterLatitude: 49.92, beforeLongitude: '4.0841', afterLongitude: 4.08 },
  ]), /précision/);
});

test('apply exige confirmation et référence de sauvegarde', () => {
  const options = parseCatalogueSchemaMigrationArguments(['--apply', '--confirm-apply']);
  assert.throws(() => validateMigrationSafety(options), /sauvegarde/);
  assert.doesNotThrow(() => validateMigrationSafety({
    ...options,
    backupReference: 'pg-backup-2026-08-07T10:00Z',
  }));
});

test('une écriture distante exige la confirmation distante', () => {
  const options = parseCatalogueSchemaMigrationArguments([
    '--remote', '--apply', '--confirm-apply', '--backup-reference', 'backup-123',
  ]);
  assert.throws(() => validateMigrationSafety(options), /confirm-remote/);
});
