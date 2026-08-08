import { finalizeCataloguePlan, type CataloguePlan } from '../../src/domain/catalogue-job';
import type {
  AnchorOperation,
  CalculationOperation,
  ImportOperation,
} from '../../src/services/catalogue-planner';

export type CatalogueTargetScope = {
  businessKeys: string[];
  municipalityKeys: string[];
  chapterSlugs: string[];
  anchorKeys: string[];
};

type Operation = ImportOperation | AnchorOperation | CalculationOperation;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function normalizeCatalogueTargetScope(scope: CatalogueTargetScope): CatalogueTargetScope {
  return {
    businessKeys: uniqueSorted(scope.businessKeys),
    municipalityKeys: uniqueSorted(scope.municipalityKeys),
    chapterSlugs: uniqueSorted(scope.chapterSlugs),
    anchorKeys: uniqueSorted(scope.anchorKeys),
  };
}

function operationMatches(operation: Operation, target: CatalogueTargetScope): boolean {
  if (operation.kind === 'setup_reference_route') {
    return target.businessKeys.length === 0
      && target.chapterSlugs.length === 0
      && target.anchorKeys.length === 0;
  }
  const businessKey = 'businessKey' in operation ? operation.businessKey : null;
  const municipalityKeys = operation.kind === 'upsert_city_route_city'
    ? [operation.municipalityKey]
    : operation.kind === 'upsert_anchor'
      ? [operation.municipalityKey]
      : operation.kind === 'upsert_itinerary_revision'
        || operation.kind === 'calculation_error'
        || operation.kind === 'threshold_qa_review'
        || operation.kind === 'archive_itinerary'
        ? [operation.cityAKey, operation.cityBKey]
        : [];
  const chapterSlugs = operation.kind === 'upsert_itinerary_revision'
    ? operation.chaptersOnRoute.map((chapter) => chapter.chapterSlug)
    : operation.kind === 'upsert_anchor' ? [operation.chapterSlug] : [];
  const anchorKeys = operation.kind === 'upsert_anchor'
    ? [operation.anchorKey]
    : operation.kind === 'upsert_itinerary_revision'
      ? [operation.departureAnchorKey, operation.arrivalAnchorKey]
      : [];
  return (target.businessKeys.length === 0 || (businessKey !== null && target.businessKeys.includes(businessKey)))
    && (target.municipalityKeys.length === 0 || municipalityKeys.some((key) => (
      typeof key === 'string' && target.municipalityKeys.includes(key)
    )))
    && (target.chapterSlugs.length === 0 || chapterSlugs.some((slug) => target.chapterSlugs.includes(slug)))
    && (target.anchorKeys.length === 0 || anchorKeys.some((key) => target.anchorKeys.includes(key)));
}

export function scopeCataloguePlan(
  report: CataloguePlan<Operation>,
  requestedTarget: CatalogueTargetScope,
  options: { archiveOnly?: boolean } = {},
): CataloguePlan<Operation> {
  const target = normalizeCatalogueTargetScope(requestedTarget);
  const hasTarget = Object.values(target).some((values) => values.length > 0);
  if (!hasTarget && !options.archiveOnly) return report;
  const operations = report.operations.filter((operation) => (
    (!options.archiveOnly || operation.kind === 'archive_itinerary')
    && operationMatches(operation, target)
  ));
  return finalizeCataloguePlan({
    ...report,
    scope: {
      ...report.scope,
      target,
      ...(options.archiveOnly ? { intent: 'archive_check' } : {}),
    },
    summary: {
      ...report.summary,
      originalOperations: report.operations.length,
      selectedOperations: operations.length,
    },
    operations,
  });
}
