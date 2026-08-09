import assert from 'node:assert/strict';
import test from 'node:test';

import { ALGORITHM_VERSION, distanceWgs84Metres, parseOfficialGpx } from '../src/domain/catalogue-core';

import {
  buildAnchorKey,
  buildAnchorSemanticKey,
  buildBusinessKey,
  buildRouteCityKey,
  computeArtifactIntegrityHash,
  computeEvaluationHash,
  isCatalogueRevisionPubliclyCurrent,
  validateAnchorIdentity,
  validateAnchorAgainstPublishedRoute,
  validateCityItineraryForPublication,
  validateNoManualSystemFieldMutation,
  validateReferenceRouteForPublication,
  validateRouteCityIdentity,
  validateRevisionImmutability,
  validateWarningApproval,
} from '../src/domain/catalogue-validation';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

test('les clés métier sont stables, non ordonnées pour une paire et versionnées pour une ancre', () => {
  assert.equal(buildRouteCityKey('gthf-main-loop', 'FR-59350'), 'gthf-main-loop:FR-59350');
  assert.equal(
    buildBusinessKey('gthf-main-loop', 'FR-62041', 'FR-59350'),
    buildBusinessKey('gthf-main-loop', 'FR-59350', 'FR-62041'),
  );
  const semantic = buildAnchorSemanticKey('gthf-main-loop', 'FR-59350', 2);
  assert.equal(semantic, 'gthf-main-loop:FR-59350:occurrence:2');
  assert.equal(buildAnchorKey(semantic, HASH_A), `${semantic}:${HASH_A}`);
  assert.notEqual(buildAnchorKey(semantic, HASH_A), buildAnchorKey(semantic, HASH_B));
});

test('une identité d’ancre impose anchorSemanticKey et sourceHash dans anchorKey', () => {
  assert.throws(() => validateAnchorIdentity({
    anchorSemanticKey: 'route:FR-00001:occurrence:0',
    anchorKey: `route:FR-00001:occurrence:0:${HASH_A}`,
    sourceHash: HASH_B,
    occurrenceIndex: 0,
  }), /sourceHash/);
});

test('une transition validated recompose position, chapitre, chaînage et distance depuis le GPX publié', () => {
  const document = parseOfficialGpx('<gpx version="1.1"><trk><trkseg><trkpt lat="50" lon="2"/><trkpt lat="50" lon="2.01"/></trkseg></trk></gpx>');
  const chainageMetres = distanceWgs84Metres(
    { latitude: 50, longitude: 2 },
    { latitude: 50, longitude: 2.005 },
  );
  const city = { latitude: 50.001, longitude: 2.005 };
  const value = {
    anchorKey: `route:FR-00001:occurrence:0:${HASH_A}`,
    anchorSemanticKey: 'route:FR-00001:occurrence:0',
    occurrenceIndex: 0,
    sourceSegmentIndex: 0,
    chapter: { documentId: 'chapter-document' },
    sourceHash: HASH_A,
    trackIndex: 0,
    sourceTrackSegmentIndex: 0,
    sourcePointIndex: 0,
    sourceFraction: 0.5,
    chainageMetres,
    projectedLatitude: 50,
    projectedLongitude: 2.005,
    distanceToTraceMetres: distanceWgs84Metres(city, { latitude: 50, longitude: 2.005 }),
    sourceDirection: 'ab',
    algorithmVersion: ALGORITHM_VERSION.projection,
    validationStatus: 'validated',
  };
  const route = [{
    index: 0,
    chapterKey: 'chapter',
    chapterDocumentId: 'chapter-document',
    sourceSha256: HASH_A,
    document,
    junctionAfter: { status: 'exact' as const, gapMetres: 0, nextSourceSha256: HASH_A },
  }];
  assert.doesNotThrow(() => validateAnchorAgainstPublishedRoute(value, route, city));
  assert.throws(() => validateAnchorAgainstPublishedRoute({ ...value, chainageMetres: chainageMetres + 1 }, route, city), /chaînage/);
  assert.throws(() => validateAnchorAgainstPublishedRoute({ ...value, projectedLongitude: 2.0051 }, route, city), /coordonnée/);
  assert.throws(() => validateAnchorAgainstPublishedRoute({ ...value, chapter: { documentId: 'other' } }, route, city), /chapter/);
  assert.throws(() => validateAnchorAgainstPublishedRoute({ ...value, sourceTrackSegmentIndex: 4 }, route, city), /segment source|séquence/);
});

test('le hash d’évaluation trie les deux RouteCity et ferme si une empreinte manque', () => {
  const first = computeEvaluationHash({
    routeFingerprint: HASH_A,
    routeCities: [
      { routeCityKey: 'r:FR-B', fingerprint: HASH_B },
      { routeCityKey: 'r:FR-A', fingerprint: HASH_C },
    ],
    algorithmVersion: 'catalogue-v1',
  });
  const second = computeEvaluationHash({
    routeFingerprint: HASH_A,
    routeCities: [
      { routeCityKey: 'r:FR-A', fingerprint: HASH_C },
      { routeCityKey: 'r:FR-B', fingerprint: HASH_B },
    ],
    algorithmVersion: 'catalogue-v1',
  });
  assert.equal(first, second);
  assert.throws(() => computeEvaluationHash({
    routeFingerprint: null,
    routeCities: [],
    algorithmVersion: 'catalogue-v1',
  }), /empreinte/i);
});

