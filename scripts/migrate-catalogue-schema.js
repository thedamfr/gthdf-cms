#!/usr/bin/env node

'use strict';

const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

function parseCatalogueSchemaMigrationArguments(argv, cwd = process.cwd()) {
  const options = {
    allowSelfSignedTls: false,
    apply: false,
    backupReference: null,
    cleverApp: 'gthdf-cms',
    confirmApply: false,
    confirmRemote: false,
    help: false,
    remote: false,
    reportPath: resolve(cwd, '.tmp/catalogue-schema-migration-report.json'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--dry-run') options.apply = false;
    else if (argument === '--confirm-apply') options.confirmApply = true;
    else if (argument === '--remote') options.remote = true;
    else if (argument === '--confirm-remote') options.confirmRemote = true;
    else if (argument === '--allow-self-signed-tls') options.allowSelfSignedTls = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (['--backup-reference', '--clever-app', '--report'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Une valeur est requise après ${argument}.`);
      index += 1;
      if (argument === '--backup-reference') options.backupReference = value.trim();
      else if (argument === '--clever-app') options.cleverApp = value.trim();
      else options.reportPath = resolve(cwd, value);
    } else throw new Error(`Option inconnue : ${argument}`);
  }
  return options;
}

function validateMigrationSafety(options) {
  if (!options.apply) {
    if (options.confirmApply || options.confirmRemote || options.backupReference) {
      throw new Error('Les confirmations et la sauvegarde ne sont acceptées qu’avec --apply.');
    }
    return;
  }
  if (!options.confirmApply) throw new Error('Une application exige --confirm-apply.');
  if (!String(options.backupReference ?? '').trim()) {
    throw new Error('Une application exige --backup-reference après une sauvegarde PostgreSQL contrôlée.');
  }
  if (options.remote && !options.confirmRemote) {
    throw new Error('Une écriture distante exige --confirm-remote.');
  }
  if (!options.remote && options.confirmRemote) {
    throw new Error('--confirm-remote exige --remote.');
  }
}

function buildCatalogueSchemaStatements() {
  return [
    'ALTER TABLE "cities" ALTER COLUMN "latitude" TYPE double precision USING "latitude"::double precision',
    'ALTER TABLE "cities" ALTER COLUMN "longitude" TYPE double precision USING "longitude"::double precision',
    `DO $catalogue$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'globals'
          AND column_name = 'publish_city_itineraries_to_next'
      ) THEN
        UPDATE "globals"
        SET "publish_city_itineraries_to_next" = false
        WHERE "publish_city_itineraries_to_next" IS NULL;
      END IF;
    END;
    $catalogue$`,
    `CREATE TABLE IF NOT EXISTS "catalogue_apply_locks" (
      "lock_key" text PRIMARY KEY,
      "run_key" text NOT NULL,
      "owner_key" text NOT NULL,
      "acquired_at" timestamptz NOT NULL,
      "expires_at" timestamptz NOT NULL,
      "heartbeat_at" timestamptz NOT NULL
    )`,
    'ALTER TABLE "catalogue_apply_locks" ADD COLUMN IF NOT EXISTS "owner_key" text',
    'UPDATE "catalogue_apply_locks" SET "owner_key" = "run_key" || \'-legacy\' WHERE "owner_key" IS NULL',
    'ALTER TABLE "catalogue_apply_locks" ALTER COLUMN "owner_key" SET NOT NULL',
    'CREATE INDEX IF NOT EXISTS "route_anchors_semantic_source_idx" ON "route_anchors" ("anchor_semantic_key", "source_hash")',
    'CREATE INDEX IF NOT EXISTS "city_itineraries_current_evaluation_idx" ON "city_itineraries" ("current_evaluation_hash")',
    'CREATE INDEX IF NOT EXISTS "itinerary_revisions_source_hash_idx" ON "itinerary_revisions" ("source_hash")',
  ];
}

function validateCoordinatePrecision(samples) {
  for (const sample of samples) {
    const latitudeBefore = Number(sample.beforeLatitude);
    const longitudeBefore = Number(sample.beforeLongitude);
    if (
      !Number.isFinite(latitudeBefore)
      || !Number.isFinite(longitudeBefore)
      || sample.afterLatitude !== latitudeBefore
      || sample.afterLongitude !== longitudeBefore
    ) {
      throw new Error(`La précision des coordonnées de ${sample.documentId ?? 'ville inconnue'} n’est pas conservée.`);
    }
  }
}

function connectionOptions(environment) {
  const connectionString = environment.POSTGRESQL_ADDON_URI || environment.DATABASE_URL;
  const sslEnabled = String(environment.DATABASE_SSL ?? '').toLowerCase() === 'true';
  return {
    ...(connectionString
      ? { connectionString }
      : {
        host: environment.POSTGRESQL_ADDON_HOST || environment.DATABASE_HOST || 'localhost',
        port: Number(environment.POSTGRESQL_ADDON_PORT || environment.DATABASE_PORT || 5432),
        database: environment.POSTGRESQL_ADDON_DB || environment.DATABASE_NAME || 'strapi',
        user: environment.POSTGRESQL_ADDON_USER || environment.DATABASE_USERNAME || 'strapi',
        password: environment.POSTGRESQL_ADDON_PASSWORD || environment.DATABASE_PASSWORD || 'strapi',
      }),
    ...(sslEnabled ? { ssl: { rejectUnauthorized: String(environment.DATABASE_SSL_REJECT_UNAUTHORIZED ?? 'true') !== 'false' } } : {}),
  };
}

async function readColumnTypes(client) {
  const result = await client.query(`
    SELECT column_name AS "columnName", data_type AS "dataType", udt_name AS "udtName"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'cities'
      AND column_name IN ('latitude', 'longitude')
    ORDER BY column_name
  `);
  return result.rows;
}

async function readCoordinateSamples(client) {
  const result = await client.query(`
    SELECT document_id AS "documentId",
      latitude::text AS "beforeLatitude",
      longitude::text AS "beforeLongitude"
    FROM cities
    WHERE latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY document_id
    LIMIT 25
  `);
  return result.rows;
}

async function readGlobalSwitchState(client) {
  const existenceResult = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'globals'
        AND column_name = 'publish_city_itineraries_to_next'
    ) AS "columnExists"
  `);
  if (existenceResult.rows[0]?.columnExists !== true) {
    return {
      columnExists: false,
      totalRows: null,
      nullRows: null,
      falseRows: null,
      trueRows: null,
    };
  }
  const stateResult = await client.query(`
    SELECT
      COUNT(*)::integer AS "totalRows",
      COUNT(*) FILTER (WHERE "publish_city_itineraries_to_next" IS NULL)::integer AS "nullRows",
      COUNT(*) FILTER (WHERE "publish_city_itineraries_to_next" = false)::integer AS "falseRows",
      COUNT(*) FILTER (WHERE "publish_city_itineraries_to_next" = true)::integer AS "trueRows"
    FROM "globals"
  `);
  const row = stateResult.rows[0] ?? {};
  return {
    columnExists: true,
    totalRows: Number(row.totalRows ?? 0),
    nullRows: Number(row.nullRows ?? 0),
    falseRows: Number(row.falseRows ?? 0),
    trueRows: Number(row.trueRows ?? 0),
  };
}

function hashReport(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function runCatalogueSchemaMigration(options, dependencies = {}) {
  validateMigrationSafety(options);
  if (options.remote) {
    const { configureCleverRemoteDatabaseEnvironment } = require('./clever-remote-database');
    configureCleverRemoteDatabaseEnvironment({
      allowSelfSignedTls: options.allowSelfSignedTls,
      cleverApp: options.cleverApp,
      environment: process.env,
    });
  }
  const { Client } = dependencies.pg ?? require('pg');
  const client = dependencies.client ?? new Client(connectionOptions(process.env));
  if (!dependencies.client) await client.connect();
  const report = {
    version: 2,
    mode: options.apply ? 'apply' : 'dry-run',
    remote: options.remote,
    backupReference: options.apply ? options.backupReference : null,
    statements: buildCatalogueSchemaStatements(),
    beforeColumnTypes: [],
    afterColumnTypes: [],
    beforeGlobalSwitchState: null,
    afterGlobalSwitchState: null,
    coordinateSampleCount: 0,
    status: 'pending',
  };
  try {
    report.beforeColumnTypes = await readColumnTypes(client);
    report.beforeGlobalSwitchState = await readGlobalSwitchState(client);
    const before = await readCoordinateSamples(client);
    report.coordinateSampleCount = before.length;
    if (options.apply) {
      await client.query('BEGIN');
      try {
        for (const statement of report.statements) await client.query(statement);
        const afterResult = await client.query(`
          SELECT source.document_id AS "documentId",
            source."beforeLatitude", cities.latitude AS "afterLatitude",
            source."beforeLongitude", cities.longitude AS "afterLongitude"
          FROM jsonb_to_recordset($1::jsonb)
            AS source(document_id text, "beforeLatitude" text, "beforeLongitude" text)
          JOIN cities ON cities.document_id = source.document_id
          ORDER BY source.document_id
        `, [JSON.stringify(before.map((row) => ({
          document_id: row.documentId,
          beforeLatitude: row.beforeLatitude,
          beforeLongitude: row.beforeLongitude,
        })))]);
        validateCoordinatePrecision(afterResult.rows);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    report.afterColumnTypes = await readColumnTypes(client);
    report.afterGlobalSwitchState = await readGlobalSwitchState(client);
    report.status = options.apply ? 'applied' : 'ready_for_review';
    report.reportHash = hashReport(report);
    mkdirSync(dirname(options.reportPath), { recursive: true });
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    if (!dependencies.client) await client.end();
  }
}

function usage() {
  return `Migration du schéma catalogue (dry-run par défaut)

  npm run migrate:catalogue-schema
  npm run migrate:catalogue-schema -- --apply --confirm-apply --backup-reference <référence>
  npm run migrate:catalogue-schema:remote -- --allow-self-signed-tls --apply --confirm-apply --confirm-remote --backup-reference <référence>
`;
}

async function main() {
  const options = parseCatalogueSchemaMigrationArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = await runCatalogueSchemaMigration(options);
  process.stdout.write(`${JSON.stringify({ status: report.status, reportHash: report.reportHash, reportPath: options.reportPath }, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildCatalogueSchemaStatements,
  parseCatalogueSchemaMigrationArguments,
  readGlobalSwitchState,
  runCatalogueSchemaMigration,
  validateCoordinatePrecision,
  validateMigrationSafety,
};
