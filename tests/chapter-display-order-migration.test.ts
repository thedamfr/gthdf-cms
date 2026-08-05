import assert from 'node:assert/strict';
import test from 'node:test';

import migration from '../scripts/migrate-chapter-display-order.js';

const {
  CHAPTER_DISPLAY_ORDERS,
  createStrapiAdapter,
  parseDisplayOrderMigrationArguments,
  runChapterDisplayOrderMigration,
} = migration;

function createChapterVersions(displayOrders: Record<string, number | null> = {}) {
  return CHAPTER_DISPLAY_ORDERS.flatMap(({ slug, displayOrder }: {
    slug: string;
    displayOrder: number;
  }) => {
    const currentOrder = Object.prototype.hasOwnProperty.call(displayOrders, slug)
      ? displayOrders[slug]
      : null;

    return [
      {
        id: `${slug}-draft`,
        documentId: `document-${slug}`,
        slug,
        title: slug,
        displayOrder: currentOrder,
        publishedAt: null,
        untouched: `draft-${displayOrder}`,
      },
      {
        id: `${slug}-published`,
        documentId: `document-${slug}`,
        slug,
        title: slug,
        displayOrder: currentOrder,
        publishedAt: '2026-08-05T12:00:00.000Z',
        untouched: `published-${displayOrder}`,
      },
    ];
  });
}

test('CHAPTER_DISPLAY_ORDERS maps the ten canonical slugs to 1 through 10', () => {
  assert.deepEqual(CHAPTER_DISPLAY_ORDERS, [
    { slug: 'lille-a-arras', displayOrder: 1 },
    { slug: 'arras-a-conde-sur-l-escaut', displayOrder: 2 },
    { slug: 'conde-sur-l-escaut-a-hirson', displayOrder: 3 },
    { slug: 'hirson-a-soissons', displayOrder: 4 },
    { slug: 'soissons-a-beauvais', displayOrder: 5 },
    { slug: 'beauvais-a-amiens', displayOrder: 6 },
    { slug: 'amiens-a-etaples', displayOrder: 7 },
    { slug: 'etaples-a-calais', displayOrder: 8 },
    { slug: 'calais-a-saint-omer', displayOrder: 9 },
    { slug: 'st-omer-lille', displayOrder: 10 },
  ]);
});

test('parseDisplayOrderMigrationArguments keeps dry-run as the safe default', () => {
  assert.deepEqual(parseDisplayOrderMigrationArguments([], '/workspace'), {
    apply: false,
    confirmRemote: false,
    help: false,
    remote: false,
    reportPath: '/workspace/.tmp/chapter-display-order-migration-report.json',
  });
});

test('runChapterDisplayOrderMigration is read-only during dry-run', async () => {
  const versions = createChapterVersions();
  let applyCalls = 0;

  const report = await runChapterDisplayOrderMigration({
    adapter: {
      listChapterVersions: async () => versions,
      applyDisplayOrders: async () => {
        applyCalls += 1;
      },
    },
    generatedAt: '2026-08-05T12:00:00.000Z',
  });

  assert.equal(report.mode, 'dry-run');
  assert.equal(report.summary.chaptersReady, 10);
  assert.equal(report.summary.chaptersUpdated, 0);
  assert.equal(report.summary.chaptersBlocked, 0);
  assert.equal(applyCalls, 0);
  assert.equal(versions.every((version: { displayOrder: number | null }) => (
    version.displayOrder === null
  )), true);
});

test('runChapterDisplayOrderMigration updates draft and published versions once', async () => {
  const versions = createChapterVersions();
  let applyCalls = 0;

  const adapter = {
    listChapterVersions: async () => versions,
    applyDisplayOrders: async (updates: Array<{
      documentId: string;
      displayOrder: number;
      expectedVersionCount: number;
    }>) => {
      applyCalls += 1;
      assert.equal(updates.length, 10);
      for (const update of updates) {
        assert.equal(update.expectedVersionCount, 2);
        for (const version of versions.filter((candidate: { documentId: string }) => (
          candidate.documentId === update.documentId
        ))) {
          version.displayOrder = update.displayOrder;
        }
      }
    },
  };

  const applied = await runChapterDisplayOrderMigration({ adapter, apply: true });
  const secondRun = await runChapterDisplayOrderMigration({ adapter, apply: true });

  assert.equal(applyCalls, 1);
  assert.equal(applied.summary.chaptersUpdated, 10);
  assert.equal(secondRun.summary.chaptersUnchanged, 10);

  for (const { slug, displayOrder } of CHAPTER_DISPLAY_ORDERS) {
    const matchingVersions = versions.filter((version: { slug: string }) => version.slug === slug);
    assert.deepEqual(
      matchingVersions.map((version: { displayOrder: number }) => version.displayOrder),
      [displayOrder, displayOrder]
    );
    assert.deepEqual(
      matchingVersions.map((version: { untouched: string }) => version.untouched),
      [`draft-${displayOrder}`, `published-${displayOrder}`]
    );
  }
});

test('runChapterDisplayOrderMigration blocks the whole apply when a version is missing', async () => {
  const versions = createChapterVersions().filter((version: { id: string }) => (
    version.id !== 'lille-a-arras-published'
  ));
  let applyCalls = 0;

  const report = await runChapterDisplayOrderMigration({
    adapter: {
      listChapterVersions: async () => versions,
      applyDisplayOrders: async () => {
        applyCalls += 1;
      },
    },
    apply: true,
  });

  assert.equal(report.summary.chaptersBlocked, 1);
  assert.match(report.errors[0].message, /version publiée/i);
  assert.equal(applyCalls, 0);
});

test('createStrapiAdapter updates only displayOrder on both document versions', async () => {
  const updateCalls: unknown[] = [];
  const chapterQuery = {
    findMany: async () => [],
    updateMany: async (params: unknown) => {
      updateCalls.push(params);
      return { count: 2 };
    },
  };
  const strapi = {
    db: {
      query: () => chapterQuery,
      transaction: async (callback: () => Promise<void>) => callback(),
    },
  };
  const adapter = createStrapiAdapter(strapi);

  await adapter.applyDisplayOrders([{
    documentId: 'chapter-document',
    displayOrder: 4,
    expectedVersionCount: 2,
  }]);

  assert.deepEqual(updateCalls, [{
    where: { documentId: 'chapter-document' },
    data: { displayOrder: 4 },
  }]);
});
