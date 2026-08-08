import assert from 'node:assert/strict';
import test from 'node:test';

import type { CatalogueDatasetThresholdQaRow } from '../src/domain/catalogue-dataset';
import {
  catalogueThresholdQaPairKey,
  compareCatalogueThresholdQa,
  type CatalogueThresholdQaActual,
} from '../src/domain/catalogue-threshold-qa';

const reference: CatalogueDatasetThresholdQaRow = {
  productId: 'FR-1__FR-2',
  municipalityKeyA: 'FR-1',
  municipalityKeyB: 'FR-2',
  countryCodeA: 'FR',
  municipalityCodeA: '1',
  inseeCodeA: '1',
  cityNameA: 'Ville A',
  countryCodeB: 'FR',
  municipalityCodeB: '2',
  inseeCodeB: '2',
  cityNameB: 'Ville B',
  slug: 'ville-a-a-ville-b',
  title: 'Ville A – Ville B à vélo',
  distanceMetres: 59_999.99,
  directMetres: 40_000,
  retained: true,
  eligibleByRoute: true,
  eligibleByDirect: false,
  routeMarginMetres: 0.01,
  directMarginMetres: 0,
  withinRouteThresholdMargin: true,
  withinDirectThresholdMargin: true,
  classification: 'Itinéraire uniquement',
  anchorChapterA: 'Chapitre A',
  anchorChapterB: 'Chapitre B',
  anchorChainageMetresA: 100,
  anchorChainageMetresB: 60_099.99,
  shortestPathViaOrigin: false,
  samplingStepMetres: 10,
  nearbyShopA: 'Commerce A',
  nearbyShopB: 'Commerce B',
  shopDistanceToTraceMetresA: 10,
  shopDistanceToTraceMetresB: 20,
  qualityControl: 'Cas de seuil',
  sourceTraceGpx: 'fixture',
};

const actual: CatalogueThresholdQaActual = {
  distanceMetres: reference.distanceMetres,
  directMetres: reference.directMetres,
  retained: reference.retained,
  eligibleByRoute: reference.eligibleByRoute,
  eligibleByDirect: reference.eligibleByDirect,
  shortestPathViaOrigin: reference.shortestPathViaOrigin,
  slug: reference.slug,
  title: reference.title,
  anchorA: { chapterLabel: reference.anchorChapterA, chainageMetres: reference.anchorChainageMetresA },
  anchorB: { chapterLabel: reference.anchorChapterB, chainageMetres: reference.anchorChainageMetresB },
};

test('une ligne QA exactement reproduite ne produit aucune différence', () => {
  assert.deepEqual(compareCatalogueThresholdQa(reference, actual), []);
});

test('la comparaison QA conserve les seuils stricts et une tolérance métrique au centimètre', () => {
  assert.deepEqual(compareCatalogueThresholdQa(reference, {
    ...actual,
    distanceMetres: reference.distanceMetres + 0.010_001,
    eligibleByRoute: false,
    retained: false,
    shortestPathViaOrigin: true,
    anchorB: { chapterLabel: 'Autre chapitre', chainageMetres: reference.anchorChainageMetresB + 0.010_001 },
  }), [
    'route_distance',
    'eligible_by_route',
    'retained',
    'shortest_path_via_origin',
    'anchor_chapter_b',
    'anchor_chainage_b',
  ]);
});

test('la comparaison QA couvre aussi le direct, le nommage et les ancres orientées A/B', () => {
  assert.deepEqual(compareCatalogueThresholdQa(reference, {
    ...actual,
    directMetres: reference.directMetres + 1,
    eligibleByDirect: true,
    slug: 'autre-slug',
    title: 'Autre titre',
    anchorA: { chapterLabel: 'Autre chapitre A', chainageMetres: reference.anchorChainageMetresA + 1 },
  }), [
    'direct_distance',
    'eligible_by_direct',
    'slug',
    'title',
    'anchor_chapter_a',
    'anchor_chainage_a',
  ]);
});

test('la clé QA est indépendante de l’ordre de la paire', () => {
  assert.equal(catalogueThresholdQaPairKey('FR-2', 'FR-1'), 'FR-1__FR-2');
});
