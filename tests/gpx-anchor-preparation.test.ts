import assert from 'node:assert/strict';
import test from 'node:test';

import anchorCore from '../scripts/gpx-anchor-core.js';
import preparation from '../scripts/prepare-gpx-anchors.js';

const { proposeOrderedAnchors } = anchorCore;
const {
  emptyResolutions,
  parseAnchorPreparationArguments,
  runGpxAnchorPreparation,
} = preparation;

test('proposeOrderedAnchors projects passages onto ordered GPX edges', () => {
  const bytes = new TextEncoder().encode(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="0" lon="0"><ele>0</ele></trkpt>
    <trkpt lat="0" lon="1"><ele>10</ele></trkpt>
    <trkpt lat="0" lon="2"><ele>20</ele></trkpt>
  </trkseg></trk></gpx>`);
  const proposals = proposeOrderedAnchors({
    bytes,
    passages: [
      { passageIndex: 0, city: { name: 'Départ', latitude: 0, longitude: 0.2 } },
      { passageIndex: 1, city: { name: 'Arrivée', latitude: 0, longitude: 1.8 } },
    ],
  });

  assert.equal(proposals.sourceSha256.length, 64);
  assert.equal(proposals.anchors[0].pointIndex, 0);
  assert.ok(Math.abs(proposals.anchors[0].fraction - 0.2) < 1e-9);
  assert.equal(proposals.anchors[1].pointIndex, 1);
  assert.ok(Math.abs(proposals.anchors[1].fraction - 0.8) < 1e-9);
  assert.ok(proposals.anchors[1].chainageMetres > proposals.anchors[0].chainageMetres);
  assert.equal(proposals.anchors.every((anchor: { status: string }) => anchor.status === 'proposed'), true);
});

test('proposeOrderedAnchors keeps distant occurrences instead of 64 adjacent edges', () => {
  const points = [
    '<trkpt lat="0.0001" lon="0" />',
    '<trkpt lat="0" lon="0.1" />',
    ...Array.from({ length: 100 }, (_, index) => (
      `<trkpt lat="${index % 2 === 0 ? '0.00001' : '-0.00001'}" lon="0.1" />`
    )),
    '<trkpt lat="0" lon="0" />',
    ...Array.from({ length: 100 }, (_, index) => (
      `<trkpt lat="${index % 2 === 0 ? '0.00001' : '-0.00001'}" lon="0" />`
    )),
  ];
  const bytes = new TextEncoder().encode(
    `<gpx version="1.1"><trk><trkseg>${points.join('')}</trkseg></trk></gpx>`
  );
  const proposals = proposeOrderedAnchors({
    bytes,
    passages: [
      { passageIndex: 0, city: { name: 'A', latitude: 0, longitude: 0 } },
      { passageIndex: 1, city: { name: 'B', latitude: 0, longitude: 0.1 } },
    ],
  });

  assert.ok(proposals.anchors[0].chainageMetres < proposals.anchors[1].chainageMetres);
  assert.ok(proposals.anchors[0].distanceToCityMetres < 20);
  assert.ok(proposals.anchors[1].distanceToCityMetres < 20);
});

test('parseAnchorPreparationArguments keeps dry-run safe and requires confirmation for apply', () => {
  const options = parseAnchorPreparationArguments([], '/tmp/gthdf-anchor-test');

  assert.equal(options.apply, false);
  assert.equal(options.remote, false);
  assert.match(options.reportPath, /gpx-anchor-report\.json$/);
  assert.throws(
    () => parseAnchorPreparationArguments(['--apply'], '/tmp/gthdf-anchor-test'),
    /--confirm-apply/
  );
  assert.equal(
    parseAnchorPreparationArguments(
      ['--apply', '--confirm-apply'],
      '/tmp/gthdf-anchor-test'
    ).apply,
    true
  );
});

test('runGpxAnchorPreparation is dry-run first, applies drafts and becomes idempotent', async () => {
  const bytes = {
    '/one-ab.gpx': new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0" /><trkpt lat="0" lon="1" /></trkseg></trk></gpx>'),
    '/one-ba.gpx': new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="1" /><trkpt lat="0" lon="0" /></trkseg></trk></gpx>'),
    '/two-ab.gpx': new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="1" /><trkpt lat="0" lon="0" /></trkseg></trk></gpx>'),
    '/two-ba.gpx': new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0" /><trkpt lat="0" lon="1" /></trkseg></trk></gpx>'),
  };
  const city = (documentId: string, name: string, longitude: number) => ({
    documentId,
    name,
    latitude: 0,
    longitude,
  });
  const chapters = [
    {
      documentId: 'chapter-one',
      slug: 'one',
      title: 'Un',
      displayOrder: 1,
      gpxFileAB: { url: '/one-ab.gpx' },
      gpxFileBA: { url: '/one-ba.gpx' },
      cityPassages: [
        { id: 1, role: 'start', featured: false, city: city('city-a', 'A', 0.2) },
        { id: 2, role: 'end', featured: false, city: city('city-b', 'B', 0.8) },
      ],
    },
    {
      documentId: 'chapter-two',
      slug: 'two',
      title: 'Deux',
      displayOrder: 2,
      gpxFileAB: { url: '/two-ab.gpx' },
      gpxFileBA: { url: '/two-ba.gpx' },
      cityPassages: [
        { id: 3, role: 'start', featured: false, city: city('city-b', 'B', 0.8) },
        { id: 4, role: 'end', featured: false, city: city('city-a', 'A', 0.2) },
      ],
    },
  ];
  let updateCalls = 0;
  const adapter = {
    listChapters: async () => chapters,
    updateChapter: async (documentId: string, update: any) => {
      updateCalls += 1;
      const chapter = chapters.find((item) => item.documentId === documentId)!;
      chapter.cityPassages = chapter.cityPassages.map((passage, index) => ({
        ...passage,
        gpxAnchorAB: update.cityPassages[index].gpxAnchorAB,
        gpxAnchorBA: update.cityPassages[index].gpxAnchorBA,
      })) as typeof chapter.cityPassages;
      Object.assign(chapter, {
        gpxJunctionAfterAB: update.gpxJunctionAfterAB,
        gpxJunctionAfterBA: update.gpxJunctionAfterBA,
      });
    },
  };
  const fetchMediaBytes = async (media: { url: keyof typeof bytes }) => bytes[media.url];

  const dryRun = await runGpxAnchorPreparation({
    adapter,
    fetchMediaBytes,
    resolutions: emptyResolutions(),
  });
  assert.equal(updateCalls, 0);
  assert.equal(dryRun.summary.ready, 2);
  assert.equal(dryRun.summary.proposedAnchors, 8);

  const applied = await runGpxAnchorPreparation({
    adapter,
    fetchMediaBytes,
    resolutions: emptyResolutions(),
    apply: true,
  });
  assert.equal(applied.summary.updated, 2);
  assert.equal(updateCalls, 2);

  for (const chapter of chapters as any[]) {
    for (const passage of chapter.cityPassages) {
      for (const anchor of [passage.gpxAnchorAB, passage.gpxAnchorBA]) {
        for (const field of [
          'fraction',
          'chainageMetres',
          'projectedLatitude',
          'projectedLongitude',
          'distanceToCityMetres',
        ]) {
          anchor[field] = String(anchor[field]);
        }
      }
    }
    chapter.gpxJunctionAfterAB.gapMetres = String(chapter.gpxJunctionAfterAB.gapMetres);
    chapter.gpxJunctionAfterBA.gapMetres = String(chapter.gpxJunctionAfterBA.gapMetres);
  }

  const secondApply = await runGpxAnchorPreparation({
    adapter,
    fetchMediaBytes,
    resolutions: emptyResolutions(),
    apply: true,
  });
  assert.equal(secondApply.summary.unchanged, 2);
  assert.equal(updateCalls, 2);
});
