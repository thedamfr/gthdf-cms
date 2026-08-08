import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRevisionReverificationData,
  CatalogueStrapiAdapter,
  testing,
} from '../scripts/catalogue/strapi-adapter';

function operation(calculationStatus: 'ready' | 'warning') {
  return {
    evaluationHash: 'a'.repeat(64),
    sourceHash: 'b'.repeat(64),
    generatedGpxSha256: 'c'.repeat(64),
    displayGeometrySha256: 'd'.repeat(64),
    calculationStatus,
    qualityWarningCodes: calculationStatus === 'warning' ? ['accepted_gap'] : [],
    directDistanceMethod: 'vincenty',
    differences: [],
    thresholdQaComparison: {
      referenceProductId: 'FR-1__FR-2',
      status: 'different',
      differenceCodes: ['route_distance'],
    },
  } as any;
}

test('une révision archivée redevient ready lors d’une revérification source exacte', () => {
  const data = buildRevisionReverificationData(operation('ready'), 42);
  assert.equal(data.calculationStatus, 'ready');
  assert.equal(data.artifactIntegrityStatus, 'verified');
  assert.equal(data.warningApproved, false);
  assert.equal(data.warningApprovedAt, null);
  assert.equal(data.warningApprovedBy, null);
  assert.deepEqual((data.calculationReport as any).thresholdQaComparison, {
    referenceProductId: 'FR-1__FR-2',
    status: 'different',
    differenceCodes: ['route_distance'],
  });
});

test('une warning exacte conserve sa décision éditoriale existante', () => {
  const data = buildRevisionReverificationData(operation('warning'), 42);
  assert.equal(data.calculationStatus, 'warning');
  assert.equal(Object.hasOwn(data, 'warningApproved'), false);
});

test('une opération de revue QA est explicitement ignorée par apply', async () => {
  const adapter = new CatalogueStrapiAdapter({} as any);
  const result = await adapter.applyOperation({
    operation: {
      kind: 'threshold_qa_review',
      key: 'threshold-qa:FR-1__FR-2',
      action: 'review',
      businessKey: 'route:FR-1:FR-2',
      cityAKey: 'FR-1',
      cityBKey: 'FR-2',
      referenceProductId: 'FR-1__FR-2',
      qaStatus: 'different',
      differenceCodes: ['retained'],
      reason: 'ineligible_mismatch',
    },
  } as any);
  assert.equal(result, 'skipped');
});

test('les relations média Strapi utilisent toujours l’id numérique, jamais le documentId', () => {
  const media = { id: 41, documentId: 'media-document-id' };
  assert.equal(testing.requireMediaRelationId(media, 'GPX généré'), 41);
  assert.throws(
    () => testing.requireMediaRelationId({ documentId: 'media-document-id' }, 'GPX généré'),
    /identifiant numérique Strapi/,
  );
});

test('la pagination Documents API utilise start/limit à plat et termine après la dernière page', async () => {
  const source = Array.from({ length: 223 }, (_, index) => ({
    id: index + 1,
    documentId: `document-${String(index + 1).padStart(3, '0')}`,
  }));
  const calls: Array<Record<string, any>> = [];
  const app = {
    documents: (uid: string) => {
      assert.equal(uid, 'api::city.city');
      return {
        findMany: async (options: Record<string, any>) => {
          calls.push(options);
          if (calls.length > 3) throw new Error('pagination non bornée');
          // Strapi 5 ignore la clé REST imbriquée `pagination` dans son
          // Document Service et ne transmet que les paramètres plats.
          const start = Number(options.start ?? 0);
          const limit = Number(options.limit ?? source.length);
          return source.slice(start, start + limit);
        },
      };
    },
  };

  const documents = await testing.listDocuments(app, 'api::city.city', {
    status: 'draft',
  });

  assert.deepEqual(documents, source);
  assert.deepEqual(calls.map(({ start, limit }) => ({ start, limit })), [
    { start: 0, limit: 100 },
    { start: 100, limit: 100 },
    { start: 200, limit: 100 },
  ]);
  assert.equal(calls.every((options) => !Object.hasOwn(options, 'pagination')), true);
});

test('la lecture d’un document utilise aussi la pagination plate et bornée', async () => {
  let received: Record<string, any> | null = null;
  const app = {
    documents: () => ({
      findMany: async (options: Record<string, any>) => {
        received = options;
        return [{ documentId: 'first-document' }];
      },
    }),
  };

  const document = await testing.findDocument(app, 'api::reference-route.reference-route', {
    status: 'published',
  });

  assert.equal(document.documentId, 'first-document');
  assert.deepEqual(received, {
    status: 'published',
    sort: ['documentId:asc', 'id:asc'],
    start: 0,
    limit: 1,
  });
});

