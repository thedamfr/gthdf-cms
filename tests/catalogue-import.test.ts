import assert from 'node:assert/strict';
import test from 'node:test';

import { CatalogueStrapiAdapter } from '../scripts/catalogue/strapi-adapter';
import type { ControlledCatalogueDataset, CatalogueDatasetCity } from '../src/domain/catalogue-dataset';
import {
  hashImportResultState,
  hashImportTargetState,
  planCatalogueImport,
  roundLegacyCoordinateToTwoDecimals,
  type ImportOperation,
  type RuntimeCity,
  type RuntimeRouteCity,
} from '../src/services/catalogue-planner';

const DATASET_HASH = 'd'.repeat(64);
const SOURCE_HASH = 'e'.repeat(64);
const ROUTE_KEY = 'gthf-main-loop';

function sourceCity(overrides: Partial<CatalogueDatasetCity> = {}): CatalogueDatasetCity {
  return {
    municipalityKey: 'FR-00001',
    countryCode: 'FR',
    municipalityCode: '00001',
    name: 'Ville test',
    administrativeArea: 'Département test',
    latitude: 50.1234,
    longitude: 2.5678,
    coordinateSource: { source: 'controlled-dataset' },
    expectedOccurrences: 1,
    firstChapterLabel: 'chapter-one',
    firstChainageMetres: 100,
    qualificationEvidence: { source: 'controlled-dataset' },
    ...overrides,
  };
}

function dataset(city: CatalogueDatasetCity): ControlledCatalogueDataset {
  return {
    datasetHash: DATASET_HASH,
    sourceSha256: SOURCE_HASH,
    manifest: {},
    cities: [city],
    chapters: [],
    products: [],
    thresholdQa: [],
  };
}

function runtimeCity(source: CatalogueDatasetCity, overrides: Partial<RuntimeCity> = {}): RuntimeCity {
  return {
    id: 1,
    documentId: 'city-document',
    municipalityKey: source.municipalityKey,
    name: source.name,
    slug: 'ville-test',
    countryCode: source.countryCode,
    municipalityCode: source.municipalityCode,
    administrativeArea: source.administrativeArea,
    latitude: source.latitude,
    longitude: source.longitude,
    coordinateSource: source.coordinateSource,
    hasPublicPage: false,
    ...overrides,
  };
}

function cityOperation(source: CatalogueDatasetCity, city: RuntimeCity, routeCities: RuntimeRouteCity[] = []) {
  const report = planCatalogueImport({
    dataset: dataset(source),
    state: {
      route: null,
      cities: [city],
      routeCities,
      chapterContractHash: 'c'.repeat(64),
    },
    routeKey: ROUTE_KEY,
    codeVersion: 'test-code',
  });
  return {
    report,
    operation: report.operations.find((candidate) => candidate.kind === 'upsert_city_route_city')!,
  };
}

function expectedRouteCity(source: CatalogueDatasetCity, city: RuntimeCity): RuntimeRouteCity {
  return {
    id: 2,
    documentId: 'route-city-document',
    routeCityKey: `${ROUTE_KEY}:${source.municipalityKey}`,
    qualificationStatus: 'proposed',
    qualificationSourceHash: DATASET_HASH,
    qualificationEvidence: source.qualificationEvidence,
    expectedOccurrences: source.expectedOccurrences,
    routeKey: ROUTE_KEY,
    reviewNote: 'Proposition importée du lot PRD04; validation humaine requise.',
    city,
    anchors: [],
  };
}

test('l’arrondi historique à deux décimales traite sûrement les demi-unités positives et négatives', () => {
  assert.equal(roundLegacyCoordinateToTwoDecimals(1.005), 1.01);
  assert.equal(roundLegacyCoordinateToTwoDecimals(-1.005), -1.01);
  assert.equal(roundLegacyCoordinateToTwoDecimals(2.675), 2.68);
  assert.equal(roundLegacyCoordinateToTwoDecimals(-2.675), -2.68);
  assert.equal(roundLegacyCoordinateToTwoDecimals(50), 50);
});

test('deux coordonnées exactement arrondies deviennent un enrichissement explicite', () => {
  const source = sourceCity();
  const city = runtimeCity(source, { latitude: 50.12, longitude: 2.57 });
  const { operation } = cityOperation(source, city);

  assert.equal(operation.action, 'enrich');
  assert.equal(operation.coordinateUpgrade, 'legacy_decimal_2');
  assert.deepEqual(operation.differences, ['latitude', 'longitude']);
});

