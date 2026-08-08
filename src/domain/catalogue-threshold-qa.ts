import type { CatalogueDatasetThresholdQaRow } from './catalogue-dataset';

const METRIC_TOLERANCE_METRES = 0.01;

export type CatalogueThresholdQaActual = {
  distanceMetres: number;
  directMetres: number;
  eligibleByRoute: boolean;
  eligibleByDirect: boolean;
  retained: boolean;
  shortestPathViaOrigin: boolean;
  slug?: string | null;
  title?: string | null;
  anchorA: {
    chapterLabel: string;
    chainageMetres: number;
  };
  anchorB: {
    chapterLabel: string;
    chainageMetres: number;
  };
};

export type CatalogueThresholdQaDifferenceCode =
  | 'route_distance'
  | 'direct_distance'
  | 'eligible_by_route'
  | 'eligible_by_direct'
  | 'retained'
  | 'shortest_path_via_origin'
  | 'slug'
  | 'title'
  | 'anchor_chapter_a'
  | 'anchor_chapter_b'
  | 'anchor_chainage_a'
  | 'anchor_chainage_b';

export function catalogueThresholdQaPairKey(first: string, second: string): string {
  return [first, second].sort().join('__');
}

function differsByMoreThanTolerance(first: number, second: number): boolean {
  return Math.abs(first - second) > METRIC_TOLERANCE_METRES;
}

/**
 * Compare un recalcul complet à une ligne de contrôle du classeur PRD04.
 *
 * Les distances restent comparées au centimètre : le pas d'échantillonnage du
 * classeur est une propriété de la baseline, pas une tolérance qui autoriserait
 * le nouveau moteur à masquer un écart. Les différences sont non bloquantes,
 * mais doivent apparaître dans le rapport et imposer une relecture humaine.
 */
export function compareCatalogueThresholdQa(
  reference: CatalogueDatasetThresholdQaRow,
  actual: CatalogueThresholdQaActual,
): CatalogueThresholdQaDifferenceCode[] {
  const differences: CatalogueThresholdQaDifferenceCode[] = [];
  if (differsByMoreThanTolerance(reference.distanceMetres, actual.distanceMetres)) differences.push('route_distance');
  if (differsByMoreThanTolerance(reference.directMetres, actual.directMetres)) differences.push('direct_distance');
  if (reference.eligibleByRoute !== actual.eligibleByRoute) differences.push('eligible_by_route');
  if (reference.eligibleByDirect !== actual.eligibleByDirect) differences.push('eligible_by_direct');
  if (reference.retained !== actual.retained) differences.push('retained');
  if (reference.shortestPathViaOrigin !== actual.shortestPathViaOrigin) differences.push('shortest_path_via_origin');
  if (actual.slug != null && reference.slug !== actual.slug) differences.push('slug');
  if (actual.title != null && reference.title !== actual.title) differences.push('title');
  if (reference.anchorChapterA !== actual.anchorA.chapterLabel) differences.push('anchor_chapter_a');
  if (reference.anchorChapterB !== actual.anchorB.chapterLabel) differences.push('anchor_chapter_b');
  if (differsByMoreThanTolerance(reference.anchorChainageMetresA, actual.anchorA.chainageMetres)) {
    differences.push('anchor_chainage_a');
  }
  if (differsByMoreThanTolerance(reference.anchorChainageMetresB, actual.anchorB.chainageMetres)) {
    differences.push('anchor_chainage_b');
  }
  return differences;
}
