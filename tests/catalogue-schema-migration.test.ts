import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import migration from '../scripts/migrate-catalogue-schema.js';

const {
  buildCatalogueSchemaStatements,
  parseCatalogueSchemaMigrationArguments,
  runCatalogueSchemaMigration,
  validateCoordinatePrecision,
  validateMigrationSafety,
} = migration;

test('la migration City convertit explicitement latitude/longitude en double precision', () => {
  const sql = buildCatalogueSchemaStatements().join('\n');
  assert.match(sql, /ALTER COLUMN "latitude" TYPE double precision/);
  assert.match(sql, /ALTER COLUMN "longitude" TYPE double precision/);
  assert.doesNotMatch(sql, /numeric\(10,2\)/i);
});

test('la migration matérialise uniquement les switches Global NULL avec les noms SQL Strapi réels', () => {
  const sql = buildCatalogueSchemaStatements().join('\n');
  assert.match(sql, /table_name = 'globals'/);
  assert.match(sql, /column_name = 'publish_city_itineraries_to_next'/);
  assert.match(sql, /UPDATE "globals"\s+SET "publish_city_itineraries_to_next" = false\s+WHERE "publish_city_itineraries_to_next" IS NULL;/);
  assert.doesNotMatch(sql, /WHERE "publish_city_itineraries_to_next" = (?:true|false)/);
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

test('le rapport apply trace le backfill Global avant/après sans altérer les booléens existants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'catalogue-schema-migration-'));
  const reportPath = join(directory, 'report.json');
  let globalSwitchApplied = false;
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes('UPDATE "globals"') && sql.includes('IS NULL')) {
        globalSwitchApplied = true;
        return { rows: [] };
      }
      if (sql.includes("table_name = 'cities'")) {
        return {
          rows: [
            { columnName: 'latitude', dataType: 'double precision', udtName: 'float8' },
            { columnName: 'longitude', dataType: 'double precision', udtName: 'float8' },
          ],
        };
      }
      if (sql.includes("table_name = 'globals'")) return { rows: [{ columnExists: true }] };
      if (sql.includes('COUNT(*)::integer AS "totalRows"')) {
        return {
          rows: [globalSwitchApplied
            ? { totalRows: 4, nullRows: 0, falseRows: 3, trueRows: 1 }
            : { totalRows: 4, nullRows: 2, falseRows: 1, trueRows: 1 }],
        };
      }
      if (sql.includes('latitude::text AS "beforeLatitude"')) return { rows: [] };
      return { rows: [] };
    },
  };

  try {
    const options = {
      ...parseCatalogueSchemaMigrationArguments([
        '--apply', '--confirm-apply', '--backup-reference', 'backup-test',
      ]),
      reportPath,
    };
    const report = await runCatalogueSchemaMigration(options, { client });
    const writtenReport = JSON.parse(readFileSync(reportPath, 'utf8'));

    assert.equal(report.version, 2);
    assert.deepEqual(report.beforeGlobalSwitchState, {
      columnExists: true,
      totalRows: 4,
      nullRows: 2,
      falseRows: 1,
      trueRows: 1,
    });
    assert.deepEqual(report.afterGlobalSwitchState, {
      columnExists: true,
      totalRows: 4,
      nullRows: 0,
      falseRows: 3,
      trueRows: 1,
    });
    assert.deepEqual(writtenReport.afterGlobalSwitchState, report.afterGlobalSwitchState);
    assert.equal(queries.filter((sql) => sql.includes('UPDATE "globals"')).length, 1);
  } finally {
    await rm(directory, { recursive: true });
  }
});
