import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALGORITHM_VERSION,
  canonicalJson,
  buildDisplayGeometry,
  calculateEligibility,
  computeElevationMetrics,
  distanceWgs84Metres,
  extractRouteArc,
  parseOfficialGpx,
  projectPointOnSegment,
  recomposeAnchorInDocument,
  recomposeRouteAnchorPosition,
  selectShortestArc,
  serializeCatalogueGpx,
  sha256Hex,
  simplifySequences,
  type CatalogueAnchor,
  type CatalogueRouteSegment,
} from '../src/domain/catalogue-core';

const HASHES = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];

function routeSegment(index: number, start: number, end: number, status: 'exact' | 'accepted_gap' | 'blocked' = 'exact'): CatalogueRouteSegment {
  const document = parseOfficialGpx(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="50" lon="${start}"><ele>${index * 10}</ele><time>2026-01-01T00:00:00Z</time></trkpt>
    <trkpt lat="50" lon="${end}"><ele>${index * 10 + 10}</ele><time>2026-01-01T01:00:00Z</time></trkpt>
  </trkseg></trk></gpx>`);
  return {
    index,
    chapterKey: `chapter-${index}`,
    sourceSha256: HASHES[index],
    document,
    junctionAfter: {
      status,
      gapMetres: status === 'accepted_gap' ? 42 : 0,
      nextSourceSha256: HASHES[(index + 1) % HASHES.length],
    },
  };
}

function anchor(key: string, routeSegmentIndex: number, fraction: number): CatalogueAnchor {
  const longitude = routeSegmentIndex + fraction;
  return {
    anchorKey: key,
    routeSegmentIndex,
    sourceSha256: HASHES[routeSegmentIndex],
    trackIndex: 0,
    segmentIndex: 0,
    pointIndex: 0,
    fraction,
    chainageMetres: longitude,
    projectedLatitude: 50,
    projectedLongitude: longitude,
    status: 'validated',
  };
}

test('Vincenty WGS84 reproduit une distance connue au centimètre', () => {
  const distance = distanceWgs84Metres(
    { latitude: 50.62925, longitude: 3.057256 },
    { latitude: 50.291002, longitude: 2.777535 },
  );
  assert.ok(Math.abs(distance - 42_546.897_102) < 0.01, distance.toString());
  assert.equal(ALGORITHM_VERSION.wgs84, 'vincenty-wgs84-v1');
});

test('les seuils sont stricts au millimètre et gardent le OU produit', () => {
  assert.deepEqual(calculateEligibility(59_999.999, 40_000), {
    eligible: true,
    eligibleByRoute: true,
    eligibleByDirect: false,
  });
  assert.equal(calculateEligibility(60_000, 40_000).eligible, false);
  assert.equal(calculateEligibility(60_000.001, 39_999.999).eligible, true);
});

test('la projection porte sur une arête et non sur le seul point le plus proche', () => {
  const projected = projectPointOnSegment(
    { latitude: 50.1, longitude: 2.5 },
    { latitude: 50, longitude: 2 },
    { latitude: 50, longitude: 3 },
  );
  assert.ok(Math.abs(projected.fraction - 0.5) < 1e-6);
  assert.ok(Math.abs(projected.point.longitude - 2.5) < 1e-9);
});

test('une ancre validée est recomposée depuis ses indices, sa fraction et son chaînage GPX', () => {
  const precedingDocument = parseOfficialGpx(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="50" lon="1"/><trkpt lat="50" lon="1.01"/>
  </trkseg></trk></gpx>`);
  const anchorDocument = parseOfficialGpx(`<gpx version="1.1"><trk>
    <trkseg><trkpt lat="50" lon="2"/><trkpt lat="50" lon="2.01"/></trkseg>
    <trkseg><trkpt lat="50" lon="2.02"/><trkpt lat="50" lon="2.03"/></trkseg>
  </trk></gpx>`);
  const precedingDistance = distanceWgs84Metres(
    { latitude: 50, longitude: 1 },
    { latitude: 50, longitude: 1.01 },
  );
  const firstLocalSequenceDistance = distanceWgs84Metres(
    { latitude: 50, longitude: 2 },
    { latitude: 50, longitude: 2.01 },
  );
  const halfTargetEdgeDistance = distanceWgs84Metres(
    { latitude: 50, longitude: 2.02 },
    { latitude: 50, longitude: 2.03 },
  ) / 2;
  const localChainageMetres = firstLocalSequenceDistance + halfTargetEdgeDistance;
  const route = [
    {
      index: 0,
      chapterKey: 'preceding',
      sourceSha256: HASHES[0],
      document: precedingDocument,
      junctionAfter: { status: 'exact' as const, gapMetres: 0, nextSourceSha256: HASHES[1] },
    },
    {
      index: 1,
      chapterKey: 'target',
      sourceSha256: HASHES[1],
      document: anchorDocument,
      junctionAfter: { status: 'exact' as const, gapMetres: 0, nextSourceSha256: HASHES[0] },
    },
  ];
  const strictAnchor: CatalogueAnchor = {
    anchorKey: 'strict',
    routeSegmentIndex: 1,
    sourceSha256: HASHES[1],
    trackIndex: 0,
    segmentIndex: 1,
    pointIndex: 0,
    fraction: 0.5,
    chainageMetres: precedingDistance + localChainageMetres,
    projectedLatitude: 50,
    projectedLongitude: 2.025,
    status: 'validated',
  };

  const local = recomposeAnchorInDocument(anchorDocument, {
    ...strictAnchor,
    chainageMetres: localChainageMetres,
  });
  assert.ok(Math.abs(local.localChainageMetres - localChainageMetres) < 0.01);
  const recomposed = recomposeRouteAnchorPosition({
    route,
    anchor: strictAnchor,
    cityPoint: { latitude: 50.001, longitude: 2.025 },
    storedDistanceToTraceMetres: distanceWgs84Metres(
      { latitude: 50.001, longitude: 2.025 },
      { latitude: 50, longitude: 2.025 },
    ),
  });
  assert.ok(Math.abs(recomposed.chainageMetres - strictAnchor.chainageMetres) < 0.01);
  assert.equal(recomposed.point.longitude, 2.025);

  assert.throws(() => recomposeRouteAnchorPosition({
    route,
    anchor: { ...strictAnchor, chainageMetres: strictAnchor.chainageMetres + 1 },
  }), /chaînage/);
  assert.throws(() => recomposeRouteAnchorPosition({
    route,
    anchor: { ...strictAnchor, projectedLongitude: 2.0251 },
  }), /coordonnée/);
  assert.throws(() => recomposeRouteAnchorPosition({
    route,
    anchor: { ...strictAnchor, segmentIndex: 8 },
  }), /segment source/);
});

