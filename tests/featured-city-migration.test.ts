import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import migration from '../scripts/migrate-featured-city-passages.js';

const {
  buildFeaturedPassageUpdate,
  loadFeaturedCitySelection,
  runFeaturedCityMigration,
} = migration;

test('loadFeaturedCitySelection rejects more than six cities for one chapter', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gthf-featured-selection-'));
  const selectionPath = join(directory, 'selection.json');

  try {
    writeFileSync(selectionPath, JSON.stringify({
      version: 1,
      chapters: [{
        chapterSlug: 'hirson-a-soissons',
        featuredCities: Array.from({ length: 7 }, (_, index) => ({
          name: `Ville ${index + 1}`,
          municipalityKey: `FR-0000${index + 1}`,
        })),
      }],
    }));

    assert.throws(
      () => loadFeaturedCitySelection(selectionPath),
      /au maximum 6 villes/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('buildFeaturedPassageUpdate changes only featured while preserving passage data', () => {
  const update = buildFeaturedPassageUpdate({
    cityPassages: [
      {
        id: 10,
        role: 'start',
        featured: true,
        note: 'Départ',
        city: { documentId: 'city-start', municipalityKey: 'FR-00001' },
      },
      {
        id: 11,
        role: 'intermediate',
        featured: false,
        note: 'À conserver',
        city: { documentId: 'city-featured', municipalityKey: 'FR-00002' },
      },
      {
        id: 12,
        role: 'intermediate',
        featured: true,
        city: { documentId: 'city-hidden', municipalityKey: 'FR-00003' },
      },
      {
        id: 13,
        role: 'end',
        featured: true,
        city: { documentId: 'city-end', municipalityKey: 'FR-00004' },
      },
    ],
  }, ['FR-00002']);

  assert.deepEqual(update, [
    {
      id: 10,
      role: 'start',
      featured: false,
      note: 'Départ',
      city: { documentId: 'city-start' },
    },
    {
      id: 11,
      role: 'intermediate',
      featured: true,
      note: 'À conserver',
      city: { documentId: 'city-featured' },
    },
    {
      id: 12,
      role: 'intermediate',
      featured: false,
      city: { documentId: 'city-hidden' },
    },
    {
      id: 13,
      role: 'end',
      featured: false,
      city: { documentId: 'city-end' },
    },
  ]);
});

test('buildFeaturedPassageUpdate rejects a selected city absent from intermediate passages', () => {
  assert.throws(
    () => buildFeaturedPassageUpdate({
      cityPassages: [{
        role: 'start',
        featured: false,
        city: { documentId: 'city-start', municipalityKey: 'FR-00001' },
      }],
    }, ['FR-99999']),
    /n’est pas un passage intermédiaire/
  );
});

test('runFeaturedCityMigration is dry-run by default and idempotent after apply', async () => {
  const chapter = {
    documentId: 'chapter-1',
    slug: 'hirson-a-soissons',
    title: 'Hirson → Soissons',
    cityPassages: [
      {
        id: 1,
        role: 'start',
        featured: false,
        city: { documentId: 'city-1', municipalityKey: 'FR-00001' },
      },
      {
        id: 2,
        role: 'intermediate',
        featured: false,
        city: { documentId: 'city-2', municipalityKey: 'FR-00002' },
      },
      {
        id: 3,
        role: 'end',
        featured: false,
        city: { documentId: 'city-3', municipalityKey: 'FR-00003' },
      },
    ],
  };
  const selection = [{
    chapterSlug: chapter.slug,
    featuredCities: [{ name: 'Ville 2', municipalityKey: 'FR-00002' }],
  }];
  let updateCalls = 0;
  const adapter = {
    listChapters: async () => [chapter],
    updateChapter: async (_documentId: string, cityPassages: typeof chapter.cityPassages) => {
      updateCalls += 1;
      chapter.cityPassages = chapter.cityPassages.map((passage, index) => ({
        ...passage,
        featured: cityPassages[index].featured,
      }));
    },
  };

  const dryRun = await runFeaturedCityMigration({ adapter, selection });
  const applied = await runFeaturedCityMigration({ adapter, selection, apply: true });
  const secondRun = await runFeaturedCityMigration({ adapter, selection, apply: true });

  assert.equal(dryRun.summary.chaptersReady, 1);
  assert.equal(updateCalls, 1);
  assert.equal(applied.summary.chaptersUpdated, 1);
  assert.equal(secondRun.summary.chaptersUnchanged, 1);
});