test('une reprise partielle est sûre si l’autre coordonnée est déjà exacte', () => {
  const source = sourceCity({ longitude: 2.5 });
  const city = runtimeCity(source, { latitude: 50.12, longitude: source.longitude });
  const { operation } = cityOperation(source, city);

  assert.equal(operation.action, 'enrich');
  assert.equal(operation.coordinateUpgrade, 'legacy_decimal_2');
  assert.deepEqual(operation.differences, ['latitude']);
});

test('une seule coordonnée arbitraire ferme l’import', () => {
  const source = sourceCity({ longitude: 2.5 });
  const city = runtimeCity(source, { latitude: 50.11, longitude: source.longitude });
  const { operation } = cityOperation(source, city);

  assert.equal(operation.action, 'conflict');
  assert.equal(operation.coordinateUpgrade, undefined);
  assert.deepEqual(operation.differences, ['latitude']);
});

test('une divergence hors latitude/longitude reste un conflit', () => {
  const source = sourceCity();
  const city = runtimeCity(source, {
    administrativeArea: 'Autre département',
    latitude: 50.12,
    longitude: 2.57,
  });
  const { operation } = cityOperation(source, city);

  assert.equal(operation.action, 'conflict');
  assert.equal(operation.coordinateUpgrade, undefined);
  assert.deepEqual(operation.differences, ['administrativeArea', 'latitude', 'longitude']);
});

test('le post-état exact de l’enrichissement devient reuse au dry-run suivant', () => {
  const source = sourceCity();
  const before = runtimeCity(source, { latitude: 50.12, longitude: 2.57 });
  const first = cityOperation(source, before).operation;
  const after = runtimeCity(source);
  const routeCity = expectedRouteCity(source, after);

  assert.equal(first.expectedResultHash, hashImportResultState(after, routeCity));
  const second = cityOperation(source, after, [routeCity]).operation;
  assert.equal(second.action, 'reuse');
  assert.equal(second.coordinateUpgrade, undefined);
  assert.equal(second.expectedTargetHash, hashImportTargetState(after, routeCity));
  assert.equal(second.expectedResultHash, first.expectedResultHash);
});

test('l’adapter remplace les deux coordonnées puis reconnaît le post-état par CAS', async () => {
  const source = sourceCity({ longitude: 2.5 });
  let city = runtimeCity(source, { latitude: 50.12, longitude: source.longitude }) as any;
  let routeCity: any = null;
  const { report, operation } = cityOperation(source, city);
  const writes: Array<{ uid: string; method: string; input: any }> = [];
  const route = { id: 10, documentId: 'route-document', routeKey: ROUTE_KEY };
  const app = {
    documents: (uid: string) => ({
      findMany: async () => {
        if (uid === 'api::city.city') return [city];
        if (uid === 'api::reference-route.reference-route') return [route];
        return [];
      },
      update: async (input: any) => {
        writes.push({ uid, method: 'update', input });
        city = { ...city, ...input.data };
        return city;
      },
      create: async (input: any) => {
        writes.push({ uid, method: 'create', input });
        if (uid === 'api::route-city.route-city') {
          routeCity = {
            id: 2,
            documentId: 'route-city-document',
            ...input.data,
            route,
            city,
          };
        }
        return routeCity;
      },
    }),
    db: {
      transaction: async (callback: (input: { trx: any }) => Promise<unknown>) => callback({
        trx: { raw: async () => ({ rows: [] }) },
      }),
      query: (uid: string) => ({
        findOne: async () => uid === 'api::route-city.route-city' ? routeCity : null,
      }),
    },
  };
  const adapter = new CatalogueStrapiAdapter({
    app,
    dataset: dataset(source),
    boundarySnapshot: {},
    routeKey: ROUTE_KEY,
    codeVersion: 'test-code',
    report,
  } as any);
  (adapter as any).assertSourceUnchangedLightweight = async () => {};
  const input = {
    operation: operation as ImportOperation,
    operationIndex: 1,
    report,
    run: { runKey: 'catalogue:test', status: 'running', cursor: 1, counters: {} },
    expectedInputHash: report.inputHash,
  } as any;

  assert.equal(await adapter.applyOperation(input), 'created');
  assert.deepEqual(writes.find((write) => write.uid === 'api::city.city' && write.method === 'update')?.input, {
    documentId: 'city-document',
    status: 'draft',
    data: { latitude: source.latitude, longitude: source.longitude },
  });
  assert.equal(hashImportResultState(city, {
    ...routeCity,
    routeKey: route.routeKey,
    anchors: [],
  }), operation.expectedResultHash);

  assert.equal(await adapter.applyOperation(input), 'reused');
  assert.equal(writes.filter((write) => write.uid === 'api::city.city' && write.method === 'update').length, 1);
  assert.equal(writes.filter((write) => write.uid === 'api::route-city.route-city' && write.method === 'create').length, 1);
});
