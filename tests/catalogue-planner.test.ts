import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALGORITHM_VERSION,
  distanceWgs84Metres,
  parseOfficialGpx,
} from '../src/domain/catalogue-core';
import {
  computeQualityWarningCodes,
  planCatalogueAnchors,
  validateRouteCityAnchorsForCalculation,
  type RuntimeRoute,
  type RuntimeRouteCity,
} from '../src/services/catalogue-planner';

const SOURCE_HASH = 'a'.repeat(64);

function anchorPlannerFixture(): { route: RuntimeRoute; routeCity: RuntimeRouteCity; edgeLength: number } {
  const document = parseOfficialGpx('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0.5"/><trkpt lat="0" lon="1.5"/></trkseg></trk></gpx>');
  const edgeLength = distanceWgs84Metres(
    { latitude: 0, longitude: 0.5 },
    { latitude: 0, longitude: 1.5 },
  );
  const route: RuntimeRoute = {
    id: 1,
    documentId: 'route-document',
    routeKey: 'route',
    name: 'Route',
    slug: 'route',
    catalogueEnabled: false,
    sourceManifestHash: 'b'.repeat(64),
    segments: [{
      index: 0,
      chapterKey: 'chapter-one',
      chapterId: 10,
      chapterDocumentId: 'chapter-document',
      chapterTitle: 'Chapitre un',
      direction: 'ab',
      sourceSha256: SOURCE_HASH,
      sourceMediaDocumentId: 'source-media-document',
      sourceMediaFingerprint: 'e'.repeat(64),
      document,
      junctionAfter: { status: 'exact', gapMetres: 0, nextSourceSha256: SOURCE_HASH, reviewNote: null },
      primaryAnchors: [{
        municipalityKey: 'FR-00001',
        status: 'validated',
        sourceSha256: SOURCE_HASH,
        trackIndex: 0,
        segmentIndex: 0,
        pointIndex: 0,
        fraction: 0.75,
        chapterChainageMetres: edgeLength * 0.75,
        projectedLatitude: 0,
        projectedLongitude: 1.25,
        distanceToCityMetres: 0,
        algorithmVersion: 'prd03-anchor-v1',
      }],
    }],
  };
  const routeCity: RuntimeRouteCity = {
    id: 2,
    documentId: 'route-city-document',
    routeCityKey: 'route:FR-00001',
    qualificationStatus: 'validated',
    qualificationSourceHash: 'c'.repeat(64),
    expectedOccurrences: 1,
    city: {
      id: 3,
      documentId: 'city-document',
      municipalityKey: 'FR-00001',
      name: 'Ville',
      slug: 'ville',
      latitude: 0,
      longitude: 1.25,
    },
    anchors: [],
  };
  return { route, routeCity, edgeLength };
}

test('le planner réutilise l’ancre AB PRD03 publiée après recomposition exacte', () => {
  const { route, routeCity, edgeLength } = anchorPlannerFixture();
  const plan = planCatalogueAnchors({
    route,
    routeCities: [routeCity],
    dataset: {
      datasetHash: 'd'.repeat(64),
      sourceSha256: 'e'.repeat(64),
      manifest: {},
      cities: [{
        municipalityKey: 'FR-00001',
        countryCode: 'FR',
        municipalityCode: '00001',
        name: 'Ville',
        administrativeArea: 'Test',
        longitude: 1.25,
        latitude: 0,
        coordinateSource: {},
        expectedOccurrences: 1,
        firstChapterLabel: 'Chapitre un',
        firstChainageMetres: edgeLength * 0.75,
        qualificationEvidence: {},
      }],
      chapters: [{ slug: 'chapter-one', label: 'Chapitre un', sourceSha256: SOURCE_HASH, distanceMetres: edgeLength }],
      products: [],
      thresholdQa: [],
    },
    boundarySnapshot: {
      version: 1,
      manifestHash: 'f'.repeat(64),
      features: [{
        municipalityKey: 'FR-00001',
        geometry: {
          type: 'Polygon',
          coordinates: [[[0.5, -0.5], [1.5, -0.5], [1.5, 0.5], [0.5, 0.5], [0.5, -0.5]]],
        },
      }],
    },
    codeVersion: 'test-code',
  });
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].origin, 'prd03_primary');
  assert.equal(plan.operations[0].validationStatus, 'proposed');
  assert.equal(plan.operations[0].fraction, 0.75);
});

