import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAPTER_PUBLICATION_LOCK_KEY,
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
  const findManyArguments: unknown[] = [];
  const globalFindOneArguments: unknown[] = [];

  return {
    strapi: {
      db: {
        query: (uid: string) => ({
          findMany: async (options: unknown) => {
            queryCount += 1;
            findManyArguments.push(options);
            return publishedChapters;
          },
          findOne: async (options: unknown) => {
            if (uid === 'api::global.global') {
              globalFindOneArguments.push(options);
              return { gpxBuilderEnabled: false };
            }
            return null;
          },
        }),
      },
    },
    getQueryCount: () => queryCount,
    getFindManyArguments: () => findManyArguments,
    getGlobalFindOneArguments: () => globalFindOneArguments,
  };
}

function createSerializedStrapiMock(events: string[], globalEnabled = false) {
  const draft = {
    ...publishedChapters[2],
    cityPassages: [
      { role: 'start', city: { documentId: 'city-1' } },
      { role: 'end', city: { documentId: 'city-2' } },
    ],
  };

  return {
    db: {
      transaction: async (callback: (context: {
        trx: { raw: (sql: string, bindings: unknown[]) => Promise<void> };
      }) => Promise<unknown>) => {
        events.push('transaction:start');
        const result = await callback({
          trx: {
            raw: async (sql, bindings) => {
              assert.equal(sql, 'SELECT pg_advisory_xact_lock(?)');
              assert.deepEqual(bindings, [CHAPTER_PUBLICATION_LOCK_KEY]);
              events.push('lock:advisory');
            },
          },
        });
        events.push('transaction:end');
        return result;
      },
      query: (uid: string) => ({
        findMany: async () => {
          events.push('validation:read-published');
          return publishedChapters;
        },
        findOne: async () => {
          events.push('validation:read-one');
          if (uid === 'api::global.global') {
            return { gpxBuilderEnabled: globalEnabled };
          }
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

test('validateChapterDocument keeps disabled-builder reads lean and scopes the Global lookup', async () => {
  const {
    strapi,
    getFindManyArguments,
    getGlobalFindOneArguments,
  } = createStrapiMock();

  await validateChapterDocument(strapi as never, {
    action: 'delete',
    contentType: { uid: 'api::chapter.chapter' },
    params: { documentId: 'chapter-3' },
  });

  assert.deepEqual(getGlobalFindOneArguments(), [{
    where: {},
    select: ['gpxBuilderEnabled'],
  }]);
  assert.equal('populate' in (getFindManyArguments()[0] as Record<string, unknown>), false);
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

const publishedMutationCases = [
  {
    label: 'publish',
    context: {
      action: 'publish',
      contentType: { uid: 'api::chapter.chapter' },
      params: { documentId: 'chapter-3' },
    },
  },
  {
    label: 'unpublish',
    context: {
      action: 'unpublish',
      contentType: { uid: 'api::chapter.chapter' },
      params: { documentId: 'chapter-3' },
    },
  },
  {
    label: 'delete',
    context: {
      action: 'delete',
      contentType: { uid: 'api::chapter.chapter' },
      params: { documentId: 'chapter-3' },
    },
  },
  {
    label: 'create with published status',
    context: {
      action: 'create',
      contentType: { uid: 'api::chapter.chapter' },
      params: {
        status: 'published',
        data: {
          title: 'Chapitre 4',
          slug: 'chapter-4',
          displayOrder: 4,
          cityPassages: [
            { role: 'start', city: { documentId: 'city-1' } },
            { role: 'end', city: { documentId: 'city-2' } },
          ],
        },
      },
    },
  },
  {
    label: 'update with published status',
    context: {
      action: 'update',
      contentType: { uid: 'api::chapter.chapter' },
      params: { documentId: 'chapter-3', status: 'published', data: {} },
    },
  },
];

test('CHAPTER_PUBLICATION_LOCK_KEY is a stable GTHF namespace', () => {
  assert.equal(CHAPTER_PUBLICATION_LOCK_KEY, 0x47544846);
});

test('runDocumentMiddleware refuses to enable the GPX Builder with incomplete chapters', async () => {
  const events: string[] = [];
  const strapi = createSerializedStrapiMock(events);

  await assert.rejects(
    () => runDocumentMiddleware(strapi as never, {
      action: 'update',
      contentType: { uid: 'api::global.global' },
      params: { data: { gpxBuilderEnabled: true } },
    } as never, async () => {
      events.push('next');
    }),
    /deux médias GPX officiels/
  );
  assert.equal(events.includes('lock:advisory'), true);
  assert.equal(events.includes('next'), false);
});

test('runDocumentMiddleware ignores unrelated Global updates while the builder remains enabled', async () => {
  const events: string[] = [];
  const strapi = createSerializedStrapiMock(events, true);

  await runDocumentMiddleware(strapi as never, {
    action: 'update',
    contentType: { uid: 'api::global.global' },
    params: { data: { siteName: 'GTHF' } },
  } as never, async () => {
    events.push('next');
  });

  assert.equal(events.includes('transaction:start'), false);
  assert.equal(events.includes('validation:read-published'), false);
  assert.equal(events.includes('next'), true);
});

test('runDocumentMiddleware does not revalidate an already enabled builder', async () => {
  const events: string[] = [];
  const strapi = createSerializedStrapiMock(events, true);

  await runDocumentMiddleware(strapi as never, {
    action: 'update',
    contentType: { uid: 'api::global.global' },
    params: { data: { gpxBuilderEnabled: true, siteName: 'GTHF' } },
  } as never, async () => {
    events.push('next');
  });

  assert.equal(events.includes('lock:advisory'), true);
  assert.equal(events.includes('validation:read-published'), false);
  assert.equal(events.includes('next'), true);
});

for (const { label, context } of publishedMutationCases) {
  test(`runDocumentMiddleware serializes ${label} before validation and next`, async () => {
    const events: string[] = [];
    const strapi = createSerializedStrapiMock(events);
    const result = await runDocumentMiddleware(strapi as never, context as never, async () => {
      events.push('next');
      return 'completed';
    });

    assert.equal(result, 'completed');
    assert.equal(events[0], 'transaction:start');
    assert.equal(events[1], 'lock:advisory');

    const lockIndex = events.indexOf('lock:advisory');
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

const draftMutationCases = [
  {
    label: 'discardDraft',
    context: {
      action: 'discardDraft',
      contentType: { uid: 'api::chapter.chapter' },
      params: { documentId: 'chapter-2' },
    },
  },
  {
    label: 'create with draft status',
    context: {
      action: 'create',
      contentType: { uid: 'api::chapter.chapter' },
      params: { status: 'draft', data: {} },
    },
  },
  {
    label: 'update with draft status',
    context: {
      action: 'update',
      contentType: { uid: 'api::chapter.chapter' },
      params: { documentId: 'chapter-2', status: 'draft', data: {} },
    },
  },
];

for (const { label, context } of draftMutationCases) {
  test(`runDocumentMiddleware does not lock ${label}`, async () => {
    const events: string[] = [];
    const strapi = createSerializedStrapiMock(events);

    await runDocumentMiddleware(strapi as never, context as never, async () => {
      events.push('next');
    });

    assert.equal(events.includes('transaction:start'), false);
    assert.equal(events.includes('lock:advisory'), false);
    assert.equal(events.includes('next'), true);
  });
}
