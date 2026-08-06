import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import anchorCore from '../scripts/gpx-anchor-core.js';
import preparation from '../scripts/prepare-gpx-anchors.js';

const { parseOfficialGpxBytes, proposeOrderedAnchors } = anchorCore;
const {
  configuredMediaOrigins,
  emptyResolutions,
  fetchOfficialMediaBytes,
  loadAnchorResolutions,
  parseAnchorPreparationArguments,
  runGpxAnchorPreparation,
} = preparation;

test('loadAnchorResolutions expands one reviewed place into AB and BA junctions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gthdf-junction-pair-'));
  const resolutionsPath = join(directory, 'resolutions.json');
  writeFileSync(resolutionsPath, JSON.stringify({
    version: 1,
    anchors: [],
    junctions: [],
    junctionPairs: [
      {
        cityName: 'Arras',
        referenceKind: 'train_station',
        referenceLabel: 'Gare SNCF d’Arras',
        abChapterSlug: 'lille-a-arras',
        baChapterSlug: 'arras-a-conde-sur-l-escaut',
        decision: 'accepted_gap',
        reviewNote: 'Même lieu de jonction éditorial en AB et BA.',
      },
    ],
  }));

  try {
    const resolutions = loadAnchorResolutions(resolutionsPath);

    assert.deepEqual(resolutions.junctions.get('lille-a-arras:AB'), {
      decision: 'accepted_gap',
      reviewNote: 'Gare SNCF d’Arras — Même lieu de jonction éditorial en AB et BA.',
    });
    assert.deepEqual(resolutions.junctions.get('arras-a-conde-sur-l-escaut:BA'), {
      decision: 'accepted_gap',
      reviewNote: 'Gare SNCF d’Arras — Même lieu de jonction éditorial en AB et BA.',
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

test('proposeOrderedAnchors reuses an already parsed GPX source', () => {
  const bytes = new TextEncoder().encode(`<gpx version="1.1"><trk><trkseg>
    <trkpt lat="0" lon="0" />
    <trkpt lat="0" lon="1" />
  </trkseg></trk></gpx>`);
  const source = parseOfficialGpxBytes(bytes);

  const proposals = proposeOrderedAnchors({
    source,
    passages: [
      { passageIndex: 0, city: { name: 'A', latitude: 0, longitude: 0.1 } },
      { passageIndex: 1, city: { name: 'B', latitude: 0, longitude: 0.9 } },
    ],
  });

  assert.equal(proposals.sourceSha256, source.sourceSha256);
  assert.equal(proposals.anchors.length, 2);
});

test('configuredMediaOrigins trims comma-separated environment values', () => {
  const previous = process.env.STRAPI_MEDIA_ORIGINS;
  process.env.STRAPI_MEDIA_ORIGINS = 'https://media-one.example, https://media-two.example ';
  try {
    const origins = configuredMediaOrigins(' http://127.0.0.1:1337 ');
    assert.equal(origins.has('https://media-one.example'), true);
    assert.equal(origins.has('https://media-two.example'), true);
    assert.equal(origins.has('http://127.0.0.1:1337'), true);
  } finally {
    if (previous === undefined) delete process.env.STRAPI_MEDIA_ORIGINS;
    else process.env.STRAPI_MEDIA_ORIGINS = previous;
  }
});

test('fetchOfficialMediaBytes reports an invalid public Strapi URL clearly', async () => {
  const previous = process.env.STRAPI_PUBLIC_URL;
  process.env.STRAPI_PUBLIC_URL = 'not-a-url';
  try {
    await assert.rejects(
      () => fetchOfficialMediaBytes({ url: '/chapter.gpx' }),
      /URL publique Strapi est invalide/
    );
  } finally {
    if (previous === undefined) delete process.env.STRAPI_PUBLIC_URL;
    else process.env.STRAPI_PUBLIC_URL = previous;
  }
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

test('runGpxAnchorPreparation never exposes internal Maps in a blocked JSON report', async () => {
  const validBytes = new TextEncoder().encode('<gpx version="1.1"><trk><trkseg><trkpt lat="0" lon="0" /><trkpt lat="0" lon="1" /></trkseg></trk></gpx>');
  const chapter = {
    documentId: 'chapter-blocked',
    slug: 'blocked',
    title: 'Bloqué',
    displayOrder: 1,
    gpxFileAB: { url: '/valid.gpx' },
    gpxFileBA: { url: '/invalid.gpx' },
    cityPassages: [
      {
        id: 1,
        role: 'start',
        city: { documentId: 'city-a', name: 'A', latitude: 0, longitude: 0.1 },
      },
      {
        id: 2,
        role: 'end',
        city: { documentId: 'city-b', name: 'B', latitude: 0, longitude: 0.9 },
      },
    ],
  };

  const report = await runGpxAnchorPreparation({
    adapter: {
      listChapters: async () => [chapter],
      updateChapter: async () => assert.fail('Le dry-run ne doit rien écrire.'),
    },
    fetchMediaBytes: async (_media: unknown, _chapter: unknown, direction: string) => {
      if (direction === 'BA') throw new Error('Source BA indisponible.');
      return validBytes;
    },
    resolutions: emptyResolutions(),
  });
  const serialized = JSON.parse(JSON.stringify(report));

  assert.equal(serialized.summary.blocked, 1);
  assert.equal('resolvedByPassage' in serialized.chapters[0].directions.AB, false);
});
