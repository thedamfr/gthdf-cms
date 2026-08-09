import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAPTER_PUBLICATION_LOCK_KEY,
  CATALOGUE_SOURCE_LOCK_KEY,
  runAsCatalogueSystemMutation,
  runDocumentMiddleware,
  validateCityItineraryDocument,
  validateChapterDocument,
  validateItineraryRedirectDocument,
} from '../src/index.ts';
import { computeArtifactIntegrityHash } from '../src/domain/catalogue-validation.ts';

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
              assert.equal(
                bindings[0] === CHAPTER_PUBLICATION_LOCK_KEY || bindings[0] === CATALOGUE_SOURCE_LOCK_KEY,
                true,
              );
              events.push(bindings[0] === CHAPTER_PUBLICATION_LOCK_KEY ? 'lock:advisory' : 'lock:catalogue');
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
        updateMany: async () => {
          events.push(`catalogue:invalidate:${uid}`);
          return { count: 1 };
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

test('le middleware bloque les mutations manuelles calculées mais laisse passer le job catalogue', async () => {
  const nextCalls: string[] = [];
  const next = async () => { nextCalls.push('next'); };
  const strapi = {
    db: {
      transaction: async (callback: any) => callback({
        trx: { raw: async () => undefined },
      }),
      query: () => assert.fail('La garde doit précéder toute lecture de données.'),
    },
  };

  await assert.rejects(
    () => runDocumentMiddleware(strapi as never, {
      action: 'update',
      contentType: { uid: 'api::route-anchor.route-anchor' },
      params: { documentId: 'anchor-doc', data: { projectedLatitude: 50.1 } },
    } as never, next),
    /projectedLatitude.*job catalogue/,
  );
  await assert.rejects(
    () => runDocumentMiddleware(strapi as never, {
      action: 'update',
      contentType: { uid: 'api::catalogue-run.catalogue-run' },
      params: { documentId: 'run-doc', data: { status: 'succeeded' } },
    } as never, next),
    /status.*job catalogue/,
  );

  await runAsCatalogueSystemMutation(() => runDocumentMiddleware(strapi as never, {
    action: 'update',
    contentType: { uid: 'api::catalogue-run.catalogue-run' },
    params: { documentId: 'run-doc', data: { status: 'succeeded' } },
  } as never, next));
  assert.deepEqual(nextCalls, ['next']);
});

test('une redirection exige une cible canonique publiée et libre de collision', async () => {
  const itineraryReads: any[] = [];
  const strapi = {
    db: {
      query: (uid: string) => ({
        findOne: async (options: any) => {
          if (uid !== 'api::city-itinerary.city-itinerary') return null;
          itineraryReads.push(options);
          if (options.where.documentId === 'target-doc') {
            return { documentId: 'target-doc', slug: 'nouveau-slug', publishedAt: '2026-08-09T10:00:00Z' };
          }
          return null;
        },
      }),
    },
  };
  const context = {
    action: 'create',
    contentType: { uid: 'api::itinerary-slug-redirect.itinerary-slug-redirect' },
    params: {
      data: {
        oldSlug: 'ancien-slug',
        itinerary: { connect: [{ documentId: 'target-doc' }] },
        enabled: true,
        reason: 'Changement éditorial validé.',
      },
    },
  };

  await assert.doesNotReject(() => validateItineraryRedirectDocument(strapi as never, context as never));
  assert.deepEqual(itineraryReads.at(-1), {
    where: {
      slug: 'ancien-slug',
      publishedAt: { $ne: null },
      documentId: { $ne: 'target-doc' },
    },
    select: ['documentId'],
  });

  const collidingStrapi = {
    db: {
      query: () => ({
        findOne: async (options: any) => options.where.documentId === 'target-doc'
          ? { documentId: 'target-doc', slug: 'nouveau-slug', publishedAt: '2026-08-09T10:00:00Z' }
          : { documentId: 'other-doc' },
      }),
    },
  };
  await assert.rejects(
    () => validateItineraryRedirectDocument(collidingStrapi as never, context as never),
    /itinéraire publié/,
  );
});

test('une redirection refuse de pointer le slug canonique vers lui-même', async () => {
  const strapi = {
    db: {
      query: () => ({
        findOne: async (options: any) => options.where.documentId === 'target-doc'
          ? { documentId: 'target-doc', slug: 'slug-canonique', publishedAt: '2026-08-09T10:00:00Z' }
          : null,
      }),
    },
  };
  const context = {
    action: 'create',
    contentType: { uid: 'api::itinerary-slug-redirect.itinerary-slug-redirect' },
    params: {
      data: {
        oldSlug: 'slug-canonique',
        itinerary: { documentId: 'target-doc' },
        enabled: true,
        reason: 'Ancienne URL revue.',
      },
    },
  };

  await assert.rejects(
    () => validateItineraryRedirectDocument(strapi as never, context as never),
    /slug canonique/,
  );
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

test('validateCityItineraryDocument hydrate une activeRevision entrante avant activation', async () => {
  const evaluationHash = 'a'.repeat(64);
  const sourceHash = 'b'.repeat(64);
  const generatedGpxSha256 = 'c'.repeat(64);
  const displayGeometrySha256 = 'd'.repeat(64);
  const businessKey = 'route-locale:FR-A:FR-B';
  const revisionReads: unknown[] = [];
  const revision = {
    documentId: 'revision-doc',
    itinerary: { documentId: 'itinerary-doc', businessKey },
    departure: { documentId: 'city-a', municipalityKey: 'FR-A' },
    arrival: { documentId: 'city-b', municipalityKey: 'FR-B' },
    calculationStatus: 'ready',
    warningApproved: false,
    warningApprovedAt: null,
    warningApprovedBy: null,
    eligibleByRoute: true,
    eligibleByDirect: true,
    generatedGpx: { documentId: 'gpx-media', url: '/fixture.gpx' },
    generatedGpxSha256,
    displayGeometry: { documentId: 'geometry-media', url: '/fixture.json' },
    displayGeometrySha256,
    sourceHash,
    lastVerifiedEvaluationHash: evaluationHash,
    artifactIntegrityStatus: 'verified',
    artifactIntegrityHash: computeArtifactIntegrityHash({
      sourceHash,
      generatedGpxSha256,
      displayGeometrySha256,
    }),
  };
  const draft = {
    documentId: 'itinerary-doc',
    businessKey,
    title: 'Fixture locale',
    slug: 'fixture-locale',
    reviewStatus: 'approved',
    publicationNext: false,
    currentEvaluationHash: evaluationHash,
    route: { documentId: 'route-doc', routeKey: 'route-locale', catalogueEnabled: true },
    cityA: { documentId: 'city-a', municipalityKey: 'FR-A' },
    cityB: { documentId: 'city-b', municipalityKey: 'FR-B' },
    activeRevision: null,
  };
  const strapi = {
    db: {
      query: (uid: string) => ({
        findOne: async (options: unknown) => {
          if (uid === 'api::city-itinerary.city-itinerary') return draft;
          if (uid === 'api::itinerary-revision.itinerary-revision') {
            revisionReads.push(options);
            return revision;
          }
          return null;
        },
      }),
    },
  };

  await assert.doesNotReject(() => validateCityItineraryDocument(strapi as never, {
    action: 'update',
    contentType: { uid: 'api::city-itinerary.city-itinerary' },
    params: {
      documentId: 'itinerary-doc',
      status: 'draft',
      data: { activeRevision: 'revision-doc', publicationNext: true },
    },
  }));
  assert.equal(revisionReads.length, 1);
  assert.deepEqual((revisionReads[0] as any).where, { documentId: 'revision-doc' });
  assert.equal((revisionReads[0] as any).populate.itinerary, true);
  assert.equal((revisionReads[0] as any).populate.generatedGpx, true);
});