test('le choix multi-occurrences évalue les deux arcs et son tie-break est déterministe', () => {
  const selected = selectShortestArc({
    anchorsA: [anchor('a-z', 0, 0.25), anchor('a-a', 2, 0.75)],
    anchorsB: [anchor('b-z', 1, 0.25), anchor('b-a', 0, 0.75)],
    routeLengthMetres: 3,
    junctions: [
      { afterSegmentIndex: 0, status: 'exact' },
      { afterSegmentIndex: 1, status: 'exact' },
      { afterSegmentIndex: 2, status: 'exact' },
    ],
    sequenceCountForCandidate: () => 1,
  });
  assert.equal(selected.departure.anchorKey, 'a-z');
  assert.equal(selected.arrival.anchorKey, 'b-a');
  assert.equal(selected.distanceMetres, 0.5);
  assert.equal(selected.usesLoopOrigin, false);
});

test('une jonction bloquée retire seulement les arcs qui la traversent', () => {
  const selected = selectShortestArc({
    anchorsA: [anchor('a', 0, 0.5)],
    anchorsB: [anchor('b', 1, 0.5)],
    routeLengthMetres: 3,
    junctions: [
      { afterSegmentIndex: 0, status: 'blocked' },
      { afterSegmentIndex: 1, status: 'exact' },
      { afterSegmentIndex: 2, status: 'exact' },
    ],
    sequenceCountForCandidate: () => 1,
  });
  assert.equal(selected.departure.anchorKey, 'b');
  assert.equal(selected.arrival.anchorKey, 'a');
  assert.equal(selected.usesLoopOrigin, true);
});

test('la découpe cyclique garde les ruptures acceptées dans des trkseg distincts', () => {
  const route = [
    routeSegment(0, 0, 1, 'accepted_gap'),
    routeSegment(1, 1.01, 2),
    routeSegment(2, 2, 3),
  ];
  route[0].junctionAfter.gapMetres = distanceWgs84Metres(
    { latitude: 50, longitude: 1 },
    { latitude: 50, longitude: 1.01 },
  );
  const arrival = {
    ...anchor('b', 1, 0.5),
    projectedLongitude: 1.505,
  };
  const result = extractRouteArc(route, anchor('a', 0, 0.5), arrival);
  assert.equal(result.sequences.length, 2);
  assert.equal(result.warnings[0]?.code, 'accepted_gap');
  assert.deepEqual(result.chapterKeys, ['chapter-0', 'chapter-1']);
});

