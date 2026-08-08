import assert from 'node:assert/strict';
import test from 'node:test';

import { finalizeCataloguePlan } from '../src/domain/catalogue-job';
import { scopeCataloguePlan } from '../scripts/catalogue/catalogue-scope';

function calculationReport() {
  return finalizeCataloguePlan({
    version: 1 as const,
    mode: 'calculate' as const,
    codeVersion: 'test-code',
    algorithmVersion: 'test-algorithm',
    inputHash: 'a'.repeat(64),
    scope: { routeKey: 'route', sourceInputHash: 'b'.repeat(64) },
    summary: { operations: 4 },
    operations: [
      {
        kind: 'upsert_itinerary_revision',
        key: 'revision-ab',
        businessKey: 'route:FR-A:FR-B',
        cityAKey: 'FR-A',
        cityBKey: 'FR-B',
        departureAnchorKey: 'anchor-a',
        arrivalAnchorKey: 'anchor-b',
        chaptersOnRoute: [{ chapterSlug: 'chapter-one' }],
      },
      {
        kind: 'upsert_itinerary_revision',
        key: 'revision-cd',
        businessKey: 'route:FR-C:FR-D',
        cityAKey: 'FR-C',
        cityBKey: 'FR-D',
        departureAnchorKey: 'anchor-c',
        arrivalAnchorKey: 'anchor-d',
        chaptersOnRoute: [{ chapterSlug: 'chapter-two' }],
      },
      {
        kind: 'calculation_error',
        key: 'error-ac',
        businessKey: 'route:FR-A:FR-C',
        cityAKey: 'FR-A',
        cityBKey: 'FR-C',
      },
      {
        kind: 'archive_itinerary',
        key: 'archive:route:FR-E:FR-F',
        businessKey: 'route:FR-E:FR-F',
        cityAKey: 'FR-E',
        cityBKey: 'FR-F',
      },
    ] as any[],
  });
}

const emptyTarget = {
  businessKeys: [],
  municipalityKeys: [],
  chapterSlugs: [],
  anchorKeys: [],
};

test('le ciblage croise les dimensions et recalcule le hash du rapport', () => {
  const report = calculationReport();
  const scoped = scopeCataloguePlan(report, {
    ...emptyTarget,
    municipalityKeys: ['FR-A'],
    chapterSlugs: ['chapter-one'],
  });
  assert.deepEqual(scoped.operations.map((operation) => operation.key), ['revision-ab']);
  assert.equal(scoped.summary.originalOperations, 4);
  assert.equal(scoped.summary.selectedOperations, 1);
  assert.notEqual(scoped.reportHash, report.reportHash);
});

test('archive-check ne conserve que les archives et reste un rapport non applicable', () => {
  const scoped = scopeCataloguePlan(calculationReport(), emptyTarget, { archiveOnly: true });
  assert.deepEqual(scoped.operations.map((operation) => operation.kind), ['archive_itinerary']);
  assert.equal(scoped.scope.intent, 'archive_check');
  assert.equal(scoped.summary.selectedOperations, 1);
});

test('une archive est ciblable par ville', () => {
  const scoped = scopeCataloguePlan(calculationReport(), {
    ...emptyTarget,
    municipalityKeys: ['FR-F'],
  });
  assert.deepEqual(scoped.operations.map((operation) => operation.key), ['archive:route:FR-E:FR-F']);
});

test('une opération anchors est ciblable par slug de chapitre', () => {
  const report = finalizeCataloguePlan({
    version: 1 as const,
    mode: 'anchors' as const,
    codeVersion: 'test-code',
    algorithmVersion: 'test-algorithm',
    inputHash: 'c'.repeat(64),
    scope: { routeKey: 'route', sourceInputHash: 'd'.repeat(64) },
    summary: { operations: 2 },
    operations: [
      { kind: 'upsert_anchor', key: 'a', chapterSlug: 'chapter-one' },
      { kind: 'upsert_anchor', key: 'b', chapterSlug: 'chapter-two' },
    ] as any[],
  });
  const scoped = scopeCataloguePlan(report, {
    ...emptyTarget,
    chapterSlugs: ['chapter-two'],
  });
  assert.deepEqual(scoped.operations.map((operation) => operation.key), ['b']);
});