test('une archive ferme l’empreinte de toutes les versions D&P du document', async () => {
  const writes: Array<{ uid: string; method: string; input: unknown }> = [];
  const draft = {
    documentId: 'itinerary-document',
    activeRevision: { documentId: 'revision-draft', revisionKey: 'revision-r2' },
    revisions: [{ revisionKey: 'revision-r1' }, { revisionKey: 'revision-r2' }],
  };
  const app = {
    documents: (uid: string) => ({
      findMany: async () => uid === 'api::city-itinerary.city-itinerary' ? [draft] : [],
      update: async (input: unknown) => {
        writes.push({ uid, method: 'update', input });
        return {};
      },
    }),
    db: {
      query: (uid: string) => ({
        updateMany: async (input: unknown) => {
          writes.push({ uid, method: 'updateMany', input });
          return { count: 2 };
        },
      }),
    },
  };
  const adapter = new CatalogueStrapiAdapter({ app } as any);
  const result = await (adapter as any).applyArchive({
    kind: 'archive_itinerary',
    itineraryDocumentId: 'itinerary-document',
    activeRevisionKey: 'revision-r2',
  });
  assert.equal(result, 'reused');
  assert.deepEqual(writes.find((write) => write.method === 'updateMany'), {
    uid: 'api::city-itinerary.city-itinerary',
    method: 'updateMany',
    input: {
      where: { documentId: 'itinerary-document' },
      data: { currentEvaluationHash: null },
    },
  });
  assert.equal(
    writes.some((write) => write.uid === 'api::itinerary-revision.itinerary-revision'
      && (write.input as any).data.calculationStatus === 'archived'),
    true,
  );
});

test('un checkpoint Strapi verrouille et refuse un lease repris avant toute écriture du run', async () => {
  let updateCalls = 0;
  const app = {
    db: {
      transaction: async (callback: (input: { trx: any }) => Promise<unknown>) => callback({
        trx: {
          raw: async (sql: string, bindings: unknown[]) => {
            assert.match(sql, /expires_at >= now\(\)/);
            assert.match(sql, /FOR UPDATE/);
            assert.deepEqual(bindings, ['catalogue-apply-v1', 'catalogue:report', 'worker-a']);
            return { rows: [] };
          },
        },
      }),
      query: () => ({
        update: async () => {
          updateCalls += 1;
          return { id: 1 };
        },
      }),
    },
  };
  const adapter = new CatalogueStrapiAdapter({ app } as any);
  (adapter as any).runEntity = { id: 1 };

  await assert.rejects(() => adapter.checkpointRun({
    lockKey: 'catalogue-apply-v1',
    runKey: 'catalogue:report',
    ownerKey: 'worker-a',
    status: 'failed',
    cursor: 1,
    counters: { created: 1 },
    heartbeatAt: '2026-08-08T00:00:00.000Z',
  }), /lease a expiré ou changé de propriétaire/);
  assert.equal(updateCalls, 0);
});

test('le contrat chapitre ne retient que les ancres AB PRD03 validées avec leur provenance complète', () => {
  const anchors = testing.primaryAnchorsFromChapterEntity({
    slug: 'chapter',
    cityPassages: [
      {
        city: { municipalityKey: 'FR-00001' },
        gpxAnchorAB: {
          status: 'validated',
          sourceSha256: 'a'.repeat(64),
          trackIndex: 0,
          segmentIndex: 1,
          pointIndex: 2,
          fraction: 0.25,
          chainageMetres: 123.5,
          projectedLatitude: 50,
          projectedLongitude: 2,
          distanceToCityMetres: 18,
          algorithmVersion: 'prd03-anchor-v1',
        },
      },
      {
        city: { municipalityKey: 'FR-00002' },
        gpxAnchorAB: { status: 'proposed' },
      },
    ],
  });
  assert.deepEqual(anchors, [{
    municipalityKey: 'FR-00001',
    status: 'validated',
    sourceSha256: 'a'.repeat(64),
    trackIndex: 0,
    segmentIndex: 1,
    pointIndex: 2,
    fraction: 0.25,
    chapterChainageMetres: 123.5,
    projectedLatitude: 50,
    projectedLongitude: 2,
    distanceToCityMetres: 18,
    algorithmVersion: 'prd03-anchor-v1',
  }]);
  assert.throws(() => testing.primaryAnchorsFromChapterEntity({
    slug: 'chapter',
    cityPassages: [{
      city: { municipalityKey: 'FR-00001' },
      gpxAnchorAB: {
        status: 'validated',
        sourceSha256: 'a'.repeat(64),
        trackIndex: 0,
        segmentIndex: 0,
        pointIndex: 0,
        fraction: 2,
        chainageMetres: 0,
        projectedLatitude: 50,
        projectedLongitude: 2,
        distanceToCityMetres: 0,
        algorithmVersion: 'prd03-anchor-v1',
      },
    }],
  }), /mal formée/);
});
