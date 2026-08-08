import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALGORITHM_VERSION,
  distanceWgs84Metres,
  parseOfficialGpx,
} from '../src/domain/catalogue-core';
import type {
  CatalogueDatasetProduct,
  CatalogueDatasetThresholdQaRow,
  CatalogueThresholdClassification,
} from '../src/domain/catalogue-dataset';
import { buildBusinessKey } from '../src/domain/catalogue-validation';
import {
  planCatalogueCalculation,
  type CalculationUpsertOperation,
  type ExistingItineraryState,
  type RuntimeAnchor,
  type RuntimeRoute,
  type RuntimeRouteCity,
} from '../src/services/catalogue-planner';

const SOURCE_HASH = 'a'.repeat(64);
const DATASET_HASH = 'b'.repeat(64);
const ROUTE_KEY = 'gthf-main-loop';
const MUNICIPALITY_A = 'FR-10001';
const MUNICIPALITY_B = 'FR-10002';

type FixtureMode = 'eligible' | 'ineligible' | 'selection_error';

function calculationFixture(mode: FixtureMode): {
  route: RuntimeRoute;
  routeCities: RuntimeRouteCity[];
  anchorA: RuntimeAnchor;
  anchorB: RuntimeAnchor;
} {
  const start = { latitude: 50, longitude: 3 };
  const endLongitude = mode === 'eligible' ? 3.03 : mode === 'ineligible' ? 4 : 3;
  const end = { latitude: 50, longitude: endLongitude };
  const fractionB = mode === 'eligible' ? 0.5 : 1;
  const projectedB = {
    latitude: 50,
    longitude: start.longitude + (end.longitude - start.longitude) * fractionB,
  };
  const firstEdgeMetres = distanceWgs84Metres(start, end);
  const document = parseOfficialGpx(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="${start.latitude}" lon="${start.longitude}"><ele>0</ele></trkpt>
    <trkpt lat="${end.latitude}" lon="${end.longitude}"><ele>10</ele></trkpt>
    <trkpt lat="${start.latitude}" lon="${start.longitude}"><ele>0</ele></trkpt>
  </trkseg></trk></gpx>`);
  const segment = {
    index: 0,
    chapterKey: 'chapter-qa',
    chapterId: 1,
    chapterDocumentId: 'chapter-qa-document',
    chapterTitle: 'Chapitre QA',
    sourceSha256: SOURCE_HASH,
    sourceMediaDocumentId: 'gpx-source-document',
    sourceMediaFingerprint: SOURCE_HASH,
    direction: 'ab' as const,
    document,
    junctionAfter: {
      status: 'exact' as const,
      gapMetres: 0,
      nextSourceSha256: SOURCE_HASH,
    },
    primaryAnchors: [],
  };
  const route: RuntimeRoute = {
    id: 1,
    documentId: 'route-document',
    routeKey: ROUTE_KEY,
    name: 'Route QA',
    slug: ROUTE_KEY,
    catalogueEnabled: false,
    sourceManifestHash: DATASET_HASH,
    segments: [segment],
  };

  function runtimeAnchor(municipalityKey: string, fraction: number, chainageMetres: number): RuntimeAnchor {
    const routeCityKey = `${ROUTE_KEY}:${municipalityKey}`;
    const isStart = fraction === 0;
    return {
      id: isStart ? 10 : 20,
      documentId: `anchor-${municipalityKey}`,
      anchorSemanticKey: `${routeCityKey}:occurrence:0`,
      anchorKey: `${routeCityKey}:occurrence:0:${SOURCE_HASH}`,
      occurrenceIndex: 0,
      routeSegmentIndex: 0,
      chapterId: 1,
      chapterDocumentId: segment.chapterDocumentId,
      sourceSha256: SOURCE_HASH,
      trackIndex: 0,
      segmentIndex: 0,
      pointIndex: 0,
      fraction,
      chainageMetres,
      projectedLatitude: 50,
      projectedLongitude: isStart ? start.longitude : projectedB.longitude,
      distanceToTraceMetres: 0,
      status: 'validated',
      algorithmVersion: ALGORITHM_VERSION.projection,
      sourceDirection: 'ab',
      origin: 'computed',
    };
  }

  const anchorA = runtimeAnchor(MUNICIPALITY_A, 0, 0);
  const anchorB = runtimeAnchor(MUNICIPALITY_B, fractionB, firstEdgeMetres * fractionB);
  const cities = [
    { municipalityKey: MUNICIPALITY_A, name: 'Ville A', longitude: start.longitude, anchor: anchorA },
    { municipalityKey: MUNICIPALITY_B, name: 'Ville B', longitude: projectedB.longitude, anchor: anchorB },
  ];
  const routeCities = cities.map((item, index): RuntimeRouteCity => ({
    id: index + 1,
    documentId: `route-city-${index + 1}`,
    routeCityKey: `${ROUTE_KEY}:${item.municipalityKey}`,
    qualificationStatus: 'validated',
    qualificationSourceHash: DATASET_HASH,
    qualificationEvidence: { overTwoKilometresWarning: false },
    expectedOccurrences: 1,
    city: {
      id: index + 1,
      documentId: `city-${index + 1}`,
      municipalityKey: item.municipalityKey,
      name: item.name,
      slug: `ville-${index + 1}`,
      countryCode: 'FR',
      municipalityCode: item.municipalityKey.slice(3),
      latitude: 50,
      longitude: item.longitude,
    },
    anchors: [item.anchor],
  }));
  return { route, routeCities, anchorA, anchorB };
}

function upsertFrom(plan: ReturnType<typeof planCatalogueCalculation>): CalculationUpsertOperation {
  const operation = plan.operations.find((candidate) => candidate.kind === 'upsert_itinerary_revision');
  assert.ok(operation);
  return operation;
}

function productFrom(operation: CalculationUpsertOperation): CatalogueDatasetProduct {
  return {
    productId: `${MUNICIPALITY_A}__${MUNICIPALITY_B}`,
    municipalityKeyA: MUNICIPALITY_A,
    municipalityKeyB: MUNICIPALITY_B,
    slug: operation.slug,
    title: operation.title,
    distanceMetres: operation.distanceMetres,
    directMetres: operation.directMetres,
    retained: true,
  };
}

function classification(eligibleByRoute: boolean, eligibleByDirect: boolean): CatalogueThresholdClassification {
  if (eligibleByRoute && eligibleByDirect) return 'Les deux critères';
  if (eligibleByRoute) return 'Itinéraire uniquement';
  if (eligibleByDirect) return 'Vol d’oiseau uniquement';
  return 'Non retenu';
}

function qaReference(input: {
  product: CatalogueDatasetProduct;
  anchorA: RuntimeAnchor;
  anchorB: RuntimeAnchor;
  eligibleByRoute: boolean;
  eligibleByDirect: boolean;
  shortestPathViaOrigin: boolean;
}): CatalogueDatasetThresholdQaRow {
  const routeMarginMetres = 60_000 - input.product.distanceMetres;
  const directMarginMetres = 40_000 - input.product.directMetres;
  return {
    ...input.product,
    countryCodeA: 'FR',
    municipalityCodeA: '10001',
    inseeCodeA: '10001',
    cityNameA: 'Ville A',
    countryCodeB: 'FR',
    municipalityCodeB: '10002',
    inseeCodeB: '10002',
    cityNameB: 'Ville B',
    eligibleByRoute: input.eligibleByRoute,
    eligibleByDirect: input.eligibleByDirect,
    routeMarginMetres,
    directMarginMetres,
    withinRouteThresholdMargin: Math.abs(routeMarginMetres) <= 250,
    withinDirectThresholdMargin: Math.abs(directMarginMetres) <= 250,
    classification: classification(input.eligibleByRoute, input.eligibleByDirect),
    anchorChapterA: 'Chapitre QA',
    anchorChapterB: 'Chapitre QA',
    anchorChainageMetresA: input.anchorA.chainageMetres,
    anchorChainageMetresB: input.anchorB.chainageMetres,
    shortestPathViaOrigin: input.shortestPathViaOrigin,
    samplingStepMetres: 10,
    nearbyShopA: 'Commerce A',
    nearbyShopB: 'Commerce B',
    shopDistanceToTraceMetresA: 10,
    shopDistanceToTraceMetresB: 20,
    qualityControl: 'QA fixture',
    sourceTraceGpx: 'fixture',
  };
}

function existingItinerary(): ExistingItineraryState {
  return {
    documentId: 'itinerary-existing',
    businessKey: buildBusinessKey(ROUTE_KEY, MUNICIPALITY_A, MUNICIPALITY_B),
    slug: 'ville-a-a-ville-b',
    title: 'Ville A – Ville B à vélo',
    activeRevisionKey: 'revision-existing',
    activeRevisionCalculationStatus: 'ready',
    publicationNext: true,
    revisionKeys: ['revision-existing'],
  };
}

test('le report QA compte une correspondance complète et l’attache à la révision', () => {
  const fixture = calculationFixture('eligible');
  const bootstrap = upsertFrom(planCatalogueCalculation({
    route: fixture.route,
    routeCities: fixture.routeCities,
    baselineHash: DATASET_HASH,
    codeVersion: 'test',
  }));
  const product = productFrom(bootstrap);
  const reference = qaReference({
    product,
    anchorA: fixture.anchorA,
    anchorB: fixture.anchorB,
    eligibleByRoute: bootstrap.eligibleByRoute,
    eligibleByDirect: bootstrap.eligibleByDirect,
    shortestPathViaOrigin: bootstrap.usesLoopOrigin,
  });
  const plan = planCatalogueCalculation({
    route: fixture.route,
    routeCities: fixture.routeCities,
    baselineProducts: [product],
    thresholdQa: [reference],
    baselineHash: DATASET_HASH,
    codeVersion: 'test',
  });
  const operation = upsertFrom(plan);

  assert.deepEqual(operation.thresholdQaComparison, {
    referenceProductId: reference.productId,
    status: 'matched',
    differenceCodes: [],
  });
  assert.equal(operation.qualityWarningCodes.includes('threshold_qa_mismatch'), false);
  assert.equal(plan.summary.thresholdQaCompared, 1);
  assert.equal(plan.summary.thresholdQaMatched, 1);
  assert.equal(plan.summary.thresholdQaDifferences, 0);
  assert.equal(plan.summary.thresholdQaUnavailable, 0);
});

test('une différence QA éligible force une révision warning avec le détail', () => {
  const fixture = calculationFixture('eligible');
  const bootstrap = upsertFrom(planCatalogueCalculation({
    route: fixture.route,
    routeCities: fixture.routeCities,
    baselineHash: DATASET_HASH,
    codeVersion: 'test',
  }));
  const product = productFrom(bootstrap);
  const reference = qaReference({
    product: { ...product, distanceMetres: product.distanceMetres + 1 },
    anchorA: fixture.anchorA,
    anchorB: fixture.anchorB,
    eligibleByRoute: bootstrap.eligibleByRoute,
    eligibleByDirect: bootstrap.eligibleByDirect,
    shortestPathViaOrigin: bootstrap.usesLoopOrigin,
  });
  const plan = planCatalogueCalculation({
    route: fixture.route,
    routeCities: fixture.routeCities,
    baselineProducts: [product],
    thresholdQa: [reference],
    baselineHash: DATASET_HASH,
    codeVersion: 'test',
  });
  const operation = upsertFrom(plan);

  assert.equal(operation.calculationStatus, 'warning');
  assert.ok(operation.qualityWarningCodes.includes('threshold_qa_mismatch'));
  assert.deepEqual(operation.thresholdQaComparison?.differenceCodes, ['route_distance']);
  assert.equal(plan.summary.thresholdQaDifferences, 1);
  assert.equal(plan.summary.thresholdQaReviews, 0);
  assert.equal(plan.summary.warning_threshold_qa_mismatch, 1);
  assert.equal(plan.summary.warningRevisions, 1);
});

test('le résumé rend compte des 70 références entre compared/matched/differences/unavailable', () => {
  const fixture = calculationFixture('eligible');
  const bootstrap = upsertFrom(planCatalogueCalculation({
    route: fixture.route,
    routeCities: fixture.routeCities,
    baselineHash: DATASET_HASH,
    codeVersion: 'test',
  }));
  const product = productFrom(bootstrap);
  const matched = qaReference({
    product,
    anchorA: fixture.anchorA,
    anchorB: fixture.anchorB,
    eligibleByRoute: bootstrap.eligibleByRoute,
    eligibleByDirect: bootstrap.eligibleByDirect,
    shortestPathViaOrigin: bootstrap.usesLoopOrigin,
  });
  const unavailable = Array.from({ length: 69 }, (_, index): CatalogueDatasetThresholdQaRow => {
    const municipalityCodeA = String(30_000 + index * 2);
    const municipalityCodeB = String(30_001 + index * 2);
    return {
      ...matched,
      productId: `FR-${municipalityCodeA}__FR-${municipalityCodeB}`,
      municipalityKeyA: `FR-${municipalityCodeA}`,
      municipalityKeyB: `FR-${municipalityCodeB}`,
      municipalityCodeA,
      inseeCodeA: municipalityCodeA,
      municipalityCodeB,
      inseeCodeB: municipalityCodeB,
    };
  });
  const plan = planCatalogueCalculation({
    route: fixture.route,
    routeCities: fixture.routeCities,
    baselineProducts: [product],
    thresholdQa: [matched, ...unavailable],
    baselineHash: DATASET_HASH,
    codeVersion: 'test',
  });

  assert.equal(plan.summary.thresholdQaCompared, 1);
  assert.equal(plan.summary.thresholdQaMatched, 1);
  assert.equal(plan.summary.thresholdQaDifferences, 0);
  assert.equal(plan.summary.thresholdQaUnavailable, 69);
  assert.equal(
    plan.summary.thresholdQaCompared + plan.summary.thresholdQaUnavailable,
    70,
  );
  assert.equal(
    plan.operations.filter((operation) => operation.kind === 'threshold_qa_review').length,
    69,
  );
  assert.equal(plan.summary.thresholdQaReviews, 69);
});

test('une différence QA devenue inéligible préserve l’existant par une opération non mutante', () => {
  const fixture = calculationFixture('ineligible');
  const actualDistance = distanceWgs84Metres(
    fixture.routeCities[0].city,
    fixture.routeCities[1].city,
  );
  const reference = qaReference({
    product: {
      productId: `${MUNICIPALITY_A}__${MUNICIPALITY_B}`,
      municipalityKeyA: MUNICIPALITY_A,
      municipalityKeyB: MUNICIPALITY_B,
      slug: 'ville-a-a-ville-b',
      title: 'Ville A – Ville B à vélo',
      distanceMetres: actualDistance - 20_000,
      directMetres: actualDistance,
      retained: true,
    },
    anchorA: fixture.anchorA,
    anchorB: fixture.anchorB,
    eligibleByRoute: true,
    eligibleByDirect: false,
    shortestPathViaOrigin: false,
  });
  const plan = planCatalogueCalculation({
    route: fixture.route,
    routeCities: fixture.routeCities,
    baselineProducts: [reference],
    thresholdQa: [reference],
    baselineHash: DATASET_HASH,
    existingItineraries: [existingItinerary()],
    codeVersion: 'test',
  });
  const review = plan.operations.find((operation) => operation.kind === 'threshold_qa_review');

  assert.ok(review);
  assert.equal(review.qaStatus, 'different');
  assert.equal(review.reason, 'ineligible_mismatch');
  assert.ok(review.differenceCodes.includes('route_distance'));
  assert.ok(review.differenceCodes.includes('eligible_by_route'));
  assert.ok(review.differenceCodes.includes('retained'));
  assert.equal(plan.operations.some((operation) => operation.kind === 'archive_itinerary'), false);
  assert.equal(plan.summary.thresholdQaCompared, 1);
  assert.equal(plan.summary.thresholdQaDifferences, 1);
  assert.equal(plan.summary.thresholdQaReviews, 1);
  assert.equal(plan.summary.errors, 0);
});

test('une erreur de calcul QA est indisponible, non mutante et préserve l’existant', () => {
  const fixture = calculationFixture('selection_error');
  const reference = qaReference({
    product: {
      productId: `${MUNICIPALITY_A}__${MUNICIPALITY_B}`,
      municipalityKeyA: MUNICIPALITY_A,
      municipalityKeyB: MUNICIPALITY_B,
      slug: 'ville-a-a-ville-b',
      title: 'Ville A – Ville B à vélo',
      distanceMetres: 1,
      directMetres: 1,
      retained: true,
    },
    anchorA: fixture.anchorA,
    anchorB: fixture.anchorB,
    eligibleByRoute: true,
    eligibleByDirect: true,
    shortestPathViaOrigin: false,
  });
  const plan = planCatalogueCalculation({
    route: fixture.route,
    routeCities: fixture.routeCities,
    thresholdQa: [reference],
    baselineHash: DATASET_HASH,
    existingItineraries: [existingItinerary()],
    codeVersion: 'test',
  });
  const review = plan.operations.find((operation) => operation.kind === 'threshold_qa_review');

  assert.ok(review);
  assert.equal(review.qaStatus, 'unavailable');
  assert.equal(review.reason, 'calculation_error');
  assert.equal(plan.operations.some((operation) => operation.kind === 'archive_itinerary'), false);
  assert.equal(plan.summary.thresholdQaCompared, 0);
  assert.equal(plan.summary.thresholdQaUnavailable, 1);
  assert.equal(plan.summary.thresholdQaReviews, 1);
  assert.equal(plan.summary.errorPairs, 1);
  assert.equal(plan.summary.errors, 1);
});