test('calculate bloque une ancre validée dont le chaînage ne se recompose pas depuis le GPX', () => {
  const { route, routeCity, edgeLength } = anchorPlannerFixture();
  const validAnchor = {
    id: 4,
    documentId: 'anchor-document',
    anchorKey: `route:FR-00001:occurrence:0:${SOURCE_HASH}`,
    anchorSemanticKey: 'route:FR-00001:occurrence:0',
    occurrenceIndex: 0,
    routeSegmentIndex: 0,
    chapterId: 10,
    chapterDocumentId: 'chapter-document',
    sourceSha256: SOURCE_HASH,
    trackIndex: 0,
    segmentIndex: 0,
    pointIndex: 0,
    fraction: 0.75,
    chainageMetres: edgeLength * 0.75,
    projectedLatitude: 0,
    projectedLongitude: 1.25,
    distanceToTraceMetres: 0,
    algorithmVersion: ALGORITHM_VERSION.projection,
    sourceDirection: 'ab' as const,
    origin: 'prd03_primary' as const,
    status: 'validated' as const,
  };
  routeCity.anchors = [validAnchor];
  assert.equal(validateRouteCityAnchorsForCalculation(route, routeCity)[0].anchorKey, validAnchor.anchorKey);
  routeCity.anchors = [{ ...validAnchor, chainageMetres: validAnchor.chainageMetres + 1 }];
  assert.throws(() => validateRouteCityAnchorsForCalculation(route, routeCity), /chaînage/);
});

test('les contrôles qualité couvrent les seuils, détours, commerces et écarts éditoriaux', () => {
  const warnings = computeQualityWarningCodes({
    distanceMetres: 499,
    directMetres: 50,
    eligibleByRoute: true,
    eligibleByDirect: true,
    usesLoopOrigin: true,
    acceptedGapCount: 1,
    multiOccurrence: true,
    directConverged: false,
    departureShopOverTwoKilometres: true,
    arrivalShopOverTwoKilometres: true,
    baselineDistanceDeltaMetres: 2,
    baselineDirectDeltaMetres: -2,
    baselinePresent: true,
    differences: ['direction_changed', 'slug_diff', 'title_diff'],
  });

  for (const code of [
    'route_under_500m',
    'detour_ratio_over_2',
    'detour_ratio_over_3',
    'detour_ratio_over_5',
    'uses_loop_origin',
    'accepted_gap',
    'multiple_occurrences',
    'departure_shop_over_2km',
    'arrival_shop_over_2km',
    'vincenty_non_convergence',
    'baseline_route_distance_diff',
    'baseline_direct_distance_diff',
    'direction_changed',
    'slug_diff',
    'title_diff',
  ]) assert.ok(warnings.includes(code), `${code} doit être signalé`);
  assert.deepEqual(warnings, [...warnings].sort());
  assert.equal(new Set(warnings).size, warnings.length);
});

test('le critère direct seul et un produit absent de la baseline imposent une revue', () => {
  const warnings = computeQualityWarningCodes({
    distanceMetres: 75_000,
    directMetres: 39_000,
    eligibleByRoute: false,
    eligibleByDirect: true,
    usesLoopOrigin: false,
    acceptedGapCount: 0,
    multiOccurrence: false,
    directConverged: true,
    departureShopOverTwoKilometres: false,
    arrivalShopOverTwoKilometres: false,
    baselineDistanceDeltaMetres: null,
    baselineDirectDeltaMetres: null,
    baselinePresent: false,
    differences: [],
  });

  assert.ok(warnings.includes('direct_only'));
  assert.ok(warnings.includes('baseline_product_missing'));
});

test('une différence de baseline inférieure ou égale à un centimètre reste stable', () => {
  const warnings = computeQualityWarningCodes({
    distanceMetres: 20_000,
    directMetres: 10_000,
    eligibleByRoute: true,
    eligibleByDirect: true,
    usesLoopOrigin: false,
    acceptedGapCount: 0,
    multiOccurrence: false,
    directConverged: true,
    departureShopOverTwoKilometres: false,
    arrivalShopOverTwoKilometres: false,
    baselineDistanceDeltaMetres: 0.01,
    baselineDirectDeltaMetres: -0.01,
    baselinePresent: true,
    differences: [],
  });

  assert.equal(warnings.includes('baseline_route_distance_diff'), false);
  assert.equal(warnings.includes('baseline_direct_distance_diff'), false);
});
