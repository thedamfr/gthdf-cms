import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runDocumentMiddleware,
  validateChapterDocument,
} from '../src/index.ts';

const publishedChapters = [
  {
    documentId: 'chapter-1',
    slug: 'chapter-1',
    title: 'Chapitre 1',
    displayOrder: 1,
  },
  {
    documentId: 'chapter-2',
    slug: 'chapter-2',
    title: 'Chapitre 2',
    displayOrder: 2,
  },
  {
    documentId: 'chapter-3',
    slug: 'chapter-3',
    title: 'Chapitre 3',
    displayOrder: 3,
  },
];

function createStrapiMock() {
  let queryCount = 0;

  return {
    strapi: {
      db: {
        query: () => ({
          findMany: async () => {
            queryCount += 1;
            return publishedChapters;
          },
        }),
      },
    },
    getQueryCount: () => queryCount,
  };
}

function createSerializedStrapiMock(events: string[]) {
  const queryBuilder = {
    select: (field: string) => {
      events.push(`lock:select:${field}`);
      return queryBuilder;
    },
    orderBy: (orderBy: unknown) => {
      events.push(`lock:order:${JSON.stringify(orderBy)}`);
      return queryBuilder;
    },
    forUpdate: () => {
      events.push('lock:for-update');
      return queryBuilder;
    },
    execute: async () => {
      events.push('lock:execute');
      return [];
    },
  };
  const draft = {
    ...publishedChapters[2],
    cityPassages: [
      { role: 'start', city: { documentId: 'city-1' } },
      { role: 'end', city: { documentId: 'city-2' } },
    ],
  };

  return {
    db: {
      transaction: async (callback: () => Promise<unknown>) => {
        events.push('transaction:start');
        const result = await callback();
        events.push('transaction:end');
        return result;
      },
      queryBuilder: () => queryBuilder,
      query: () => ({
        findMany: async () => {
          events.push('validation:read-published');
          return publishedChapters;
        },
        findOne: async () => {
          events.push('validation:read-one');
          return draft;
        },
      }),
    },
  };
}

for (const action of ['unpublish', 'delete']) {
  test(`validateChapterDocument rejects ${action} when it removes an intermediate order`, async () => {
    const { strapi } = createStrapiMock();

    await assert.rejects(
      () => validateChapterDocument(strapi as never, {
        action,
        contentType: { uid: 'api::chapter.chapter' },
        params: { documentId: 'chapter-2' },
      }),
      /impossible de retirer.*Chapitre 2/i
    );
  });
}

test('validateChapterDocument accepts deleting the highest published order', async () => {
  const { strapi } = createStrapiMock();

  await assert.doesNotReject(() => validateChapterDocument(strapi as never, {
    action: 'delete',
    contentType: { uid: 'api::chapter.chapter' },
    params: { documentId: 'chapter-3' },
  }));
});

test('validateChapterDocument ignores discardDraft without querying published chapters', async () => {
  const { strapi, getQueryCount } = createStrapiMock();

  await assert.doesNotReject(() => validateChapterDocument(strapi as never, {
    action: 'discardDraft',
    contentType: { uid: 'api::chapter.chapter' },
    params: { documentId: 'chapter-2' },
  }));

  assert.equal(getQueryCount(), 0);
});

for (const action of ['publish', 'unpublish', 'delete']) {
  test(`runDocumentMiddleware serializes ${action} before validation and next`, async () => {
    const events: string[] = [];
    const strapi = createSerializedStrapiMock(events);
    const result = await runDocumentMiddleware(strapi as never, {
      action,
      contentType: { uid: 'api::chapter.chapter' },
      params: { documentId: 'chapter-3' },
    }, async () => {
      events.push('next');
      return 'completed';
    });

    assert.equal(result, 'completed');
    assert.equal(events[0], 'transaction:start');
    assert.deepEqual(events.slice(1, 5), [
      'lock:select:id',
      'lock:order:{"id":"asc"}',
      'lock:for-update',
      'lock:execute',
    ]);

    const lockIndex = events.indexOf('lock:execute');
    const validationIndexes = events
      .map((event, index) => event.startsWith('validation:') ? index : -1)
      .filter((index) => index >= 0);
    const nextIndex = events.indexOf('next');
    const transactionEndIndex = events.indexOf('transaction:end');

    assert.equal(validationIndexes.length > 0, true);
    assert.equal(validationIndexes.every((index) => index > lockIndex), true);
    assert.equal(validationIndexes.every((index) => index < nextIndex), true);
    assert.equal(transactionEndIndex > nextIndex, true);
  });
}

test('runDocumentMiddleware does not serialize discardDraft', async () => {
  const events: string[] = [];
  const strapi = createSerializedStrapiMock(events);

  await runDocumentMiddleware(strapi as never, {
    action: 'discardDraft',
    contentType: { uid: 'api::chapter.chapter' },
    params: { documentId: 'chapter-2' },
  }, async () => {
    events.push('next');
  });

  assert.deepEqual(events, ['next']);
});
