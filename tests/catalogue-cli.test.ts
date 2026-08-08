import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  assertCatalogueReadOnlySql,
  assertCatalogueDatabaseTarget,
  loadCatalogueStrapi,
  parseCatalogueArguments,
  resolveCatalogueCodeVersion,
} from '../scripts/catalogue';

test('le fichier CLI exécute réellement son point d’entrée sous le loader TypeScript', () => {
  const result = spawnSync(process.execPath, [
    '--import',
    'tsx',
    resolve(process.cwd(), 'scripts/catalogue.ts'),
    'import',
    '--help',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Catalogue PRD04 — dry-run strict par défaut/);
  assert.match(result.stdout, /npm run catalogue:import/);
});

test('le point d’entrée reste actif tant que sa Promise principale ne s’est pas terminée', () => {
  const sentinel = 'catalogue-unref-compile-sentinel';
  const preloadSource = `
    import Module from 'node:module';

    const originalLoad = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === '@strapi/strapi') {
        return {
          compileStrapi: () => new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('${sentinel}')), 250);
            timeout.unref();
          }),
          createStrapi: () => {
            throw new Error('createStrapi ne doit pas être appelée dans ce test.');
          },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
  `;
  const result = spawnSync(process.execPath, [
    '--import',
    `data:text/javascript,${encodeURIComponent(preloadSource)}`,
    '--import',
    'tsx',
    resolve(process.cwd(), 'scripts/catalogue.ts'),
    'media-gc',
    '--report',
    resolve(process.cwd(), '.tmp/catalogue-entrypoint-liveness-test.json'),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_HOST: '127.0.0.1',
      DATABASE_URL: '',
      POSTGRESQL_ADDON_HOST: '',
      POSTGRESQL_ADDON_URI: '',
    },
  });

  assert.equal(result.status, 1, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, new RegExp(sentinel));
});

test('le parseur conserve toutes les options consécutives avec valeur', () => {
  const hash = 'a'.repeat(64);
  const options = parseCatalogueArguments([
    'apply', '--dataset', 'dataset', '--report', 'report.json', '--confirm-hash', hash, '--operator', 'qa', '--route-key', 'route-test',
  ], '/tmp/catalogue-cli-test');
  assert.equal(options.reportPath, '/tmp/catalogue-cli-test/report.json');
  assert.equal(options.confirmHash, hash);
  assert.equal(options.operator, 'qa');
  assert.equal(options.routeKey, 'route-test');
});

test('le parseur conserve les cibles répétables dans le dry-run', () => {
  const options = parseCatalogueArguments([
    'calculate', '--dataset', 'dataset',
    '--business-key', 'route:FR-A:FR-B',
    '--business-key', 'route:FR-A:FR-C',
    '--municipality-key', 'FR-A',
    '--chapter-slug', 'hirson-guise',
    '--anchor-key', 'anchor:a',
  ], '/tmp/catalogue-cli-test');
  assert.deepEqual(options.target, {
    businessKeys: ['route:FR-A:FR-B', 'route:FR-A:FR-C'],
    municipalityKeys: ['FR-A'],
    chapterSlugs: ['hirson-guise'],
    anchorKeys: ['anchor:a'],
  });
});

test('la CLI CMS autonome exige un dataset explicite hors media-gc', () => {
  assert.throws(() => parseCatalogueArguments(
    ['calculate'],
    '/tmp/catalogue-cli-test',
    {} as NodeJS.ProcessEnv,
  ), /--dataset ou CATALOGUE_DATASET_DIR/);
  assert.equal(parseCatalogueArguments(
    ['calculate'],
    '/tmp/catalogue-cli-test',
    { CATALOGUE_DATASET_DIR: '/srv/catalogue-dataset' } as NodeJS.ProcessEnv,
  ).datasetDirectory, '/srv/catalogue-dataset');
});

test('archive-check et media-gc restent strictement non mutantes', () => {
  assert.throws(() => parseCatalogueArguments(['archive-check', '--apply'], '/tmp/catalogue-cli-test'), /dry-run/);
  assert.throws(() => parseCatalogueArguments([
    'media-gc', '--business-key', 'route:FR-A:FR-B',
  ], '/tmp/catalogue-cli-test'), /n’accepte pas de ciblage/);
  assert.equal(parseCatalogueArguments(['media-gc'], '/tmp/catalogue-cli-test').apply, false);
});

test('la CLI refuse une cible effective distante sans opt-in remote', () => {
  assert.throws(() => assertCatalogueDatabaseTarget({ remote: false, confirmRemote: false, apply: true }, {
    DATABASE_HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://user:secret@prod.example.test/catalogue',
  } as NodeJS.ProcessEnv), /--remote/);
  assert.doesNotThrow(() => assertCatalogueDatabaseTarget({ remote: false, confirmRemote: false, apply: true }, {
    DATABASE_URL: 'postgresql://user:secret@127.0.0.1:55432/catalogue',
  } as NodeJS.ProcessEnv));
});

test('codeVersion contient le commit exact et un hash des sources courantes', () => {
  assert.match(resolveCatalogueCodeVersion(process.cwd(), {} as NodeJS.ProcessEnv), /^commit:[a-f0-9]{40}:src:[a-f0-9]{64}$/);
});

