import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  pointInAdministrativeGeometry,
  parseVersionedBoundarySnapshot,
  proposeBoundaryAnchors,
  validateBoundarySnapshot,
} from '../src/domain/catalogue-boundaries';
import { distanceWgs84Metres, parseOfficialGpx, sha256Hex } from '../src/domain/catalogue-core';

const square = {
  type: 'Polygon' as const,
  coordinates: [[[0.5, -0.5], [1.5, -0.5], [1.5, 0.5], [0.5, 0.5], [0.5, -0.5]]],
};

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('le contrôle du snapshot versionné est autonome sans dataset externe', () => {
  const output = execFileSync(
    'python3',
    ['data/catalogue/boundaries/check_snapshot.py'],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  assert.match(output, /OK: 223 municipality keys \(217 FR, 6 BE\)/);
  assert.match(output, /snapshot-only; pass --csv to check dataset coverage and anchors/);
});

test('pointInAdministrativeGeometry gère polygones, trous et MultiPolygon', () => {
  assert.equal(pointInAdministrativeGeometry({ latitude: 0, longitude: 1 }, square), true);
  assert.equal(pointInAdministrativeGeometry({ latitude: 1, longitude: 1 }, square), false);
  assert.equal(pointInAdministrativeGeometry({ latitude: 0, longitude: 11 }, {
    type: 'MultiPolygon',
    coordinates: [square.coordinates, [[[10, -1], [12, -1], [12, 1], [10, 1], [10, -1]]]],
  }), true);
});

test('la proposition sépare deux passages continus dans la même commune', () => {
  const document = parseOfficialGpx(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="0" lon="0"/><trkpt lat="0" lon="1"/><trkpt lat="0" lon="2"/>
    <trkpt lat="2" lon="2"/><trkpt lat="0" lon="1"/><trkpt lat="0" lon="0"/>
  </trkseg></trk></gpx>`);
  const proposals = proposeBoundaryAnchors({
    cityPoint: { latitude: 0.1, longitude: 1 },
    expectedOccurrences: 2,
    routeSegments: [{
      index: 0,
      sourceSha256: 'a'.repeat(64),
      document,
      chainageOffsetMetres: 0,
      breakBefore: true,
    }],
    geometry: square,
  });
  assert.equal(proposals.occurrences.length, 2);
  assert.equal(proposals.status, 'proposed');
  assert.ok(proposals.occurrences[1].chainageMetres > proposals.occurrences[0].chainageMetres);
});

test('une divergence du nombre attendu est expliquée et marque les ancres ambiguous', () => {
  const document = parseOfficialGpx('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0"/><trkpt lat="0" lon="1"/></trkseg></trk></gpx>');
  const proposals = proposeBoundaryAnchors({
    cityPoint: { latitude: 0, longitude: 1 },
    expectedOccurrences: 3,
    routeSegments: [{ index: 0, sourceSha256: 'a'.repeat(64), document, chainageOffsetMetres: 0, breakBefore: true }],
    geometry: square,
  });
  assert.equal(proposals.status, 'ambiguous');
  assert.match(proposals.ambiguityReasons[0], /3 occurrence\(s\) attendue\(s\)/);
});

test('deux trkseg discontinus dans la même commune restent deux occurrences', () => {
  const document = parseOfficialGpx(`<gpx version="1.1"><trk>
    <trkseg><trkpt lat="0" lon="0.6"/><trkpt lat="0" lon="0.8"/></trkseg>
    <trkseg><trkpt lat="0" lon="1.2"/><trkpt lat="0" lon="1.4"/></trkseg>
  </trk></gpx>`);
  const proposals = proposeBoundaryAnchors({
    cityPoint: { latitude: 0, longitude: 1 },
    expectedOccurrences: 2,
    routeSegments: [{
      index: 0,
      sourceSha256: 'a'.repeat(64),
      document,
      chainageOffsetMetres: 0,
      breakBefore: true,
    }],
    geometry: square,
  });
  assert.equal(proposals.occurrences.length, 2);
  assert.equal(proposals.status, 'proposed');
});

test('la projection est limitée à la portion de trace réellement située dans la commune', () => {
  const document = parseOfficialGpx('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0"/><trkpt lat="0" lon="2"/></trkseg></trk></gpx>');
  const proposals = proposeBoundaryAnchors({
    cityPoint: { latitude: 0, longitude: 1.9 },
    expectedOccurrences: 1,
    routeSegments: [{
      index: 0,
      sourceSha256: 'a'.repeat(64),
      document,
      chainageOffsetMetres: 0,
      breakBefore: true,
    }],
    geometry: square,
  });
  assert.equal(proposals.status, 'proposed');
  assert.equal(proposals.occurrences.length, 1);
  assert.ok(Math.abs(proposals.occurrences[0].projectedLongitude - 1.5) < 1e-9);
  assert.equal(pointInAdministrativeGeometry({
    latitude: proposals.occurrences[0].projectedLatitude,
    longitude: proposals.occurrences[0].projectedLongitude,
  }, square), true);
});

test('le premier chapitre et chaînage contrôlés sont conservés mais une projection concurrente reste ambiguë', () => {
  const first = parseOfficialGpx('<gpx version="1.1"><trk><trkseg><trkpt lat="0.3" lon="0.6"/><trkpt lat="0.3" lon="1.4"/></trkseg></trk></gpx>');
  const second = parseOfficialGpx('<gpx version="1.1"><trk><trkseg><trkpt lat="0.01" lon="0.6"/><trkpt lat="0.01" lon="1.4"/></trkseg></trk></gpx>');
  const firstDistance = distanceWgs84Metres(
    { latitude: 0.3, longitude: 0.6 },
    { latitude: 0.3, longitude: 1.4 },
  );
  const proposals = proposeBoundaryAnchors({
    cityPoint: { latitude: 0, longitude: 1 },
    expectedOccurrences: 1,
    routeSegments: [
      { index: 0, sourceSha256: 'a'.repeat(64), document: first, chainageOffsetMetres: 0, breakBefore: true },
      { index: 1, sourceSha256: 'b'.repeat(64), document: second, chainageOffsetMetres: firstDistance, breakBefore: false },
    ],
    geometry: square,
    firstOccurrenceHint: {
      routeSegmentIndex: 0,
      chainageMetres: firstDistance / 2,
      toleranceMetres: 0.01,
    },
  });
  assert.equal(proposals.status, 'ambiguous');
  assert.equal(proposals.occurrences[0].sourceSegmentIndex, 0);
  assert.ok(Math.abs(proposals.occurrences[0].chainageMetres - firstDistance / 2) < 0.01);
  assert.ok(proposals.ambiguityReasons.some((reason) => /projections concurrentes/.test(reason)));
});

test('une ancre primaire PRD03 validée et rattachée sans ambiguïté est conservée exactement', () => {
  const document = parseOfficialGpx('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0.5"/><trkpt lat="0" lon="1.5"/></trkseg></trk></gpx>');
  const edgeLength = distanceWgs84Metres(
    { latitude: 0, longitude: 0.5 },
    { latitude: 0, longitude: 1.5 },
  );
  const proposals = proposeBoundaryAnchors({
    cityPoint: { latitude: 0, longitude: 0.6 },
    expectedOccurrences: 1,
    routeSegments: [{ index: 0, sourceSha256: 'a'.repeat(64), document, chainageOffsetMetres: 0, breakBefore: true }],
    geometry: square,
    primaryAnchors: [{
      routeSegmentIndex: 0,
      sourceSha256: 'a'.repeat(64),
      trackIndex: 0,
      segmentIndex: 0,
      pointIndex: 0,
      fraction: 0.75,
      chainageMetres: edgeLength * 0.75,
      projectedLatitude: 0,
      projectedLongitude: 1.25,
      distanceToTraceMetres: distanceWgs84Metres(
        { latitude: 0, longitude: 0.6 },
        { latitude: 0, longitude: 1.25 },
      ),
    }],
  });
  assert.equal(proposals.status, 'proposed');
  assert.equal(proposals.occurrences[0].selectionOrigin, 'prd03_primary');
  assert.equal(proposals.occurrences[0].sourceFraction, 0.75);
  assert.equal(proposals.occurrences[0].projectedLongitude, 1.25);
});

test('un lacet avec deux projections équidistantes est explicitement ambigu', () => {
  const document = parseOfficialGpx(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="-0.1" lon="0.6"/><trkpt lat="-0.1" lon="1.4"/>
    <trkpt lat="0.1" lon="1.4"/><trkpt lat="0.1" lon="0.6"/>
  </trkseg></trk></gpx>`);
  const proposals = proposeBoundaryAnchors({
    cityPoint: { latitude: 0, longitude: 1 },
    expectedOccurrences: 1,
    routeSegments: [{ index: 0, sourceSha256: 'a'.repeat(64), document, chainageOffsetMetres: 0, breakBefore: true }],
    geometry: square,
  });
  assert.equal(proposals.status, 'ambiguous');
  assert.ok(proposals.ambiguityReasons.some((reason) => /projections concurrentes|lacet/.test(reason)));
});

test('un croisement non adjacent dans un même passage est explicitement ambigu', () => {
  const document = parseOfficialGpx(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="-0.4" lon="0.6"/><trkpt lat="0.4" lon="1.4"/>
    <trkpt lat="0.4" lon="0.6"/><trkpt lat="-0.4" lon="1.4"/>
  </trkseg></trk></gpx>`);
  const proposals = proposeBoundaryAnchors({
    cityPoint: { latitude: 0, longitude: 1 },
    expectedOccurrences: 1,
    routeSegments: [{ index: 0, sourceSha256: 'a'.repeat(64), document, chainageOffsetMetres: 0, breakBefore: true }],
    geometry: square,
  });
  assert.equal(proposals.status, 'ambiguous');
  assert.ok(proposals.ambiguityReasons.some((reason) => /croisement ou lacet/.test(reason)));
});

test('un snapshot incomplet est bloquant avant anchors/calculate', () => {
  assert.throws(() => validateBoundarySnapshot({
    version: 1,
    manifestHash: 'a'.repeat(64),
    features: [{ municipalityKey: 'FR-A', geometry: square }],
  }, ['FR-A', 'BE-B']), /BE-B/);
});

test('le loader refuse tout snapshot dont les octets divergent du manifeste', () => {
  const geoJson = `${JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: { municipalityKey: 'FR-A', sourceName: 'fixture' },
      geometry: square,
    }],
  })}\n`;
  const manifest = JSON.stringify({
    generatedAt: '2026-08-07T10:00:00Z',
    snapshot: {
      sha256: sha256Hex(geoJson),
      bytes: new TextEncoder().encode(geoJson).byteLength,
      featureCount: 1,
    },
    sources: [],
  });
  assert.equal(parseVersionedBoundarySnapshot(geoJson, manifest, ['FR-A']).features.length, 1);
  assert.throws(() => parseVersionedBoundarySnapshot(`${geoJson} `, manifest, ['FR-A']), /octets/);
});
