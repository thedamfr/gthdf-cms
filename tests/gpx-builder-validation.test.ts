import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateGpxBuilderChapter,
  validateGpxBuilderRoute,
} from '../src/domain/gpx-builder-validation.ts';

test('validateGpxBuilderChapter requires a validated anchor in both directions', () => {
  const abAnchor = (chainageMetres: number) => ({
    status: 'validated',
    sourceSha256: 'a'.repeat(64),
    trackIndex: 0,
    segmentIndex: 0,
    pointIndex: chainageMetres,
    fraction: 0,
    chainageMetres,
    projectedLatitude: 50,
    projectedLongitude: 2 + chainageMetres,
    distanceToCityMetres: 10,
    algorithmVersion: 'gpx-anchor-v1',
  });

  assert.throws(
    () => validateGpxBuilderChapter({
      title: 'Étaples → Calais',
      gpxFileAB: { id: 1 },
      gpxFileBA: { id: 2 },
      cityPassages: [
        { role: 'start', gpxAnchorAB: abAnchor(0) },
        { role: 'end', gpxAnchorAB: abAnchor(1) },
      ],
    }),
    /ancrage BA validé/
  );
});

test('validateGpxBuilderChapter rejects a disconnected official GPX media relation', () => {
  assert.throws(
    () => validateGpxBuilderChapter({
      title: 'Étaples → Calais',
      gpxFileAB: { disconnect: [{ id: 1 }] },
      gpxFileBA: { id: 2 },
    }),
    /deux médias GPX officiels/
  );
});

test('validateGpxBuilderRoute accepts ordered AB and BA anchors with cyclic junction hashes', () => {
  const hashes = {
    firstAB: 'a'.repeat(64),
    firstBA: 'b'.repeat(64),
    secondAB: 'c'.repeat(64),
    secondBA: 'd'.repeat(64),
  };
  const anchor = (sourceSha256: string, chainageMetres: number) => ({
    status: 'validated',
    sourceSha256,
    trackIndex: 0,
    segmentIndex: 0,
    pointIndex: Math.abs(chainageMetres),
    fraction: 0,
    chainageMetres,
    projectedLatitude: 50,
    projectedLongitude: 2,
    distanceToCityMetres: 10,
    algorithmVersion: 'gpx-anchor-v1',
  });
  const chapter = (
    displayOrder: number,
    sourceSha256AB: string,
    sourceSha256BA: string,
    nextSourceSha256AB: string,
    nextSourceSha256BA: string
  ) => ({
    title: `Chapitre ${displayOrder}`,
    displayOrder,
    gpxFileAB: { id: displayOrder * 2 },
    gpxFileBA: { id: displayOrder * 2 + 1 },
    cityPassages: [
      {
        gpxAnchorAB: anchor(sourceSha256AB, 0),
        gpxAnchorBA: anchor(sourceSha256BA, 10),
      },
      {
        gpxAnchorAB: anchor(sourceSha256AB, 10),
        gpxAnchorBA: anchor(sourceSha256BA, 0),
      },
    ],
    gpxJunctionAfterAB: {
      status: 'exact',
      sourceSha256: sourceSha256AB,
      nextSourceSha256: nextSourceSha256AB,
      gapMetres: 0,
    },
    gpxJunctionAfterBA: {
      status: 'exact',
      sourceSha256: sourceSha256BA,
      nextSourceSha256: nextSourceSha256BA,
      gapMetres: 0,
    },
  });

  assert.doesNotThrow(() => validateGpxBuilderRoute([
    chapter(2, hashes.secondAB, hashes.secondBA, hashes.firstAB, hashes.firstBA),
    chapter(1, hashes.firstAB, hashes.firstBA, hashes.secondAB, hashes.secondBA),
  ]));
});