test('le loader dry-run initialise seulement les métadonnées DB sous barrière PostgreSQL read-only', async () => {
  const previousPgOptions = process.env.PGOPTIONS;
  process.env.PGOPTIONS = '-c application_name=catalogue-test';
  const connection = new EventEmitter();
  const calls: string[] = [];
  const app = {
    contentTypes: { city: { uid: 'api::city.city' } },
    components: { route: { uid: 'route.reference-segment' } },
    db: {
      connection,
      metadata: { identifiers: { dialect: 'test' } },
      init: async ({ models }: { models: unknown[] }) => {
        calls.push(`db:init:${models.length}`);
        connection.emit('query', { sql: 'select 1' });
      },
      destroy: async () => { calls.push('db:destroy'); },
    },
    get: (name: string) => {
      assert.equal(name, 'models');
      return { get: () => [{ uid: 'plugin::upload.file' }] };
    },
    register: async () => { calls.push('register'); },
    load: async () => { calls.push('load'); },
    destroy: async () => { calls.push('app:destroy'); },
  };
  try {
    const runtime = await loadCatalogueStrapi(true, {
      compileStrapi: async () => ({ compiled: true }),
      createStrapi: () => app,
      transformContentTypesToModels: (values) => {
        calls.push(`transform:${values.length}`);
        return values;
      },
    });
    assert.equal(runtime.readOnly, true);
    assert.deepEqual(calls, ['register', 'transform:2', 'db:init:3']);
    assert.match(process.env.PGOPTIONS ?? '', /application_name=catalogue-test.*default_transaction_read_only=on/);
    assert.throws(
      () => connection.emit('query', { sql: 'insert into cities (name) values (?)' }),
      /Écriture ou DDL SQL interdite/,
    );
    assert.doesNotThrow(() => connection.emit('query', {
      sql: 'with selected as (select id from cities) select * from selected',
    }));
    await runtime.destroy();
    assert.deepEqual(calls, ['register', 'transform:2', 'db:init:3', 'db:destroy']);
    assert.equal(process.env.PGOPTIONS, '-c application_name=catalogue-test');
  } finally {
    if (previousPgOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previousPgOptions;
  }
});

test('le loader dry-run restaure PGOPTIONS même si le pool Strapi est inaccessible', async () => {
  const previousPgOptions = process.env.PGOPTIONS;
  process.env.PGOPTIONS = '-c application_name=catalogue-failure-test';
  let databaseDestroyCalls = 0;
  const app = {
    db: {
      get connection() {
        throw new Error('pool inaccessible');
      },
      destroy: async () => { databaseDestroyCalls += 1; },
    },
  };
  try {
    await assert.rejects(() => loadCatalogueStrapi(true, {
      compileStrapi: async () => ({ compiled: true }),
      createStrapi: () => app,
      transformContentTypesToModels: () => [],
    }), /pool inaccessible/);
    assert.equal(databaseDestroyCalls, 1);
    assert.equal(process.env.PGOPTIONS, '-c application_name=catalogue-failure-test');
  } finally {
    if (previousPgOptions === undefined) delete process.env.PGOPTIONS;
    else process.env.PGOPTIONS = previousPgOptions;
  }
});

test('la garde dry-run refuse les écritures et DDL, y compris dans un CTE', () => {
  assert.doesNotThrow(() => assertCatalogueReadOnlySql('SELECT * FROM cities'));
  assert.doesNotThrow(() => assertCatalogueReadOnlySql("SELECT current_setting('transaction_read_only')"));
  assert.doesNotThrow(() => assertCatalogueReadOnlySql('SHOW transaction_read_only'));
  assert.doesNotThrow(() => assertCatalogueReadOnlySql('SET search_path TO "public"'));
  assert.doesNotThrow(() => assertCatalogueReadOnlySql('BEGIN'));
  assert.doesNotThrow(() => assertCatalogueReadOnlySql('BEGIN TRANSACTION READ ONLY'));
  assert.throws(() => assertCatalogueReadOnlySql('SET default_transaction_read_only=off'), /interdite/);
  assert.throws(() => assertCatalogueReadOnlySql('SET transaction_read_only=on'), /interdite/);
  assert.throws(() => assertCatalogueReadOnlySql('SET TRANSACTION READ WRITE'), /interdite/);
  assert.throws(() => assertCatalogueReadOnlySql('BEGIN READ WRITE'), /interdite/);
  assert.throws(() => assertCatalogueReadOnlySql('BEGIN TRANSACTION READ WRITE'), /interdite/);
  assert.throws(() => assertCatalogueReadOnlySql(
    "SELECT set_config('default_transaction_read_only', 'off', false)",
  ), /interdite/);
  assert.throws(() => assertCatalogueReadOnlySql(
    "WITH changed AS (SELECT pg_catalog.set_config('transaction_read_only', 'off', true)) SELECT * FROM changed",
  ), /interdite/);
  assert.throws(() => assertCatalogueReadOnlySql('RESET ALL'), /interdite/);
  assert.throws(() => assertCatalogueReadOnlySql('UPDATE cities SET name = ?'), /interdite/);
  assert.throws(() => assertCatalogueReadOnlySql('CREATE TABLE forbidden (id int)'), /interdite/);
  assert.throws(() => assertCatalogueReadOnlySql('SELECT 1; UPDATE cities SET name = ?'), /multi-statements/);
  assert.doesNotThrow(() => assertCatalogueReadOnlySql("SELECT ';' AS separator; -- fin"));
  assert.throws(() => assertCatalogueReadOnlySql(
    'WITH changed AS (DELETE FROM cities RETURNING id) SELECT * FROM changed',
  ), /interdite/);
});
