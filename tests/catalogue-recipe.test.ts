import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLocalRecipeEnvironment,
  assertLocalRecipeStorageEnvironment,
  buildLocalFixtureRouteArtifacts,
  configureLocalRecipeConnectionPool,
  ensureLocalFixtureRedirect,
  LOCAL_FIXTURE_REDIRECT_SLUG,
  parseRecipeArguments,
  requireLocalFixtureMediaId,
  restoreLocalFixtureFingerprints,
} from '../scripts/catalogue-recipe';
import {
  parseOfficialGpx,
  recomposeRouteAnchorPosition,
  sha256Hex,
} from '../src/domain/catalogue-core';

const localRecipeEnvironment = {
  NODE_ENV: 'development',
  DATABASE_CLIENT: 'postgres',
  DATABASE_URL: 'postgresql://gthdf:secret@127.0.0.1:55432/gthdf_catalogue',
  AWS_ENDPOINT: 'http://127.0.0.1:59000',
  AWS_CDN_URL: 'http://127.0.0.1:59000/gthdf-catalogue-media',
  AWS_BUCKET: 'gthdf-catalogue-media',
} as NodeJS.ProcessEnv;

test('la recette reste en dry-run et exige une double confirmation locale', () => {
  assert.deepEqual(parseRecipeArguments([]), { apply: false, confirmed: false, businessKey: null });
  assert.throws(() => parseRecipeArguments(['--apply']), /confirm-local-recipe/);
  assert.deepEqual(parseRecipeArguments(['--apply', '--confirm-local-recipe']), {
    apply: true,
    confirmed: true,
    businessKey: null,
  });
});

test('la recette refuse toutes les variantes de base distante effectivement prioritaires', () => {
  assert.doesNotThrow(() => assertLocalRecipeEnvironment(localRecipeEnvironment));
  assert.throws(() => assertLocalRecipeEnvironment({
    NODE_ENV: 'development',
    DATABASE_CLIENT: 'postgres',
    DATABASE_HOST: '127.0.0.1',
    DATABASE_URL: 'postgresql://user:secret@database.example.test/gthdf',
  } as NodeJS.ProcessEnv), /non locale/);
  assert.throws(() => assertLocalRecipeEnvironment({
    NODE_ENV: 'development',
    DATABASE_CLIENT: 'postgres',
    DATABASE_HOST: '127.0.0.1',
    POSTGRESQL_ADDON_HOST: 'addon.example.test',
  } as NodeJS.ProcessEnv), /non locale/);
  assert.throws(() => assertLocalRecipeEnvironment({
    ...localRecipeEnvironment,
    POSTGRESQL_ADDON_HOST: 'addon.example.test',
  }), /non locale/);
  assert.throws(() => assertLocalRecipeEnvironment({
    ...localRecipeEnvironment,
    DATABASE_HOST: 'database.example.test',
  }), /non locale/);
  assert.throws(() => assertLocalRecipeEnvironment({
    NODE_ENV: 'production',
    DATABASE_CLIENT: 'postgres',
    DATABASE_HOST: '127.0.0.1',
  } as NodeJS.ProcessEnv), /production/);
  assert.throws(() => assertLocalRecipeEnvironment({
    ...localRecipeEnvironment,
    DATABASE_CLIENT: 'sqlite',
  }), /DATABASE_CLIENT=postgres/);
});

test('la recette refuse un stockage ou CDN qui ne correspond pas au MinIO isolé', () => {
  assert.doesNotThrow(() => assertLocalRecipeStorageEnvironment(localRecipeEnvironment));
  assert.throws(() => assertLocalRecipeStorageEnvironment({
    ...localRecipeEnvironment,
    AWS_ENDPOINT: 'https://s3.example.test',
  }), /MinIO en HTTP loopback/);
  assert.throws(() => assertLocalRecipeStorageEnvironment({
    ...localRecipeEnvironment,
    AWS_CDN_URL: 'https://cdn.example.test/gthdf-catalogue-media',
  }), /CDN MinIO loopback/);
  assert.throws(() => assertLocalRecipeStorageEnvironment({
    ...localRecipeEnvironment,
    AWS_BUCKET: 'gthdf-media-production',
  }), /bucket MinIO local/);
  assert.throws(() => assertLocalRecipeStorageEnvironment({
    ...localRecipeEnvironment,
    CELLAR_ADDON_HOST: 'cellar.example.test',
  }), /Cellar distante/);
});