test('une ReferenceRoute activée doit reprendre exactement la jonction PRD03 publiée', () => {
  const segments = Array.from({ length: 10 }, (_, index) => ({
    chapter: { documentId: `chapter-${index}` },
    direction: 'ab',
    sourceSha256: index % 2 ? HASH_B : HASH_A,
    nextSourceSha256: (index + 1) % 2 ? HASH_B : HASH_A,
    junctionAfterStatus: index === 0 ? 'accepted_gap' : 'exact',
    junctionAfterGapMetres: index === 0 ? 40.8 : 0,
    junctionNote: index === 0 ? 'Gare relue.' : null,
  }));
  const route = {
    routeKey: 'gthf-main-loop',
    slug: 'gthf-main-loop',
    isLoop: true,
    catalogueEnabled: true,
    sourceManifestHash: HASH_A,
    currentInputFingerprint: HASH_B,
    segments,
  };
  const prd03 = segments.map((segment, index) => ({
    chapterDocumentId: `chapter-${index}`,
    direction: 'ab' as const,
    sourceSha256: segment.sourceSha256,
    nextSourceSha256: segment.nextSourceSha256,
    status: segment.junctionAfterStatus as 'exact' | 'accepted_gap',
    gapMetres: segment.junctionAfterGapMetres,
    reviewNote: segment.junctionNote,
  }));
  assert.doesNotThrow(() => validateReferenceRouteForPublication(route, prd03));
  assert.throws(() => validateReferenceRouteForPublication(route, [{ ...prd03[0], gapMetres: 40.81 }, ...prd03.slice(1)]), /PRD03/);
  assert.throws(() => validateReferenceRouteForPublication(route, [{ ...prd03[0], sourceSha256: HASH_C }, ...prd03.slice(1)]), /PRD03|source/);
});

test('routeCityKey est recomposé depuis les relations et non seulement validé par regex', () => {
  assert.doesNotThrow(() => validateRouteCityIdentity({
    routeCityKey: 'route:FR-00001',
    route: { routeKey: 'route' },
    city: { municipalityKey: 'FR-00001' },
  }));
  assert.throws(() => validateRouteCityIdentity({
    routeCityKey: 'route:FR-00002',
    route: { routeKey: 'route' },
    city: { municipalityKey: 'FR-00001' },
  }), /relations/);
});

test('une warning exige une approbation complète, une ready interdit une approbation résiduelle', () => {
  assert.doesNotThrow(() => validateWarningApproval({
    calculationStatus: 'warning',
    warningApproved: false,
    warningApprovedAt: null,
    warningApprovedBy: null,
  }));
  assert.throws(() => validateWarningApproval({
    calculationStatus: 'warning',
    warningApproved: true,
    warningApprovedAt: null,
    warningApprovedBy: 'editor@example.test',
  }), /date/);
  assert.throws(() => validateWarningApproval({
    calculationStatus: 'ready',
    warningApproved: true,
    warningApprovedAt: '2026-08-07T10:00:00Z',
    warningApprovedBy: 'editor@example.test',
  }), /révision ready/);
});

test('la garde catalogue est fail-closed sur hash courant et intégrité', () => {
  const artifactIntegrityHash = computeArtifactIntegrityHash({
    sourceHash: HASH_A,
    generatedGpxSha256: HASH_B,
    displayGeometrySha256: HASH_C,
  });
  const revision = {
    calculationStatus: 'ready',
    warningApproved: false,
    eligibleByRoute: true,
    eligibleByDirect: false,
    sourceHash: HASH_A,
    generatedGpxSha256: HASH_B,
    displayGeometrySha256: HASH_C,
    generatedGpx: { id: 1 },
    displayGeometry: { id: 2 },
    artifactIntegrityStatus: 'verified',
    artifactIntegrityHash,
    lastVerifiedEvaluationHash: HASH_C,
  };
  const itinerary = {
    reviewStatus: 'approved',
    publicationNext: true,
    currentEvaluationHash: HASH_C,
    activeRevision: revision,
  };
  assert.equal(isCatalogueRevisionPubliclyCurrent(itinerary), true);
  assert.equal(isCatalogueRevisionPubliclyCurrent({ ...itinerary, currentEvaluationHash: null }), false);
  assert.equal(isCatalogueRevisionPubliclyCurrent({ ...itinerary, currentEvaluationHash: HASH_B }), false);
  assert.equal(isCatalogueRevisionPubliclyCurrent({
    ...itinerary,
    activeRevision: { ...revision, artifactIntegrityStatus: 'pending' },
  }), false);
});