test('distance et dénivelé ne franchissent jamais une rupture', () => {
  const metrics = computeElevationMetrics([
    [
      { latitude: 50, longitude: 2, elevation: 0 },
      { latitude: 50, longitude: 2.01, elevation: 100 },
    ],
    [
      { latitude: 50, longitude: 3, elevation: 100 },
      { latitude: 50, longitude: 3.01, elevation: 0 },
    ],
  ]);
  assert.equal(metrics.elevationAvailable, true);
  assert.ok((metrics.elevationGainMetres ?? 0) > 90);
  assert.ok((metrics.elevationLossMetres ?? 0) > 90);
  assert.ok(metrics.distanceMetres < 2_000);
});

test('le GPX catalogue est canonique, sans aucun time, et identique entre deux runs', () => {
  const input = {
    departureName: 'Lille',
    arrivalName: 'Arras & environs',
    revisionKey: 'route:a:b:hash',
    sourceHash: HASHES[0],
    algorithmVersion: 'catalogue-v1',
    sequences: [[
      { latitude: 50, longitude: 2, elevation: 12 },
      { latitude: 50.1, longitude: 2.1, elevation: 14 },
    ]],
  };
  const first = serializeCatalogueGpx(input);
  const second = serializeCatalogueGpx(input);
  assert.equal(first, second);
  assert.doesNotMatch(first, /<time>/);
  assert.doesNotMatch(first, /generatedAt/i);
  assert.match(first, /Arras &amp; environs/);
  assert.equal(parseOfficialGpx(first).pointCount, 2);
  assert.equal(sha256Hex(first), sha256Hex(second));
});

test('la sérialisation de hash trie récursivement les clés et rejette les valeurs non finies', () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.throws(() => canonicalJson({ invalid: Number.NaN }), /finie/);
});

test('la simplification conserve extrémités et ruptures', () => {
  const simplified = simplifySequences([
    Array.from({ length: 200 }, (_, index) => ({
      latitude: 50 + index / 100_000,
      longitude: 2 + index / 10_000,
      elevation: index,
    })),
    [{ latitude: 51, longitude: 3, elevation: 4 }],
  ], 10);
  assert.deepEqual(simplified[0][0], { latitude: 50, longitude: 2, elevation: 0 });
  assert.deepEqual(simplified[0].at(-1), { latitude: 50.00199, longitude: 2.0199, elevation: 199 });
  assert.equal(simplified.length, 2);
});

test('le profil d’affichage conserve une série distincte par rupture', () => {
  const geometry = buildDisplayGeometry({
    revisionKey: 'revision',
    algorithmVersion: 'catalogue-v1',
    sequences: [
      [{ latitude: 50, longitude: 2, elevation: 10 }, { latitude: 50, longitude: 2.001, elevation: 20 }],
      [{ latitude: 51, longitude: 3, elevation: 30 }, { latitude: 51, longitude: 3.001, elevation: 40 }],
    ],
  });
  assert.equal(geometry.elevationProfile?.length, 2);
  assert.equal(geometry.elevationProfile?.[0].sequenceIndex, 0);
  assert.equal(geometry.elevationProfile?.[1].sequenceIndex, 1);
  assert.ok((geometry.elevationProfile?.[1].points[0].distanceMetres ?? 0)
    === (geometry.elevationProfile?.[0].points.at(-1)?.distanceMetres ?? -1));
});

test('le profil d’affichage suit exactement la qualification altitude avec un petit trou interpolé', () => {
  const sequence = Array.from({ length: 81 }, (_, index) => ({
    latitude: 50,
    longitude: 2 + index * 0.00005,
    ...(index === 40 ? {} : { elevation: 100 + index }),
  }));
  const metrics = computeElevationMetrics([sequence]);
  assert.equal(metrics.elevationAvailable, true);
  const geometry = buildDisplayGeometry({
    revisionKey: 'partial-elevation',
    algorithmVersion: 'catalogue-v1',
    sequences: [sequence],
    elevationAvailable: metrics.elevationAvailable,
  });
  assert.notEqual(geometry.elevationProfile, null);
  assert.equal(geometry.elevationProfile?.[0].points.length, 81);
});