test('les dix GPX synthétiques sont déterministes, jointifs et rendent les ancres recomposables', () => {
  const first = buildLocalFixtureRouteArtifacts();
  const second = buildLocalFixtureRouteArtifacts();
  assert.equal(first.sources.length, 10);
  assert.deepEqual(
    first.sources.map((source) => source.sha256),
    second.sources.map((source) => source.sha256),
  );
  first.sources.forEach((source, index) => {
    assert.equal(sha256Hex(source.bytes), source.sha256);
    assert.deepEqual(source.end, first.sources[(index + 1) % first.sources.length].start);
  });

  const route = first.sources.map((source, index) => ({
    index,
    chapterKey: `fixture-${index + 1}`,
    sourceSha256: source.sha256,
    document: parseOfficialGpx(source.text),
    junctionAfter: {
      status: 'exact' as const,
      gapMetres: 0,
      nextSourceSha256: first.sources[(index + 1) % first.sources.length].sha256,
    },
  }));
  first.anchors.forEach((seed, index) => {
    const source = first.sources[seed.sourceSegmentIndex];
    const recomposed = recomposeRouteAnchorPosition({
      route,
      anchor: {
        anchorKey: `fixture-anchor-${index}`,
        routeSegmentIndex: seed.sourceSegmentIndex,
        sourceSha256: source.sha256,
        trackIndex: 0,
        segmentIndex: 0,
        pointIndex: seed.sourcePointIndex,
        fraction: seed.sourceFraction,
        chainageMetres: seed.chainageMetres,
        projectedLatitude: seed.projectedLatitude,
        projectedLongitude: seed.projectedLongitude,
        status: 'validated',
      },
      cityPoint: {
        latitude: seed.projectedLatitude,
        longitude: seed.projectedLongitude,
      },
      storedDistanceToTraceMetres: 0,
    });
    assert.ok(Math.abs(recomposed.chainageMetres - seed.chainageMetres) < 0.001);
    assert.ok((recomposed.distanceToTraceMetres ?? Infinity) < 0.001);
  });
});

test('les relations média de la fixture exigent un id numérique Strapi', () => {
  assert.equal(requireLocalFixtureMediaId({ id: 42, documentId: 'media-doc' }, 'test'), 42);
  assert.throws(
    () => requireLocalFixtureMediaId({ documentId: 'media-doc' }, 'test'),
    /id numérique Strapi/,
  );
  assert.throws(() => requireLocalFixtureMediaId({ id: 0 }, 'test'), /id numérique Strapi/);
});

test('la redirection locale est créée une fois puis réparée sans changer de document', async () => {
  const records: any[] = [];
  let createCount = 0;
  const redirects = {
    findMany: async ({ filters }: any) => records.filter(
      (record) => record.oldSlug === filters.oldSlug.$eq,
    ),
    create: async ({ data }: any) => {
      createCount += 1;
      const record = { documentId: 'redirect-document', ...data };
      records.push(record);
      return record;
    },
    update: async ({ documentId, data }: any) => {
      const record = records.find((candidate) => candidate.documentId === documentId);
      Object.assign(record, data);
      return record;
    },
  };
  const app = {
    documents: (uid: string) => {
      assert.equal(uid, 'api::itinerary-slug-redirect.itinerary-slug-redirect');
      return redirects;
    },
  };

  const first = await ensureLocalFixtureRedirect(app, { documentId: 'itinerary-document' });
  first.enabled = false;
  first.itinerary = 'ancienne-cible';
  const second = await ensureLocalFixtureRedirect(app, { documentId: 'itinerary-document' });

  assert.equal(createCount, 1);
  assert.equal(records.length, 1);
  assert.equal(second.documentId, first.documentId);
  assert.equal(second.oldSlug, LOCAL_FIXTURE_REDIRECT_SLUG);
  assert.equal(second.itinerary, 'itinerary-document');
  assert.equal(second.enabled, true);
});

test('la recette réserve assez de connexions pour les publications relationnelles', () => {
  const environment = { DATABASE_POOL_MAX: '3' } as NodeJS.ProcessEnv;
  configureLocalRecipeConnectionPool(environment);
  assert.equal(environment.DATABASE_POOL_MAX, '10');
  const alreadySized = { DATABASE_POOL_MAX: '12' } as NodeJS.ProcessEnv;
  configureLocalRecipeConnectionPool(alreadySized);
  assert.equal(alreadySized.DATABASE_POOL_MAX, '12');
});

test('la fixture restaure les fingerprints après la dernière mutation source', async () => {
  const writes: Array<{ uid: string; method: string; input: unknown }> = [];
  const app = { db: { query: (uid: string) => ({
    updateMany: async (input: unknown) => { writes.push({ uid, method: 'updateMany', input }); },
    update: async (input: unknown) => { writes.push({ uid, method: 'update', input }); },
  }) } };
  await restoreLocalFixtureFingerprints(app, 'route-doc', 'f'.repeat(64), [
    { id: 1, routeCityKey: 'route:FR-A' },
    { id: 2, routeCityKey: 'route:FR-B' },
  ]);
  assert.equal(writes[0].uid, 'api::reference-route.reference-route');
  assert.equal(writes[0].method, 'updateMany');
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.slice(1).map((write: any) => write.input.where.id), [1, 2]);
});