test('publicationNext exige paire cohérente, révision courante et artefacts relus', () => {
  const cityA = { municipalityKey: 'FR-A' };
  const cityB = { municipalityKey: 'FR-B' };
  const route = { routeKey: 'route', catalogueEnabled: true };
  const revision = {
    itinerary: { businessKey: 'route:FR-A:FR-B' },
    departure: cityA,
    arrival: cityB,
    calculationStatus: 'ready',
    warningApproved: false,
    eligibleByRoute: true,
    eligibleByDirect: false,
    sourceHash: HASH_A,
    generatedGpxSha256: HASH_B,
    displayGeometrySha256: HASH_C,
    generatedGpx: { id: 1 },
    displayGeometry: { id: 2 },
    artifactIntegrityStatus: 'verified',
    artifactIntegrityHash: computeArtifactIntegrityHash({ sourceHash: HASH_A, generatedGpxSha256: HASH_B, displayGeometrySha256: HASH_C }),
    lastVerifiedEvaluationHash: HASH_C,
  };
  assert.doesNotThrow(() => validateCityItineraryForPublication({
    businessKey: 'route:FR-A:FR-B',
    title: 'De A à B',
    slug: 'a-b',
    route,
    cityA,
    cityB,
    reviewStatus: 'approved',
    publicationNext: true,
    currentEvaluationHash: HASH_C,
    activeRevision: revision,
  }));
  assert.throws(() => validateCityItineraryForPublication({
    businessKey: 'route:FR-A:FR-B',
    route,
    cityA,
    cityB,
    reviewStatus: 'approved',
    publicationNext: true,
    currentEvaluationHash: null,
    activeRevision: revision,
  }), /empreinte courante/);
});

test('les champs calculés d’une révision prête sont immuables', () => {
  const previous = { revisionKey: `revision:${HASH_A}`, calculationStatus: 'ready', distanceMetres: 12, sourceHash: HASH_A };
  assert.throws(() => validateRevisionImmutability(previous, { ...previous, distanceMetres: 13 }), /distanceMetres/);
  assert.doesNotThrow(() => validateRevisionImmutability(previous, {
    ...previous,
    lastVerifiedEvaluationHash: HASH_B,
  }));
  assert.throws(() => validateRevisionImmutability(
    { ...previous, calculationStatus: 'stale' },
    { ...previous, calculationStatus: 'ready', distanceMetres: 13 },
  ), /distanceMetres/);
});

test('le statut de calcul d’une révision est réservé au job catalogue', () => {
  assert.throws(
    () => validateNoManualSystemFieldMutation(
      'api::itinerary-revision.itinerary-revision',
      { calculationStatus: 'ready' },
    ),
    /calculationStatus.*job catalogue/,
  );
  assert.doesNotThrow(() => validateNoManualSystemFieldMutation(
    'api::itinerary-revision.itinerary-revision',
    { warningApproved: true, warningApprovedAt: '2026-08-08T10:00:00Z' },
  ));
});

test('les champs calculés et d’intégrité restent réservés au job sur tous les types techniques', () => {
  const rejected = [
    ['api::reference-route.reference-route', { segments: [] }],
    ['api::route-city.route-city', { qualificationEvidence: {} }],
    ['api::route-anchor.route-anchor', { projectedLatitude: 50.1 }],
    ['api::city-itinerary.city-itinerary', { businessKey: 'route:a:b' }],
    ['api::itinerary-revision.itinerary-revision', { distanceMetres: 12 }],
    ['api::catalogue-run.catalogue-run', { status: 'succeeded' }],
  ] as const;
  for (const [uid, data] of rejected) {
    assert.throws(
      () => validateNoManualSystemFieldMutation(uid, data),
      /job catalogue/,
      uid,
    );
  }

  assert.doesNotThrow(() => validateNoManualSystemFieldMutation(
    'api::reference-route.reference-route',
    { name: 'Grand Tour', catalogueEnabled: true, notes: 'Relu' },
  ));
  assert.doesNotThrow(() => validateNoManualSystemFieldMutation(
    'api::route-city.route-city',
    { qualificationStatus: 'qualified', qualifiedAt: '2026-08-09T10:00:00Z', reviewNote: 'Relu' },
  ));
  assert.doesNotThrow(() => validateNoManualSystemFieldMutation(
    'api::route-anchor.route-anchor',
    { validationStatus: 'validated' },
  ));
});

test('les identités et relations dérivées du catalogue restent réservées au job', () => {
  const rejected = [
    ['api::reference-route.reference-route', { routeKey: 'grand-tour', slug: 'grand-tour' }],
    ['api::route-city.route-city', { anchors: { set: [] } }],
    ['api::city-itinerary.city-itinerary', { slug: 'calais-saint-omer' }],
  ] as const;

  for (const [uid, data] of rejected) {
    assert.throws(
      () => validateNoManualSystemFieldMutation(uid, data),
      /job catalogue/,
      uid,
    );
  }
});
