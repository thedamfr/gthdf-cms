import {
  ALGORITHM_VERSION,
  buildDisplayGeometry,
  calculateEligibility,
  computeElevationMetrics,
  distanceWgs84Result,
  extractRouteArc,
  hashCanonical,
  recomposeRouteAnchorPosition,
  selectShortestArc,
  serializeCatalogueGpx,
  sha256Hex,
  totalSequenceDistanceMetres,
  type CatalogueAnchor,
  type CatalogueRouteSegment,
  type GpxDocument,
} from '../domain/catalogue-core';
import {
  parseVersionedBoundarySnapshot,
  proposeBoundaryAnchors,
  type BoundaryPrimaryAnchor,
  type BoundarySnapshot,
} from '../domain/catalogue-boundaries';
import {
  buildAnchorKey,
  buildAnchorSemanticKey,
  buildBusinessKey,
  buildRevisionKey,
  buildRouteCityKey,
  computeArtifactIntegrityHash,
  computeEvaluationHash,
} from '../domain/catalogue-validation';
import { finalizeCataloguePlan, type CataloguePlan } from '../domain/catalogue-job';
import type {
  CatalogueDatasetCity,
  CatalogueDatasetProduct,
  CatalogueDatasetThresholdQaRow,
  ControlledCatalogueDataset,
} from '../domain/catalogue-dataset';
import {
  catalogueThresholdQaPairKey,
  compareCatalogueThresholdQa,
  type CatalogueThresholdQaDifferenceCode,
} from '../domain/catalogue-threshold-qa';

export type RuntimeCity = {
  id: number;
  documentId: string;
  municipalityKey: string;
  name: string;
  slug: string;
  countryCode?: string | null;
  municipalityCode?: string | null;
  administrativeArea?: string | null;
  latitude: number;
  longitude: number;
  coordinateSource?: unknown;
  hasPublicPage?: boolean;
};

export type RuntimeRouteSegment = CatalogueRouteSegment & {
  chapterId: number;
  chapterDocumentId: string;
  chapterTitle: string;
  direction: 'ab';
  sourceMediaDocumentId?: string;
  sourceMediaFingerprint?: string;
  primaryAnchors?: RuntimePrd03PrimaryAnchor[];
};

export type RuntimePrd03PrimaryAnchor = {
  municipalityKey: string;
  status: 'validated';
  sourceSha256: string;
  trackIndex: number;
  segmentIndex: number;
  pointIndex: number;
  fraction: number;
  chapterChainageMetres: number;
  projectedLatitude: number;
  projectedLongitude: number;
  distanceToCityMetres: number;
  algorithmVersion: string;
};

export type RuntimeRoute = {
  id: number;
  documentId: string;
  routeKey: string;
  name: string;
  slug: string;
  catalogueEnabled: boolean;
  sourceManifestHash?: string | null;
  segments: RuntimeRouteSegment[];
};

export type RuntimeAnchor = CatalogueAnchor & {
  id: number;
  documentId: string;
  anchorSemanticKey: string;
  occurrenceIndex: number;
  chapterId: number;
  chapterDocumentId: string;
  distanceToTraceMetres: number;
  algorithmVersion: string;
  sourceDirection: 'ab' | 'ba';
  origin: 'computed' | 'prd03_primary';
  routeCityKey?: string | null;
  ambiguityReasons?: string[];
};

export type RuntimeRouteCity = {
  id: number;
  documentId: string;
  routeCityKey: string;
  qualificationStatus: 'proposed' | 'validated' | 'rejected' | 'stale';
  qualificationSourceHash: string;
  qualificationEvidence?: Record<string, unknown> | null;
  routeKey?: string | null;
  reviewNote?: string | null;
  expectedOccurrences: number;
  city: RuntimeCity;
  anchors: RuntimeAnchor[];
};

export type ImportOperation = {
  kind: 'setup_reference_route' | 'upsert_city_route_city';
  key: string;
  action: 'create' | 'enrich' | 'reuse' | 'conflict';
  municipalityKey?: string;
  differences?: string[];
  coordinateUpgrade?: 'legacy_decimal_2';
  expectedTargetHash: string;
  expectedResultHash: string;
};

export type AnchorOperation = {
  kind: 'upsert_anchor';
  key: string;
  action: 'create' | 'reuse' | 'conflict';
  municipalityKey: string;
  routeCityKey: string;
  anchorKey: string;
  anchorSemanticKey: string;
  occurrenceIndex: number;
  chapterDocumentId: string;
  chapterSlug: string;
  sourceSegmentIndex: number;
  sourceHash: string;
  trackIndex: number;
  segmentIndex: number;
  pointIndex: number;
  fraction: number;
  chainageMetres: number;
  projectedLatitude: number;
  projectedLongitude: number;
  distanceToTraceMetres: number;
  origin: 'computed' | 'prd03_primary';
  validationStatus: 'proposed' | 'ambiguous';
  ambiguityReasons: string[];
  expectedTargetHash: string;
  expectedResultHash: string;
};

export type ExistingItineraryState = {
  documentId: string;
  businessKey: string;
  slug: string;
  title: string;
  cityAKey?: string | null;
  cityBKey?: string | null;
  currentEvaluationHash?: string | null;
  activeRevisionKey?: string | null;
  activeRevisionSourceHash?: string | null;
  activeDepartureKey?: string | null;
  activeArrivalKey?: string | null;
  activeLastVerifiedEvaluationHash?: string | null;
  activeArtifactsVerified?: boolean;
  activeGeneratedGpxMediaIdentity?: string | null;
  activeDisplayGeometryMediaIdentity?: string | null;
  activeGeneratedGpxSha256?: string | null;
  activeDisplayGeometrySha256?: string | null;
  activeRevisionCalculationStatus?: string | null;
  activeArtifactIntegrityStatus?: string | null;
  activeArtifactIntegrityHash?: string | null;
  publicationNext?: boolean;
  revisionKeys: string[];
};

export type CalculationUpsertOperation = {
  kind: 'upsert_itinerary_revision';
  key: string;
  action: 'create' | 'new_revision' | 'reverified_unchanged' | 'unchanged' | 'stale';
  differences: string[];
  expectedItineraryStateHash: string;
  expectedItineraryCasHash: string;
  expectedItineraryPostCasHash: string;
  expectedItineraryResultHash: string;
  expectedGeneratedGpxMediaIdentity?: string | null;
  expectedDisplayGeometryMediaIdentity?: string | null;
  businessKey: string;
  revisionKey: string;
  sourceHash: string;
  evaluationHash: string;
  title: string;
  slug: string;
  cityAKey: string;
  cityBKey: string;
  departureKey: string;
  arrivalKey: string;
  departureAnchorKey: string;
  arrivalAnchorKey: string;
  distanceMetres: number;
  directMetres: number;
  directDistanceMethod: 'vincenty' | 'haversine_fallback';
  eligibleByRoute: boolean;
  eligibleByDirect: boolean;
  elevationAvailable: boolean;
  elevationGainMetres: number | null;
  elevationLossMetres: number | null;
  detourRatio: number | null;
  usesLoopOrigin: boolean;
  junctionWarnings: Array<{
    code: 'accepted_gap';
    afterChapterSlug: string;
    beforeChapterSlug: string;
    gapMetres: number;
  }>;
  qualityWarningCodes: string[];
  calculationStatus: 'ready' | 'warning';
  chaptersOnRoute: Array<{
    chapterDocumentId: string;
    chapterSlug: string;
    routeOrder: number;
    distanceMetres: number;
    direction: 'ab';
  }>;
  citiesOnRoute: Array<{
    municipalityKey: string;
    cityDocumentId: string;
    routeOrder: number;
    occurrenceIndex: number;
    chainageFromDepartureMetres: number;
  }>;
  generatedGpxSha256: string;
  generatedGpxSize: number;
  generatedGpxName: string;
  displayGeometrySha256: string;
  displayGeometrySize: number;
  displayGeometryName: string;
  baselineDistanceDeltaMetres?: number;
  baselineDirectDeltaMetres?: number;
  thresholdQaComparison?: {
    referenceProductId: string;
    status: 'matched' | 'different';
    differenceCodes: CatalogueThresholdQaDifferenceCode[];
  };
};

export type CalculationArchiveOperation = {
  kind: 'archive_itinerary';
  key: string;
  action: 'archive';
  businessKey: string;
  cityAKey: string;
  cityBKey: string;
  itineraryDocumentId: string;
  activeRevisionKey?: string | null;
  reason: 'blocked' | 'ineligible' | 'inputs_unavailable';
  expectedItineraryStateHash: string;
  expectedItineraryCasHash: string;
  expectedItineraryResultHash: string;
};

export type CalculationErrorOperation = {
  kind: 'calculation_error';
  key: string;
  action: 'error';
  businessKey: string;
  cityAKey: string;
  cityBKey: string;
  errorCode: 'selection_failed';
  message: string;
};

export type CalculationThresholdQaReviewOperation = {
  kind: 'threshold_qa_review';
  key: string;
  action: 'review';
  businessKey: string;
  cityAKey: string;
  cityBKey: string;
  referenceProductId: string;
  qaStatus: 'different' | 'unavailable';
  differenceCodes: CatalogueThresholdQaDifferenceCode[];
  reason: 'ineligible_mismatch' | 'calculation_error' | 'inputs_unavailable';
  message?: string;
};

export type CalculationOperation =
  | CalculationUpsertOperation
  | CalculationArchiveOperation
  | CalculationErrorOperation
  | CalculationThresholdQaReviewOperation;

type ExistingImportState = {
  route: RuntimeRoute | null;
  cities: RuntimeCity[];
  routeCities: RuntimeRouteCity[];
  chapterContractHash: string;
};

function meaningfulDifference(current: unknown, proposed: unknown): boolean {
  return current !== null && current !== undefined && String(current) !== '' && current !== proposed;
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

export function slugifyCatalogueCity(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 160);
}

function importDifferences(city: RuntimeCity, source: CatalogueDatasetCity): string[] {
  return [
    ['countryCode', city.countryCode, source.countryCode],
    ['municipalityCode', city.municipalityCode, source.municipalityCode],
    ['administrativeArea', city.administrativeArea, source.administrativeArea],
    ['latitude', city.latitude, source.latitude],
    ['longitude', city.longitude, source.longitude],
  ].filter(([, current, proposed]) => meaningfulDifference(current, proposed)).map(([field]) => String(field));
}

/**
 * Reproduit l’arrondi half-away-from-zero de PostgreSQL numeric(..., 2) sans
 * dépendre des approximations de `value * 100` (1.005 doit donner 1.01).
 */
export function roundLegacyCoordinateToTwoDecimals(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Une coordonnée finie est requise pour l’arrondi historique.');
  const [mantissa, exponentText = '0'] = Math.abs(value).toString().toLowerCase().split('e');
  const [integerPart, fractionalPart = ''] = mantissa.split('.');
  const digits = BigInt(`${integerPart}${fractionalPart}`);
  const scaledPower = Number(exponentText) - fractionalPart.length + 2;
  let roundedScaled: bigint;
  if (scaledPower >= 0) {
    roundedScaled = digits * (BigInt(10) ** BigInt(scaledPower));
  } else {
    const divisor = BigInt(10) ** BigInt(-scaledPower);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    roundedScaled = quotient + (remainder * BigInt(2) >= divisor ? BigInt(1) : BigInt(0));
  }
  const signed = value < 0 ? -roundedScaled : roundedScaled;
  const rounded = Number(signed) / 100;
  return rounded === 0 ? 0 : rounded;
}

export function isSafeLegacyCoordinateUpgrade(
  city: Pick<RuntimeCity, 'latitude' | 'longitude'>,
  source: Pick<CatalogueDatasetCity, 'latitude' | 'longitude'>,
  differences: readonly string[],
): boolean {
  if (
    differences.length === 0
    || differences.some((field) => field !== 'latitude' && field !== 'longitude')
    || ![city.latitude, city.longitude, source.latitude, source.longitude].every(Number.isFinite)
  ) return false;
  const latitudeRounded = roundLegacyCoordinateToTwoDecimals(source.latitude);
  const longitudeRounded = roundLegacyCoordinateToTwoDecimals(source.longitude);
  const latitudeSafe = city.latitude === source.latitude || city.latitude === latitudeRounded;
  const longitudeSafe = city.longitude === source.longitude || city.longitude === longitudeRounded;
  const hasRoundedValueToUpgrade = (city.latitude !== source.latitude && city.latitude === latitudeRounded)
    || (city.longitude !== source.longitude && city.longitude === longitudeRounded);
  return latitudeSafe && longitudeSafe && hasRoundedValueToUpgrade;
}

export function hashImportTargetState(city: RuntimeCity | null | undefined, routeCity: RuntimeRouteCity | null | undefined): string {
  return hashCanonical({
    city: city ? {
      documentId: city.documentId,
      municipalityKey: city.municipalityKey,
      name: city.name,
      slug: city.slug,
      countryCode: city.countryCode,
      municipalityCode: city.municipalityCode,
      administrativeArea: city.administrativeArea,
      latitude: city.latitude,
      longitude: city.longitude,
      coordinateSource: city.coordinateSource,
      hasPublicPage: city.hasPublicPage === true,
    } : null,
    routeCity: routeCity ? {
      documentId: routeCity.documentId,
      routeCityKey: routeCity.routeCityKey,
      qualificationStatus: routeCity.qualificationStatus,
      qualificationSourceHash: routeCity.qualificationSourceHash,
      qualificationEvidence: routeCity.qualificationEvidence ?? null,
      expectedOccurrences: routeCity.expectedOccurrences,
      routeKey: routeCity.routeKey ?? null,
      cityMunicipalityKey: routeCity.city?.municipalityKey ?? null,
      reviewNote: routeCity.reviewNote ?? null,
    } : null,
  });
}

/**
 * Empreinte sémantique du résultat d’un import. Les identifiants Strapi,
 * attribués seulement au create, sont volontairement exclus ; toutes les
 * valeurs métier écrites par le job et la relation City restent couvertes.
 */
export function hashImportResultState(
  city: RuntimeCity | null | undefined,
  routeCity: RuntimeRouteCity | null | undefined,
): string {
  return hashCanonical({
    city: city ? {
      municipalityKey: city.municipalityKey,
      name: city.name,
      slug: city.slug,
      countryCode: city.countryCode,
      municipalityCode: city.municipalityCode,
      administrativeArea: city.administrativeArea,
      latitude: city.latitude,
      longitude: city.longitude,
      coordinateSource: city.coordinateSource,
      hasPublicPage: city.hasPublicPage === true,
    } : null,
    routeCity: routeCity ? {
      routeCityKey: routeCity.routeCityKey,
      cityMunicipalityKey: routeCity.city?.municipalityKey ?? null,
      qualificationStatus: routeCity.qualificationStatus,
      qualificationSourceHash: routeCity.qualificationSourceHash,
      qualificationEvidence: routeCity.qualificationEvidence ?? null,
      expectedOccurrences: routeCity.expectedOccurrences,
      routeKey: routeCity.routeKey ?? null,
      reviewNote: routeCity.reviewNote ?? null,
    } : null,
  });
}

function expectedImportResult(input: {
  source: CatalogueDatasetCity;
  city: RuntimeCity | null | undefined;
  routeCity: RuntimeRouteCity | null | undefined;
  routeKey: string;
  datasetHash: string;
  action: ImportOperation['action'];
  coordinateUpgrade?: ImportOperation['coordinateUpgrade'];
}): string {
  if (input.action === 'conflict' || input.action === 'reuse') {
    return hashImportResultState(input.city, input.routeCity);
  }
  const city = input.city ? {
    ...input.city,
    ...(input.action === 'enrich' ? Object.fromEntries(Object.entries({
      countryCode: input.source.countryCode,
      municipalityCode: input.source.municipalityCode,
      administrativeArea: input.source.administrativeArea,
      latitude: input.source.latitude,
      longitude: input.source.longitude,
      coordinateSource: input.source.coordinateSource,
    }).filter(([field]) => (
      isMissing((input.city as Record<string, unknown>)[field])
      || (input.coordinateUpgrade === 'legacy_decimal_2' && ['latitude', 'longitude'].includes(field))
    ))) : {}),
  } : {
    id: 0,
    documentId: '',
    municipalityKey: input.source.municipalityKey,
    name: input.source.name,
    slug: slugifyCatalogueCity(input.source.name),
    countryCode: input.source.countryCode,
    municipalityCode: input.source.municipalityCode,
    administrativeArea: input.source.administrativeArea,
    latitude: input.source.latitude,
    longitude: input.source.longitude,
    coordinateSource: input.source.coordinateSource,
    hasPublicPage: false,
  };
  const routeCity = input.routeCity ?? {
    id: 0,
    documentId: '',
    routeCityKey: buildRouteCityKey(input.routeKey, input.source.municipalityKey),
    qualificationStatus: 'proposed' as const,
    qualificationSourceHash: input.datasetHash,
    qualificationEvidence: input.source.qualificationEvidence,
    expectedOccurrences: input.source.expectedOccurrences,
    routeKey: input.routeKey,
    reviewNote: 'Proposition importée du lot PRD04; validation humaine requise.',
    city,
    anchors: [],
  };
  return hashImportResultState(city, routeCity);
}

export function hashAnchorTargetState(anchor: RuntimeAnchor | null | undefined): string {
  return hashCanonical(anchor ? {
    anchorKey: anchor.anchorKey,
    anchorSemanticKey: anchor.anchorSemanticKey,
    occurrenceIndex: anchor.occurrenceIndex,
    routeSegmentIndex: anchor.routeSegmentIndex,
    chapterDocumentId: anchor.chapterDocumentId,
    sourceSha256: anchor.sourceSha256,
    trackIndex: anchor.trackIndex,
    segmentIndex: anchor.segmentIndex,
    pointIndex: anchor.pointIndex,
    fraction: anchor.fraction,
    chainageMetres: anchor.chainageMetres,
    projectedLatitude: anchor.projectedLatitude,
    projectedLongitude: anchor.projectedLongitude,
    distanceToTraceMetres: anchor.distanceToTraceMetres,
    status: anchor.status,
    algorithmVersion: anchor.algorithmVersion,
    sourceDirection: anchor.sourceDirection,
    origin: anchor.origin,
    routeCityKey: anchor.routeCityKey ?? null,
    ambiguityReasons: anchor.ambiguityReasons ?? [],
  } : null);
}

export function hashAnchorOperationResult(operation: AnchorOperation): string {
  return hashCanonical({
    anchorKey: operation.anchorKey,
    anchorSemanticKey: operation.anchorSemanticKey,
    occurrenceIndex: operation.occurrenceIndex,
    routeSegmentIndex: operation.sourceSegmentIndex,
    chapterDocumentId: operation.chapterDocumentId,
    sourceSha256: operation.sourceHash,
    trackIndex: operation.trackIndex,
    segmentIndex: operation.segmentIndex,
    pointIndex: operation.pointIndex,
    fraction: operation.fraction,
    chainageMetres: operation.chainageMetres,
    projectedLatitude: operation.projectedLatitude,
    projectedLongitude: operation.projectedLongitude,
    distanceToTraceMetres: operation.distanceToTraceMetres,
    status: operation.validationStatus,
    algorithmVersion: ALGORITHM_VERSION.projection,
    sourceDirection: 'ab',
    origin: operation.origin,
    routeCityKey: operation.routeCityKey,
    ambiguityReasons: operation.ambiguityReasons,
  });
}

export function computeImportInputHash(dataset: ControlledCatalogueDataset, state: ExistingImportState): string {
  return hashCanonical({
    version: 1,
    datasetHash: dataset.datasetHash,
    chapterContractHash: state.chapterContractHash,
    route: state.route ? { documentId: state.route.documentId, routeKey: state.route.routeKey } : null,
    cities: state.cities.map((city) => ({
      documentId: city.documentId,
      municipalityKey: city.municipalityKey,
      name: city.name,
      slug: city.slug,
      countryCode: city.countryCode,
      municipalityCode: city.municipalityCode,
      administrativeArea: city.administrativeArea,
      latitude: city.latitude,
      longitude: city.longitude,
      coordinateSource: city.coordinateSource,
    })).sort((first, second) => first.municipalityKey.localeCompare(second.municipalityKey)),
    routeCities: state.routeCities.map((item) => ({
      routeCityKey: item.routeCityKey,
      qualificationStatus: item.qualificationStatus,
      qualificationSourceHash: item.qualificationSourceHash,
      expectedOccurrences: item.expectedOccurrences,
    })).sort((first, second) => first.routeCityKey.localeCompare(second.routeCityKey)),
  });
}

export function expectedReferenceRouteResultHash(input: {
  routeKey: string;
  datasetHash: string;
  chapterContractHash: string;
}): string {
  return hashCanonical({
    version: 1,
    routeKey: input.routeKey,
    name: 'Grand Tour des Hauts-de-France',
    slug: input.routeKey,
    isLoop: true,
    catalogueEnabled: false,
    algorithmVersion: ALGORITHM_VERSION.catalogue,
    sourceManifestHash: input.datasetHash,
    chapterContractHash: input.chapterContractHash,
  });
}

export function planCatalogueImport(input: {
  dataset: ControlledCatalogueDataset;
  state: ExistingImportState;
  routeKey: string;
  codeVersion: string;
}): CataloguePlan<ImportOperation> {
  const sourceInputHash = hashCanonical({
    version: 1,
    routeKey: input.routeKey,
    datasetHash: input.dataset.datasetHash,
    chapterContractHash: input.state.chapterContractHash,
  });
  const cityByKey = new Map(input.state.cities.map((city) => [city.municipalityKey, city]));
  const routeCityByKey = new Map(input.state.routeCities.map((item) => [item.routeCityKey, item]));
  const operations: ImportOperation[] = [{
    kind: 'setup_reference_route',
    key: input.routeKey,
    action: input.state.route ? 'reuse' : 'create',
    expectedTargetHash: hashCanonical(input.state.route ? {
      documentId: input.state.route.documentId,
      routeKey: input.state.route.routeKey,
    } : null),
    expectedResultHash: input.state.route
      ? expectedReferenceRouteResultHash({
        routeKey: input.routeKey,
        datasetHash: input.dataset.datasetHash,
        chapterContractHash: input.state.chapterContractHash,
      })
      : expectedReferenceRouteResultHash({
        routeKey: input.routeKey,
        datasetHash: input.dataset.datasetHash,
        chapterContractHash: input.state.chapterContractHash,
      }),
  }];
  for (const source of input.dataset.cities) {
    const city = cityByKey.get(source.municipalityKey);
    const routeCity = routeCityByKey.get(buildRouteCityKey(input.routeKey, source.municipalityKey));
    const differences = city ? importDifferences(city, source) : [];
    const safeCoordinateUpgrade = city
      ? isSafeLegacyCoordinateUpgrade(city, source, differences)
      : false;
    const needsEnrichment = city && [city.countryCode, city.municipalityCode, city.administrativeArea, city.latitude, city.longitude]
      .some((value) => value === null || value === undefined || value === '');
    const conflict = (differences.length > 0 && !safeCoordinateUpgrade)
      || (routeCity !== undefined && (
        routeCity.expectedOccurrences !== source.expectedOccurrences
        || routeCity.qualificationSourceHash !== input.dataset.datasetHash
      ));
    const action: ImportOperation['action'] = conflict
      ? 'conflict'
      : !city ? 'create' : needsEnrichment || safeCoordinateUpgrade || !routeCity ? 'enrich' : 'reuse';
    const coordinateUpgrade = action === 'enrich' && safeCoordinateUpgrade
      ? 'legacy_decimal_2' as const
      : undefined;
    operations.push({
      kind: 'upsert_city_route_city',
      key: source.municipalityKey,
      municipalityKey: source.municipalityKey,
      action,
      ...(differences.length ? { differences } : {}),
      ...(coordinateUpgrade ? { coordinateUpgrade } : {}),
      expectedTargetHash: hashImportTargetState(city, routeCity),
      expectedResultHash: expectedImportResult({
        source,
        city,
        routeCity,
        routeKey: input.routeKey,
        datasetHash: input.dataset.datasetHash,
        action,
        coordinateUpgrade,
      }),
    });
  }
  return finalizeCataloguePlan({
    version: 1,
    mode: 'import',
    codeVersion: input.codeVersion,
    algorithmVersion: ALGORITHM_VERSION.catalogue,
    inputHash: computeImportInputHash(input.dataset, input.state),
    scope: { routeKey: input.routeKey, datasetHash: input.dataset.datasetHash, sourceInputHash },
    summary: {
      expectedCities: 223,
      expectedOccurrences: 449,
      creates: operations.filter((operation) => operation.action === 'create').length,
      enrichments: operations.filter((operation) => operation.action === 'enrich').length,
      reuses: operations.filter((operation) => operation.action === 'reuse').length,
      conflicts: operations.filter((operation) => operation.action === 'conflict').length,
    },
    operations,
    generatedAt: new Date().toISOString(),
  });
}

export function buildRouteFingerprint(route: RuntimeRoute): string {
  return hashCanonical({
    version: 1,
    routeKey: route.routeKey,
    sourceManifestHash: route.sourceManifestHash,
    algorithmVersion: ALGORITHM_VERSION,
    segments: route.segments.map((segment) => ({
      index: segment.index,
      chapterDocumentId: segment.chapterDocumentId,
      chapterSlug: segment.chapterKey,
      sourceSha256: segment.sourceSha256,
      sourceMediaDocumentId: segment.sourceMediaDocumentId,
      sourceMediaFingerprint: segment.sourceMediaFingerprint,
      direction: segment.direction,
      junctionAfter: segment.junctionAfter,
      primaryAnchors: (segment.primaryAnchors ?? []).map((anchor) => ({ ...anchor }))
        .sort((first, second) => (
          first.municipalityKey.localeCompare(second.municipalityKey)
          || first.chapterChainageMetres - second.chapterChainageMetres
        )),
    })),
  });
}

export function buildRouteCityFingerprint(routeCity: RuntimeRouteCity): string {
  return hashCanonical({
    version: 1,
    routeCityKey: routeCity.routeCityKey,
    qualificationStatus: routeCity.qualificationStatus,
    qualificationSourceHash: routeCity.qualificationSourceHash,
    qualificationEvidence: routeCity.qualificationEvidence ?? null,
    expectedOccurrences: routeCity.expectedOccurrences,
    city: {
      municipalityKey: routeCity.city.municipalityKey,
      name: routeCity.city.name,
      latitude: routeCity.city.latitude,
      longitude: routeCity.city.longitude,
    },
    anchors: routeCity.anchors.filter((anchor) => anchor.status === 'validated').map((anchor) => ({
      anchorKey: anchor.anchorKey,
      occurrenceIndex: anchor.occurrenceIndex,
      sourceSha256: anchor.sourceSha256,
      routeSegmentIndex: anchor.routeSegmentIndex,
      chapterDocumentId: anchor.chapterDocumentId,
      algorithmVersion: anchor.algorithmVersion,
      sourceDirection: anchor.sourceDirection,
      origin: anchor.origin,
      chainageMetres: anchor.chainageMetres,
      trackIndex: anchor.trackIndex,
      segmentIndex: anchor.segmentIndex,
      pointIndex: anchor.pointIndex,
      fraction: anchor.fraction,
      projectedLatitude: anchor.projectedLatitude,
      projectedLongitude: anchor.projectedLongitude,
    })).sort((first, second) => first.anchorKey.localeCompare(second.anchorKey)),
  });
}

export function computeAnchorsInputHash(input: {
  route: RuntimeRoute;
  routeCities: RuntimeRouteCity[];
  datasetHash: string;
  boundaryManifestHash: string;
}): string {
  return hashCanonical({
    version: 1,
    routeFingerprint: buildRouteFingerprint(input.route),
    datasetHash: input.datasetHash,
    boundaryManifestHash: input.boundaryManifestHash,
    routeCities: input.routeCities.map((item) => ({
      routeCityKey: item.routeCityKey,
      expectedOccurrences: item.expectedOccurrences,
      city: {
        municipalityKey: item.city.municipalityKey,
        latitude: item.city.latitude,
        longitude: item.city.longitude,
      },
      anchors: item.anchors.map((anchor) => ({
        anchorKey: anchor.anchorKey,
        anchorSemanticKey: anchor.anchorSemanticKey,
        status: anchor.status,
        occurrenceIndex: anchor.occurrenceIndex,
        sourceSha256: anchor.sourceSha256,
        routeSegmentIndex: anchor.routeSegmentIndex,
        chapterDocumentId: anchor.chapterDocumentId,
        trackIndex: anchor.trackIndex,
        segmentIndex: anchor.segmentIndex,
        pointIndex: anchor.pointIndex,
        fraction: anchor.fraction,
        chainageMetres: anchor.chainageMetres,
        projectedLatitude: anchor.projectedLatitude,
        projectedLongitude: anchor.projectedLongitude,
        distanceToTraceMetres: anchor.distanceToTraceMetres,
        algorithmVersion: anchor.algorithmVersion,
        sourceDirection: anchor.sourceDirection,
        origin: anchor.origin,
      })).sort((first, second) => first.anchorKey.localeCompare(second.anchorKey)),
    })).sort((first, second) => first.routeCityKey.localeCompare(second.routeCityKey)),
  });
}

function controlledFirstOccurrenceHint(
  route: RuntimeRoute,
  dataset: ControlledCatalogueDataset,
  city: CatalogueDatasetCity,
): {
  hint?: { routeSegmentIndex: number; chainageMetres: number; toleranceMetres: number };
  ambiguityReasons: string[];
} {
  const controlledReference = slugify(city.firstChapterLabel);
  const chapterMatches = dataset.chapters.filter((chapter) => (
    chapter.slug === city.firstChapterLabel
    || chapter.slug === controlledReference
    || slugify(chapter.label) === controlledReference
  ));
  if (chapterMatches.length !== 1) {
    return {
      ambiguityReasons: [
        `Le premier chapitre XLSX « ${city.firstChapterLabel} » correspond à ${chapterMatches.length} chapitre(s) contrôlé(s).`,
      ],
    };
  }
  const routeMatches = route.segments.filter((segment) => segment.chapterKey === chapterMatches[0].slug);
  if (routeMatches.length !== 1) {
    return {
      ambiguityReasons: [
        `Le premier chapitre XLSX « ${city.firstChapterLabel} » correspond à ${routeMatches.length} segment(s) du parcours publié.`,
      ],
    };
  }
  return {
    hint: {
      routeSegmentIndex: routeMatches[0].index,
      chainageMetres: city.firstChainageMetres,
      // Le référentiel initial a été échantillonné tous les 10 m. Toute
      // divergence supérieure à un pas complet reste soumise à revue.
      toleranceMetres: 10,
    },
    ambiguityReasons: [],
  };
}

function boundaryPrimaryIdentity(anchor: BoundaryPrimaryAnchor): string {
  return hashCanonical({
    routeSegmentIndex: anchor.routeSegmentIndex,
    sourceSha256: anchor.sourceSha256.toLowerCase(),
    trackIndex: anchor.trackIndex,
    segmentIndex: anchor.segmentIndex,
    pointIndex: anchor.pointIndex,
    fraction: anchor.fraction,
  });
}

function collectValidatedPrimaryAnchors(input: {
  route: RuntimeRoute;
  routeCity: RuntimeRouteCity;
  chainageOffsets: ReadonlyMap<number, number>;
}): { anchors: BoundaryPrimaryAnchor[]; ambiguityReasons: string[] } {
  const anchors = new Map<string, BoundaryPrimaryAnchor>();
  const ambiguityReasons: string[] = [];
  const cityPoint = {
    latitude: input.routeCity.city.latitude,
    longitude: input.routeCity.city.longitude,
  };
  const recompose = (candidate: CatalogueAnchor, storedDistanceToTraceMetres: number, label: string) => {
    try {
      const recomposed = recomposeRouteAnchorPosition({
        route: input.route.segments,
        anchor: candidate,
        cityPoint,
        storedDistanceToTraceMetres,
      });
      const normalized: BoundaryPrimaryAnchor = {
        routeSegmentIndex: candidate.routeSegmentIndex,
        sourceSha256: candidate.sourceSha256.toLowerCase(),
        trackIndex: candidate.trackIndex,
        segmentIndex: candidate.segmentIndex,
        pointIndex: candidate.pointIndex,
        fraction: candidate.fraction,
        chainageMetres: recomposed.chainageMetres,
        projectedLatitude: recomposed.point.latitude,
        projectedLongitude: recomposed.point.longitude,
        distanceToTraceMetres: recomposed.distanceToTraceMetres ?? storedDistanceToTraceMetres,
      };
      anchors.set(boundaryPrimaryIdentity(normalized), normalized);
    } catch (error) {
      ambiguityReasons.push(`${label} ne se recompose pas exactement depuis le GPX publié : ${error instanceof Error ? error.message : 'erreur inconnue'}`);
    }
  };

  // Source d’autorité : ancres AB validées des cityPassages PRD03 publiées.
  for (const segment of input.route.segments) {
    for (const primary of segment.primaryAnchors ?? []) {
      if (primary.municipalityKey !== input.routeCity.city.municipalityKey) continue;
      const offset = input.chainageOffsets.get(segment.index);
      if (offset === undefined) {
        ambiguityReasons.push(`Le décalage de chaînage du chapitre ${segment.chapterKey} est absent.`);
        continue;
      }
      recompose({
        anchorKey: `prd03:${segment.chapterDocumentId}:${primary.municipalityKey}`,
        routeSegmentIndex: segment.index,
        sourceSha256: primary.sourceSha256,
        trackIndex: primary.trackIndex,
        segmentIndex: primary.segmentIndex,
        pointIndex: primary.pointIndex,
        fraction: primary.fraction,
        chainageMetres: offset + primary.chapterChainageMetres,
        projectedLatitude: primary.projectedLatitude,
        projectedLongitude: primary.projectedLongitude,
        status: 'validated',
      }, primary.distanceToCityMetres, `L’ancre PRD03 ${segment.chapterKey}/${primary.municipalityKey}`);
    }
  }

  // Une RouteAnchor déjà importée avec cette provenance est également relue,
  // notamment pour rendre la reprise idempotente sans perdre le rattachement.
  for (const existing of input.routeCity.anchors) {
    if (existing.origin !== 'prd03_primary' || existing.status !== 'validated') continue;
    recompose(existing, existing.distanceToTraceMetres, `L’ancre catalogue PRD03 ${existing.anchorKey}`);
  }
  return { anchors: [...anchors.values()], ambiguityReasons };
}

export function planCatalogueAnchors(input: {
  route: RuntimeRoute;
  routeCities: RuntimeRouteCity[];
  dataset: ControlledCatalogueDataset;
  boundarySnapshot: BoundarySnapshot;
  codeVersion: string;
}): CataloguePlan<AnchorOperation> {
  const requiredKeys = input.dataset.cities.map((city) => city.municipalityKey);
  const features = new Map(input.boundarySnapshot.features.map((feature) => [feature.municipalityKey, feature]));
  const routeCities = new Map(input.routeCities.map((item) => [item.city.municipalityKey, item]));
  const datasetCities = new Map(input.dataset.cities.map((city) => [city.municipalityKey, city]));
  const operations: AnchorOperation[] = [];
  let chainageOffsetMetres = 0;
  const boundaryRoute = input.route.segments.map((segment, index) => {
    const result = {
      index,
      sourceSha256: segment.sourceSha256,
      document: segment.document,
      chainageOffsetMetres,
      breakBefore: index === 0 || input.route.segments[index - 1].junctionAfter.status === 'accepted_gap',
    };
    chainageOffsetMetres += totalSequenceDistanceMetres(segment.document.tracks.flatMap((track) => track.segments.map((part) => part.points)));
    return result;
  });
  const chainageOffsets = new Map(boundaryRoute.map((segment) => [segment.index, segment.chainageOffsetMetres]));
  for (const municipalityKey of requiredKeys) {
    const routeCity = routeCities.get(municipalityKey);
    const feature = features.get(municipalityKey);
    const datasetCity = datasetCities.get(municipalityKey);
    if (!routeCity || !feature || !datasetCity) throw new Error(`Le calcul d’ancres exige RouteCity, référentiel et limite pour ${municipalityKey}.`);
    const controlled = controlledFirstOccurrenceHint(input.route, input.dataset, datasetCity);
    const primary = collectValidatedPrimaryAnchors({ route: input.route, routeCity, chainageOffsets });
    const proposal = proposeBoundaryAnchors({
      cityPoint: { latitude: routeCity.city.latitude, longitude: routeCity.city.longitude },
      expectedOccurrences: routeCity.expectedOccurrences,
      routeSegments: boundaryRoute,
      geometry: feature.geometry,
      ...(controlled.hint ? { firstOccurrenceHint: controlled.hint } : {}),
      primaryAnchors: primary.anchors,
      initialAmbiguityReasons: [...controlled.ambiguityReasons, ...primary.ambiguityReasons],
    });
    for (const occurrence of proposal.occurrences) {
      const semantic = buildAnchorSemanticKey(input.route.routeKey, municipalityKey, occurrence.occurrenceIndex);
      const anchorKey = buildAnchorKey(semantic, occurrence.sourceHash);
      const existing = routeCity.anchors.find((anchor) => anchor.anchorKey === anchorKey);
      const conflict = existing && (
        existing.chainageMetres !== occurrence.chainageMetres
        || existing.trackIndex !== occurrence.trackIndex
        || existing.segmentIndex !== occurrence.segmentIndex
        || existing.pointIndex !== occurrence.pointIndex
        || existing.fraction !== occurrence.sourceFraction
        || existing.routeSegmentIndex !== occurrence.sourceSegmentIndex
        || existing.projectedLatitude !== occurrence.projectedLatitude
        || existing.projectedLongitude !== occurrence.projectedLongitude
        || existing.distanceToTraceMetres !== occurrence.distanceToTraceMetres
        || existing.origin !== occurrence.selectionOrigin
      );
      const operation: AnchorOperation = {
        kind: 'upsert_anchor',
        key: anchorKey,
        action: conflict ? 'conflict' : existing ? 'reuse' : 'create',
        municipalityKey,
        routeCityKey: routeCity.routeCityKey,
        anchorKey,
        anchorSemanticKey: semantic,
        occurrenceIndex: occurrence.occurrenceIndex,
        chapterDocumentId: input.route.segments[occurrence.sourceSegmentIndex].chapterDocumentId,
        chapterSlug: input.route.segments[occurrence.sourceSegmentIndex].chapterKey,
        sourceSegmentIndex: occurrence.sourceSegmentIndex,
        sourceHash: occurrence.sourceHash,
        trackIndex: occurrence.trackIndex,
        segmentIndex: occurrence.segmentIndex,
        pointIndex: occurrence.pointIndex,
        fraction: occurrence.sourceFraction,
        chainageMetres: occurrence.chainageMetres,
        projectedLatitude: occurrence.projectedLatitude,
        projectedLongitude: occurrence.projectedLongitude,
        distanceToTraceMetres: occurrence.distanceToTraceMetres,
        origin: occurrence.selectionOrigin,
        validationStatus: proposal.status,
        ambiguityReasons: proposal.ambiguityReasons,
        expectedTargetHash: hashAnchorTargetState(existing),
        expectedResultHash: '',
      };
      operation.expectedResultHash = conflict || existing
        ? hashAnchorTargetState(existing)
        : hashAnchorOperationResult(operation);
      operations.push(operation);
    }
  }
  const calculatedOccurrences = operations.length;
  const sourceInputHash = hashCanonical({
    version: 1,
    routeFingerprint: buildRouteFingerprint(input.route),
    datasetHash: input.dataset.datasetHash,
    boundaryManifestHash: input.boundarySnapshot.manifestHash,
    routeCities: input.routeCities.map((item) => ({
      routeCityKey: item.routeCityKey,
      qualificationStatus: item.qualificationStatus,
      qualificationSourceHash: item.qualificationSourceHash,
      expectedOccurrences: item.expectedOccurrences,
      municipalityKey: item.city.municipalityKey,
      latitude: item.city.latitude,
      longitude: item.city.longitude,
    })).sort((first, second) => first.routeCityKey.localeCompare(second.routeCityKey)),
  });
  return finalizeCataloguePlan({
    version: 1,
    mode: 'anchors',
    codeVersion: input.codeVersion,
    algorithmVersion: ALGORITHM_VERSION.projection,
    inputHash: computeAnchorsInputHash({
      route: input.route,
      routeCities: input.routeCities,
      datasetHash: input.dataset.datasetHash,
      boundaryManifestHash: input.boundarySnapshot.manifestHash,
    }),
    scope: {
      routeKey: input.route.routeKey,
      datasetHash: input.dataset.datasetHash,
      boundaryManifestHash: input.boundarySnapshot.manifestHash,
      sourceInputHash,
    },
    summary: {
      expectedMunicipalities: 223,
      expectedOccurrences: 449,
      calculatedOccurrences,
      differences: Math.abs(449 - calculatedOccurrences),
      ambiguousMunicipalities: new Set(operations.filter((item) => item.validationStatus === 'ambiguous').map((item) => item.municipalityKey)).size,
      creates: operations.filter((item) => item.action === 'create').length,
      reuses: operations.filter((item) => item.action === 'reuse').length,
      conflicts: operations.filter((item) => item.action === 'conflict').length,
    },
    operations,
    generatedAt: new Date().toISOString(),
  });
}

export function loadBoundarySnapshotFromTexts(input: {
  geoJsonText: string;
  manifestText: string;
  dataset: ControlledCatalogueDataset;
}): BoundarySnapshot {
  return parseVersionedBoundarySnapshot(
    input.geoJsonText,
    input.manifestText,
    input.dataset.cities.map((city) => city.municipalityKey),
  );
}

export function computeCalculationInputHash(
  route: RuntimeRoute,
  routeCities: RuntimeRouteCity[],
  existingItineraries: ExistingItineraryState[] = [],
  baselineHash: string | null = null,
): string {
  return hashCanonical({
    version: 1,
    routeFingerprint: buildRouteFingerprint(route),
    routeCities: routeCities.map((item) => buildRouteCityFingerprint(item)).sort(),
    algorithmVersion: ALGORITHM_VERSION,
    thresholds: { routeMetres: 60_000, directMetres: 40_000 },
    baselineHash,
    existingItineraries: existingItineraries.map((item) => ({ ...item, revisionKeys: [...item.revisionKeys].sort() }))
      .sort((first, second) => first.businessKey.localeCompare(second.businessKey)),
  });
}

export function hashExistingItineraryState(value: ExistingItineraryState | null | undefined): string {
  return hashCanonical(value ? { ...value, revisionKeys: [...value.revisionKeys].sort() } : null);
}

export function hashExistingItineraryCas(value: ExistingItineraryState | null | undefined): string {
  if (!value) return hashCanonical(null);
  const { activeArtifactsVerified: _integrityEvidence, ...structural } = value;
  return hashCanonical({ ...structural, revisionKeys: [...structural.revisionKeys].sort() });
}

export function archivedItineraryResultState(existing: ExistingItineraryState): ExistingItineraryState {
  return {
    ...existing,
    currentEvaluationHash: null,
    publicationNext: false,
    ...(existing.activeRevisionKey ? { activeRevisionCalculationStatus: 'archived' } : {}),
  };
}

export function upsertedItineraryResultState(
  existing: ExistingItineraryState | null | undefined,
  operation: CalculationUpsertOperation,
): ExistingItineraryState {
  const activeIsTarget = existing?.activeRevisionKey === operation.revisionKey;
  const activeBecomesStale = operation.action === 'stale'
    && Boolean(existing?.activeRevisionKey)
    && !activeIsTarget;
  return {
    documentId: existing?.documentId ?? '',
    businessKey: operation.businessKey,
    slug: existing?.slug ?? operation.slug,
    title: existing?.title ?? operation.title,
    cityAKey: existing?.cityAKey ?? operation.cityAKey,
    cityBKey: existing?.cityBKey ?? operation.cityBKey,
    currentEvaluationHash: operation.evaluationHash,
    activeRevisionKey: existing?.activeRevisionKey ?? null,
    activeRevisionSourceHash: existing?.activeRevisionSourceHash ?? null,
    activeDepartureKey: existing?.activeDepartureKey ?? null,
    activeArrivalKey: existing?.activeArrivalKey ?? null,
    activeLastVerifiedEvaluationHash: activeIsTarget
      ? operation.evaluationHash
      : existing?.activeLastVerifiedEvaluationHash ?? null,
    activeArtifactsVerified: activeIsTarget ? true : existing?.activeArtifactsVerified ?? false,
    activeGeneratedGpxMediaIdentity: existing?.activeGeneratedGpxMediaIdentity ?? null,
    activeDisplayGeometryMediaIdentity: existing?.activeDisplayGeometryMediaIdentity ?? null,
    activeGeneratedGpxSha256: activeIsTarget
      ? operation.generatedGpxSha256
      : existing?.activeGeneratedGpxSha256 ?? null,
    activeDisplayGeometrySha256: activeIsTarget
      ? operation.displayGeometrySha256
      : existing?.activeDisplayGeometrySha256 ?? null,
    activeRevisionCalculationStatus: activeIsTarget
      ? operation.calculationStatus
      : activeBecomesStale ? 'stale' : existing?.activeRevisionCalculationStatus ?? null,
    activeArtifactIntegrityStatus: activeIsTarget
      ? 'verified'
      : existing?.activeArtifactIntegrityStatus ?? null,
    activeArtifactIntegrityHash: activeIsTarget
      ? computeArtifactIntegrityHash({
        sourceHash: operation.sourceHash,
        generatedGpxSha256: operation.generatedGpxSha256,
        displayGeometrySha256: operation.displayGeometrySha256,
      })
      : existing?.activeArtifactIntegrityHash ?? null,
    publicationNext: existing?.publicationNext ?? false,
    revisionKeys: [...new Set([...(existing?.revisionKeys ?? []), operation.revisionKey])].sort(),
  };
}

export function hashExistingItineraryPostCas(value: ExistingItineraryState | null | undefined): string {
  if (!value) return hashCanonical(null);
  const {
    documentId: _databaseIdentity,
    activeArtifactsVerified: _binaryEvidence,
    ...structural
  } = value;
  return hashCanonical({ ...structural, revisionKeys: [...structural.revisionKeys].sort() });
}

export function expectedCalculationUpsertResultHash(operation: CalculationUpsertOperation): string {
  return hashCanonical({
    version: 1,
    itineraryPostCasHash: operation.expectedItineraryPostCasHash,
    revision: {
      revisionKey: operation.revisionKey,
      businessKey: operation.businessKey,
      sourceHash: operation.sourceHash,
      evaluationHash: operation.evaluationHash,
      departureKey: operation.departureKey,
      arrivalKey: operation.arrivalKey,
      departureAnchorKey: operation.departureAnchorKey,
      arrivalAnchorKey: operation.arrivalAnchorKey,
      distanceMetres: operation.distanceMetres,
      directMetres: operation.directMetres,
      elevationGainMetres: operation.elevationGainMetres,
      elevationLossMetres: operation.elevationLossMetres,
      elevationAvailable: operation.elevationAvailable,
      eligibleByRoute: operation.eligibleByRoute,
      eligibleByDirect: operation.eligibleByDirect,
      detourRatio: operation.detourRatio,
      usesLoopOrigin: operation.usesLoopOrigin,
      junctionWarnings: operation.junctionWarnings,
      chaptersOnRoute: operation.chaptersOnRoute,
      citiesOnRoute: operation.citiesOnRoute,
      generatedGpxSha256: operation.generatedGpxSha256,
      generatedGpxSize: operation.generatedGpxSize,
      generatedGpxMediaIdentity: operation.expectedGeneratedGpxMediaIdentity
        ?? hashCanonical({
          sha256: operation.generatedGpxSha256,
          size: operation.generatedGpxSize,
          mime: 'application/gpx+xml',
        }),
      displayGeometrySha256: operation.displayGeometrySha256,
      displayGeometrySize: operation.displayGeometrySize,
      displayGeometryMediaIdentity: operation.expectedDisplayGeometryMediaIdentity
        ?? hashCanonical({
          sha256: operation.displayGeometrySha256,
          size: operation.displayGeometrySize,
          mime: 'application/json',
        }),
      lastVerifiedEvaluationHash: operation.evaluationHash,
      algorithmVersion: ALGORITHM_VERSION.catalogue,
      calculationStatus: operation.calculationStatus,
      artifactIntegrityStatus: 'verified',
      artifactIntegrityHash: computeArtifactIntegrityHash({
        sourceHash: operation.sourceHash,
        generatedGpxSha256: operation.generatedGpxSha256,
        displayGeometrySha256: operation.displayGeometrySha256,
      }),
      calculationReport: {
        qualityWarningCodes: operation.qualityWarningCodes,
        directDistanceMethod: operation.directDistanceMethod,
        differences: operation.differences,
        thresholdQaComparison: 'thresholdQaComparison' in operation
          ? (operation as CalculationUpsertOperation & { thresholdQaComparison?: unknown }).thresholdQaComparison ?? null
          : null,
      },
    },
  });
}

export function computeCalculationSourceInputHash(
  route: RuntimeRoute,
  routeCities: RuntimeRouteCity[],
  baselineHash: string | null = null,
): string {
  return hashCanonical({
    version: 1,
    routeFingerprint: buildRouteFingerprint(route),
    routeCities: routeCities.map((item) => buildRouteCityFingerprint(item)).sort(),
    baselineHash,
    algorithmVersion: ALGORITHM_VERSION,
    thresholds: { routeMetres: 60_000, directMetres: 40_000 },
  });
}

function slugify(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 180);
}

function forwardChainage(start: number, value: number, routeLength: number): number {
  const delta = value - start;
  return delta >= 0 ? delta : routeLength + delta;
}

export function computeQualityWarningCodes(input: {
  distanceMetres: number;
  directMetres: number;
  eligibleByRoute: boolean;
  eligibleByDirect: boolean;
  usesLoopOrigin: boolean;
  acceptedGapCount: number;
  multiOccurrence: boolean;
  directConverged: boolean;
  departureShopOverTwoKilometres: boolean;
  arrivalShopOverTwoKilometres: boolean;
  baselineDistanceDeltaMetres: number | null;
  baselineDirectDeltaMetres: number | null;
  baselinePresent: boolean;
  differences: readonly string[];
}): string[] {
  const warnings: string[] = [];
  if (Math.abs(input.distanceMetres - 60_000) <= 250) warnings.push('route_threshold_within_250m');
  if (Math.abs(input.directMetres - 40_000) <= 250) warnings.push('direct_threshold_within_250m');
  if (input.distanceMetres < 500) warnings.push('route_under_500m');
  if (input.distanceMetres < 100) warnings.push('route_under_100m');
  if (input.distanceMetres > 100_000) warnings.push('route_over_100km');
  if (input.distanceMetres > 200_000) warnings.push('route_over_200km');
  const detourRatio = input.directMetres > 0 ? input.distanceMetres / input.directMetres : null;
  if (detourRatio !== null && detourRatio > 2) warnings.push('detour_ratio_over_2');
  if (detourRatio !== null && detourRatio > 3) warnings.push('detour_ratio_over_3');
  if (detourRatio !== null && detourRatio > 5) warnings.push('detour_ratio_over_5');
  if (!input.eligibleByRoute && input.eligibleByDirect) warnings.push('direct_only');
  if (input.usesLoopOrigin) warnings.push('uses_loop_origin');
  if (input.acceptedGapCount > 0) warnings.push('accepted_gap');
  if (input.multiOccurrence) warnings.push('multiple_occurrences');
  if (input.departureShopOverTwoKilometres) warnings.push('departure_shop_over_2km');
  if (input.arrivalShopOverTwoKilometres) warnings.push('arrival_shop_over_2km');
  if (!input.directConverged) warnings.push('vincenty_non_convergence');
  if (!input.baselinePresent) warnings.push('baseline_product_missing');
  if (input.baselineDistanceDeltaMetres !== null && Math.abs(input.baselineDistanceDeltaMetres) > 0.01) {
    warnings.push('baseline_route_distance_diff');
  }
  if (input.baselineDirectDeltaMetres !== null && Math.abs(input.baselineDirectDeltaMetres) > 0.01) {
    warnings.push('baseline_direct_distance_diff');
  }
  if (input.differences.includes('direction_changed')) warnings.push('direction_changed');
  if (input.differences.includes('slug_diff')) warnings.push('slug_diff');
  if (input.differences.includes('title_diff')) warnings.push('title_diff');
  return [...new Set(warnings)].sort();
}

function baselineForPair(products: readonly CatalogueDatasetProduct[], first: string, second: string): CatalogueDatasetProduct | undefined {
  const key = [first, second].sort().join('__');
  return products.find((product) => [product.municipalityKeyA, product.municipalityKeyB].sort().join('__') === key);
}

function thresholdQaForPair(
  references: ReadonlyMap<string, CatalogueDatasetThresholdQaRow>,
  first: string,
  second: string,
): CatalogueDatasetThresholdQaRow | undefined {
  return references.get(catalogueThresholdQaPairKey(first, second));
}

export function validateRouteCityAnchorsForCalculation(
  route: RuntimeRoute,
  routeCity: RuntimeRouteCity,
): RuntimeAnchor[] {
  const validated = routeCity.anchors.filter((anchor) => anchor.status === 'validated');
  if (validated.length !== routeCity.expectedOccurrences) {
    throw new Error(`${routeCity.routeCityKey} doit posséder exactement ${routeCity.expectedOccurrences} ancre(s) validée(s), reçu ${validated.length}.`);
  }
  for (const anchor of validated) {
    const segment = route.segments[anchor.routeSegmentIndex];
    if (
      !segment
      || segment.chapterDocumentId !== anchor.chapterDocumentId
      || segment.sourceSha256.toLowerCase() !== anchor.sourceSha256.toLowerCase()
      || anchor.sourceDirection !== 'ab'
      || anchor.algorithmVersion !== ALGORITHM_VERSION.projection
    ) throw new Error(`${anchor.anchorKey} ne correspond pas aux sources AB courantes.`);
    try {
      recomposeRouteAnchorPosition({
        route: route.segments,
        anchor,
        cityPoint: { latitude: routeCity.city.latitude, longitude: routeCity.city.longitude },
        storedDistanceToTraceMetres: anchor.distanceToTraceMetres,
      });
    } catch (error) {
      throw new Error(
        `${anchor.anchorKey} ne se recompose pas exactement depuis le GPX publié : ${error instanceof Error ? error.message : 'erreur inconnue'}`,
      );
    }
  }
  return validated;
}

export function planCatalogueCalculation(input: {
  route: RuntimeRoute;
  routeCities: RuntimeRouteCity[];
  baselineProducts?: readonly CatalogueDatasetProduct[];
  thresholdQa?: readonly CatalogueDatasetThresholdQaRow[];
  baselineHash?: string | null;
  existingItineraries?: ExistingItineraryState[];
  codeVersion: string;
}): CataloguePlan<CalculationOperation> {
  // Bootstrap sûr : la route publiée peut rester catalogueEnabled=false
  // pendant le premier calcul. Les pages restent fermées; apply écrit les
  // fingerprints, puis seulement un éditeur peut activer le flag public.
  const unresolvedJunction = input.route.segments.find((segment) => (
    !['exact', 'accepted_gap'].includes(segment.junctionAfter.status)
  ));
  if (unresolvedJunction) {
    throw new Error(
      `La jonction après ${unresolvedJunction.chapterKey} doit être relue exact/accepted_gap avant calculate.`,
    );
  }
  const routeFingerprint = buildRouteFingerprint(input.route);
  const usable = input.routeCities.filter((item) => item.qualificationStatus === 'validated')
    .sort((first, second) => first.routeCityKey.localeCompare(second.routeCityKey));
  for (const routeCity of usable) {
    validateRouteCityAnchorsForCalculation(input.route, routeCity);
  }
  const routeLengthMetres = input.route.segments.reduce((sum, segment) => (
    sum + totalSequenceDistanceMetres(segment.document.tracks.flatMap((track) => track.segments.map((part) => part.points)))
  ), 0);
  const routeCityFingerprints = new Map(usable.map((item) => [item.routeCityKey, buildRouteCityFingerprint(item)]));
  const operations: CalculationOperation[] = [];
  const existingByBusinessKey = new Map((input.existingItineraries ?? []).map((item) => [item.businessKey, item]));
  const thresholdQaByPair = new Map<string, CatalogueDatasetThresholdQaRow>();
  for (const reference of input.thresholdQa ?? []) {
    const key = catalogueThresholdQaPairKey(reference.municipalityKeyA, reference.municipalityKeyB);
    if (thresholdQaByPair.has(key)) throw new Error(`La QA seuils contient une paire dupliquée (${key}).`);
    thresholdQaByPair.set(key, reference);
  }
  const comparedThresholdQaKeys = new Set<string>();
  const unavailableThresholdQaKeys = new Set<string>();
  let matchedThresholdQa = 0;
  let differentThresholdQa = 0;
  const plannedBusinessKeys = new Set<string>();
  const pairOutcomes = new Map<string, 'eligible' | 'ineligible' | 'error'>();
  let blockedPairs = 0;
  let ineligiblePairs = 0;
  let errorPairs = 0;
  for (let firstIndex = 0; firstIndex < usable.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < usable.length; secondIndex += 1) {
      const first = usable[firstIndex];
      const second = usable[secondIndex];
      const businessKey = buildBusinessKey(
        input.route.routeKey,
        first.city.municipalityKey,
        second.city.municipalityKey,
      );
      const thresholdQaKey = catalogueThresholdQaPairKey(
        first.city.municipalityKey,
        second.city.municipalityKey,
      );
      const thresholdQa = thresholdQaForPair(
        thresholdQaByPair,
        first.city.municipalityKey,
        second.city.municipalityKey,
      );
      const anchorsA = first.anchors.filter((anchor) => anchor.status === 'validated');
      const anchorsB = second.anchors.filter((anchor) => anchor.status === 'validated');
      let selection;
      try {
        selection = selectShortestArc({
          anchorsA,
          anchorsB,
          routeLengthMetres,
          junctions: input.route.segments.map((segment) => ({
            afterSegmentIndex: segment.index,
            status: segment.junctionAfter.status,
          })),
          sequenceCountForCandidate: (departure, arrival) => extractRouteArc(input.route.segments, departure, arrival).sequences.length,
        });
      } catch (error) {
        errorPairs += 1;
        pairOutcomes.set(businessKey, 'error');
        // Preserve any currently published itinerary for this pair. An
        // internal/fixture error is reportable, never evidence that the
        // product became ineligible or should be archived.
        plannedBusinessKeys.add(businessKey);
        const detail = error instanceof Error ? error.message : 'échec de sélection inconnu';
        if (thresholdQa) {
          unavailableThresholdQaKeys.add(thresholdQaKey);
          operations.push({
            kind: 'threshold_qa_review',
            key: `threshold-qa:${thresholdQa.productId}`,
            action: 'review',
            businessKey,
            cityAKey: first.city.municipalityKey,
            cityBKey: second.city.municipalityKey,
            referenceProductId: thresholdQa.productId,
            qaStatus: 'unavailable',
            differenceCodes: [],
            reason: 'calculation_error',
            message: detail.slice(0, 300),
          });
        } else {
          operations.push({
            kind: 'calculation_error',
            key: `error:${businessKey}`,
            action: 'error',
            businessKey,
            cityAKey: first.city.municipalityKey,
            cityBKey: second.city.municipalityKey,
            errorCode: 'selection_failed',
            message: detail.slice(0, 300),
          });
        }
        continue;
      }
      const departureRouteCity = selection.departure.anchorKey.startsWith(`${first.routeCityKey}:`) ? first : second;
      const arrivalRouteCity = departureRouteCity === first ? second : first;
      const arc = extractRouteArc(input.route.segments, selection.departure, selection.arrival);
      const metrics = computeElevationMetrics(arc.sequences);
      const direct = distanceWgs84Result(departureRouteCity.city, arrivalRouteCity.city);
      const eligibility = calculateEligibility(metrics.distanceMetres, direct.metres);
      const baseline = baselineForPair(input.baselineProducts ?? [], first.city.municipalityKey, second.city.municipalityKey);
      const namingFirst = thresholdQa?.municipalityKeyA === second.city.municipalityKey ? second : first;
      const namingSecond = namingFirst === first ? second : first;
      const title = baseline?.title ?? `${namingFirst.city.name} – ${namingSecond.city.name} à vélo`;
      const slug = baseline?.slug ?? `${slugify(namingFirst.city.name)}-a-${slugify(namingSecond.city.name)}`;
      let thresholdQaComparison: CalculationUpsertOperation['thresholdQaComparison'];
      if (thresholdQa) {
        const anchorByMunicipalityKey = new Map([
          [departureRouteCity.city.municipalityKey, selection.departure],
          [arrivalRouteCity.city.municipalityKey, selection.arrival],
        ]);
        const referenceAnchorA = anchorByMunicipalityKey.get(thresholdQa.municipalityKeyA);
        const referenceAnchorB = anchorByMunicipalityKey.get(thresholdQa.municipalityKeyB);
        if (!referenceAnchorA || !referenceAnchorB) {
          throw new Error(`La paire calculée ne permet pas d’orienter les ancres QA ${thresholdQa.productId}.`);
        }
        const differences = compareCatalogueThresholdQa(thresholdQa, {
          distanceMetres: metrics.distanceMetres,
          directMetres: direct.metres,
          eligibleByRoute: eligibility.eligibleByRoute,
          eligibleByDirect: eligibility.eligibleByDirect,
          retained: eligibility.eligible,
          shortestPathViaOrigin: selection.usesLoopOrigin,
          slug,
          title,
          anchorA: {
            chapterLabel: input.route.segments[referenceAnchorA.routeSegmentIndex].chapterTitle,
            chainageMetres: referenceAnchorA.chainageMetres,
          },
          anchorB: {
            chapterLabel: input.route.segments[referenceAnchorB.routeSegmentIndex].chapterTitle,
            chainageMetres: referenceAnchorB.chainageMetres,
          },
        });
        comparedThresholdQaKeys.add(thresholdQaKey);
        if (differences.length === 0) matchedThresholdQa += 1;
        else differentThresholdQa += 1;
        thresholdQaComparison = {
          referenceProductId: thresholdQa.productId,
          status: differences.length === 0 ? 'matched' : 'different',
          differenceCodes: differences,
        };
      }
      if (!eligibility.eligible) {
        ineligiblePairs += 1;
        pairOutcomes.set(businessKey, 'ineligible');
        if (thresholdQa && thresholdQaComparison?.status === 'different') {
          plannedBusinessKeys.add(businessKey);
          operations.push({
            kind: 'threshold_qa_review',
            key: `threshold-qa:${thresholdQa.productId}`,
            action: 'review',
            businessKey,
            cityAKey: first.city.municipalityKey,
            cityBKey: second.city.municipalityKey,
            referenceProductId: thresholdQa.productId,
            qaStatus: 'different',
            differenceCodes: thresholdQaComparison.differenceCodes,
            reason: 'ineligible_mismatch',
          });
        }
        continue;
      }
      pairOutcomes.set(businessKey, 'eligible');
      plannedBusinessKeys.add(businessKey);
      const segmentBySlug = new Map(input.route.segments.map((segment) => [segment.chapterKey, segment]));
      const traversedSegments = arc.chapters.map((chapter) => segmentBySlug.get(chapter.chapterKey)!);
      const sourceHash = hashCanonical({
        version: 1,
        businessKey,
        route: {
          routeKey: input.route.routeKey,
          originChapterSlug: input.route.segments[0].chapterKey,
          traversedSegments: traversedSegments.map((segment) => ({
            index: segment.index,
            chapterSlug: segment.chapterKey,
            sourceSha256: segment.sourceSha256,
            direction: segment.direction,
          })),
          crossedJunctions: traversedSegments.slice(0, -1).map((segment) => ({
            afterChapterSlug: segment.chapterKey,
            status: segment.junctionAfter.status,
            gapMetres: segment.junctionAfter.gapMetres,
            nextSourceSha256: segment.junctionAfter.nextSourceSha256,
          })),
        },
        cities: [departureRouteCity, arrivalRouteCity].map((item) => ({
          municipalityKey: item.city.municipalityKey,
          name: item.city.name,
          latitude: item.city.latitude,
          longitude: item.city.longitude,
        })),
        anchors: [selection.departure, selection.arrival].map((anchor) => ({
          anchorKey: anchor.anchorKey,
          routeSegmentIndex: anchor.routeSegmentIndex,
          sourceSha256: anchor.sourceSha256,
          trackIndex: anchor.trackIndex,
          segmentIndex: anchor.segmentIndex,
          pointIndex: anchor.pointIndex,
          fraction: anchor.fraction,
          chainageMetres: anchor.chainageMetres,
          projectedLatitude: anchor.projectedLatitude,
          projectedLongitude: anchor.projectedLongitude,
        })),
        thresholds: { routeMetres: 60_000, directMetres: 40_000, comparison: 'strict_lt', combination: 'or' },
        algorithmVersion: ALGORITHM_VERSION,
      });
      const revisionKey = buildRevisionKey(businessKey, sourceHash, ALGORITHM_VERSION.catalogue);
      const evaluationHash = computeEvaluationHash({
        routeFingerprint,
        routeCities: [first, second].map((item) => ({
          routeCityKey: item.routeCityKey,
          fingerprint: routeCityFingerprints.get(item.routeCityKey),
        })),
        algorithmVersion: ALGORITHM_VERSION.catalogue,
      });
      const gpx = serializeCatalogueGpx({
        departureName: departureRouteCity.city.name,
        arrivalName: arrivalRouteCity.city.name,
        revisionKey,
        sourceHash,
        algorithmVersion: ALGORITHM_VERSION.catalogue,
        sequences: arc.sequences,
      });
      const display = JSON.stringify(buildDisplayGeometry({
        revisionKey,
        algorithmVersion: ALGORITHM_VERSION.catalogue,
        sequences: arc.sequences,
        elevationAvailable: metrics.elevationAvailable,
      }));
      const gpxSha = sha256Hex(gpx);
      const displaySha = sha256Hex(display);
      const candidatesOnArc = usable.flatMap((routeCity) => routeCity.anchors
        .filter((anchor) => anchor.status === 'validated')
        .map((anchor) => ({ routeCity, anchor, distance: forwardChainage(selection.departure.chainageMetres, anchor.chainageMetres, routeLengthMetres) })))
        .filter((candidate) => candidate.distance <= metrics.distanceMetres + 0.01)
        .sort((a, b) => a.distance - b.distance || a.anchor.anchorKey.localeCompare(b.anchor.anchorKey));
      const firstOccurrence = new Map<string, typeof candidatesOnArc[number]>();
      for (const candidate of candidatesOnArc) {
        if (!firstOccurrence.has(candidate.routeCity.city.municipalityKey)) firstOccurrence.set(candidate.routeCity.city.municipalityKey, candidate);
      }
      const chapterBySlug = new Map(input.route.segments.map((segment) => [segment.chapterKey, segment]));
      const existing = existingByBusinessKey.get(businessKey);
      const differences: string[] = [];
      if (existing?.slug && existing.slug !== slug) differences.push('slug_diff');
      if (existing?.title && existing.title !== title) differences.push('title_diff');
      if (
        existing?.activeDepartureKey
        && (existing.activeDepartureKey !== departureRouteCity.city.municipalityKey
          || existing.activeArrivalKey !== arrivalRouteCity.city.municipalityKey)
      ) differences.push('direction_changed');
      const baselineDistanceDeltaMetres = baseline
        ? metrics.distanceMetres - baseline.distanceMetres
        : null;
      const baselineDirectDeltaMetres = baseline
        ? direct.metres - baseline.directMetres
        : null;
      const warnings = computeQualityWarningCodes({
        distanceMetres: metrics.distanceMetres,
        directMetres: direct.metres,
        eligibleByRoute: eligibility.eligibleByRoute,
        eligibleByDirect: eligibility.eligibleByDirect,
        usesLoopOrigin: selection.usesLoopOrigin,
        acceptedGapCount: arc.warnings.length,
        multiOccurrence: anchorsA.length > 1 || anchorsB.length > 1,
        directConverged: direct.converged,
        departureShopOverTwoKilometres:
          departureRouteCity.qualificationEvidence?.overTwoKilometresWarning === true,
        arrivalShopOverTwoKilometres:
          arrivalRouteCity.qualificationEvidence?.overTwoKilometresWarning === true,
        baselineDistanceDeltaMetres,
        baselineDirectDeltaMetres,
        baselinePresent: baseline !== undefined,
        differences,
      });
      if (thresholdQaComparison?.status === 'different') {
        warnings.push('threshold_qa_mismatch');
        warnings.sort();
      }
      const calculationStatus: CalculationUpsertOperation['calculationStatus'] = warnings.length ? 'warning' : 'ready';
      const artifactIntegrityHash = computeArtifactIntegrityHash({
        sourceHash,
        generatedGpxSha256: gpxSha,
        displayGeometrySha256: displaySha,
      });
      let action: CalculationUpsertOperation['action'];
      if (!existing) action = 'create';
      else if (!existing.revisionKeys.includes(revisionKey)) {
        action = existing.activeRevisionSourceHash && existing.activeRevisionSourceHash !== sourceHash ? 'stale' : 'new_revision';
      } else if (
        existing.activeRevisionKey === revisionKey
        && existing.currentEvaluationHash === evaluationHash
        && existing.activeLastVerifiedEvaluationHash === evaluationHash
        && existing.activeArtifactsVerified
        && existing.activeRevisionCalculationStatus === calculationStatus
        && existing.activeArtifactIntegrityStatus === 'verified'
        && existing.activeArtifactIntegrityHash === artifactIntegrityHash
      ) action = 'unchanged';
      else action = 'reverified_unchanged';
      const operation: CalculationUpsertOperation = {
        kind: 'upsert_itinerary_revision',
        key: revisionKey,
        action,
        differences,
        expectedItineraryStateHash: hashExistingItineraryState(existing),
        expectedItineraryCasHash: hashExistingItineraryCas(existing),
        expectedItineraryPostCasHash: '',
        expectedItineraryResultHash: '',
        expectedGeneratedGpxMediaIdentity: existing?.activeRevisionKey === revisionKey
          ? existing.activeGeneratedGpxMediaIdentity ?? null
          : null,
        expectedDisplayGeometryMediaIdentity: existing?.activeRevisionKey === revisionKey
          ? existing.activeDisplayGeometryMediaIdentity ?? null
          : null,
        businessKey,
        revisionKey,
        sourceHash,
        evaluationHash,
        title,
        slug,
        cityAKey: first.city.municipalityKey,
        cityBKey: second.city.municipalityKey,
        departureKey: departureRouteCity.city.municipalityKey,
        arrivalKey: arrivalRouteCity.city.municipalityKey,
        departureAnchorKey: selection.departure.anchorKey,
        arrivalAnchorKey: selection.arrival.anchorKey,
        distanceMetres: metrics.distanceMetres,
        directMetres: direct.metres,
        directDistanceMethod: direct.method,
        eligibleByRoute: eligibility.eligibleByRoute,
        eligibleByDirect: eligibility.eligibleByDirect,
        elevationAvailable: metrics.elevationAvailable,
        elevationGainMetres: metrics.elevationGainMetres,
        elevationLossMetres: metrics.elevationLossMetres,
        detourRatio: direct.metres === 0 ? null : metrics.distanceMetres / direct.metres,
        usesLoopOrigin: selection.usesLoopOrigin,
        junctionWarnings: arc.warnings.map(({ reviewNote: _reviewNote, ...warning }) => warning),
        qualityWarningCodes: warnings,
        calculationStatus,
        chaptersOnRoute: arc.chapters.map((chapter, routeOrder) => ({
          chapterDocumentId: chapterBySlug.get(chapter.chapterKey)!.chapterDocumentId,
          chapterSlug: chapter.chapterKey,
          routeOrder,
          distanceMetres: chapter.distanceMetres,
          direction: 'ab',
        })),
        citiesOnRoute: [...firstOccurrence.values()].sort((a, b) => a.distance - b.distance).map((candidate, routeOrder) => ({
          municipalityKey: candidate.routeCity.city.municipalityKey,
          cityDocumentId: candidate.routeCity.city.documentId,
          routeOrder,
          occurrenceIndex: candidate.anchor.occurrenceIndex,
          chainageFromDepartureMetres: candidate.distance,
        })),
        generatedGpxSha256: gpxSha,
        generatedGpxSize: new TextEncoder().encode(gpx).byteLength,
        generatedGpxName: `${gpxSha}-${slug}.gpx`,
        displayGeometrySha256: displaySha,
        displayGeometrySize: new TextEncoder().encode(display).byteLength,
        displayGeometryName: `${displaySha}-${slug}.json`,
        ...(baseline ? {
          baselineDistanceDeltaMetres,
          baselineDirectDeltaMetres,
        } : {}),
        ...(thresholdQaComparison ? { thresholdQaComparison } : {}),
      };
      operation.expectedItineraryPostCasHash = hashExistingItineraryPostCas(
        upsertedItineraryResultState(existing, operation),
      );
      operation.expectedItineraryResultHash = expectedCalculationUpsertResultHash(operation);
      operations.push(operation);
    }
  }
  for (const [thresholdQaKey, thresholdQa] of thresholdQaByPair) {
    if (comparedThresholdQaKeys.has(thresholdQaKey) || unavailableThresholdQaKeys.has(thresholdQaKey)) continue;
    unavailableThresholdQaKeys.add(thresholdQaKey);
    const businessKey = buildBusinessKey(
      input.route.routeKey,
      thresholdQa.municipalityKeyA,
      thresholdQa.municipalityKeyB,
    );
    plannedBusinessKeys.add(businessKey);
    operations.push({
      kind: 'threshold_qa_review',
      key: `threshold-qa:${thresholdQa.productId}`,
      action: 'review',
      businessKey,
      cityAKey: thresholdQa.municipalityKeyA,
      cityBKey: thresholdQa.municipalityKeyB,
      referenceProductId: thresholdQa.productId,
      qaStatus: 'unavailable',
      differenceCodes: [],
      reason: 'inputs_unavailable',
    });
  }
  for (const existing of input.existingItineraries ?? []) {
    if (plannedBusinessKeys.has(existing.businessKey)) continue;
    const outcome = pairOutcomes.get(existing.businessKey);
    const businessKeyParts = existing.businessKey.split(':');
    const cityAKey = existing.cityAKey ?? businessKeyParts[businessKeyParts.length - 2];
    const cityBKey = existing.cityBKey ?? businessKeyParts[businessKeyParts.length - 1];
    if (!cityAKey || !cityBKey) throw new Error(`La paire ${existing.businessKey} ne permet pas de cibler ses villes.`);
    operations.push({
      kind: 'archive_itinerary',
      key: `archive:${existing.businessKey}`,
      action: 'archive',
      businessKey: existing.businessKey,
      cityAKey,
      cityBKey,
      itineraryDocumentId: existing.documentId,
      activeRevisionKey: existing.activeRevisionKey,
      reason: outcome === 'ineligible' ? 'ineligible' : 'inputs_unavailable',
      expectedItineraryStateHash: hashExistingItineraryState(existing),
      expectedItineraryCasHash: hashExistingItineraryCas(existing),
      expectedItineraryResultHash: hashExistingItineraryCas(archivedItineraryResultState(existing)),
    });
  }
  operations.sort((first, second) => first.businessKey.localeCompare(second.businessKey));
  const sourceInputHash = computeCalculationSourceInputHash(
    input.route,
    input.routeCities,
    input.baselineHash ?? null,
  );
  const upserts = operations.filter(
    (operation): operation is CalculationUpsertOperation => operation.kind === 'upsert_itinerary_revision',
  );
  const archives = operations.filter(
    (operation): operation is CalculationArchiveOperation => operation.kind === 'archive_itinerary',
  );
  const thresholdQaReviews = operations.filter(
    (operation): operation is CalculationThresholdQaReviewOperation => operation.kind === 'threshold_qa_review',
  );
  const warningCodeCounts = upserts.reduce<Record<string, number>>((counts, operation) => {
    for (const code of operation.qualityWarningCodes) counts[code] = (counts[code] ?? 0) + 1;
    return counts;
  }, {});
  const warningSummary = Object.fromEntries(
    Object.entries(warningCodeCounts).map(([code, count]) => [`warning_${code}`, count]),
  );
  const mediaProducingActions = new Set<CalculationUpsertOperation['action']>(['create', 'new_revision', 'stale']);
  const estimatedMediaBytes = upserts
    .filter((operation) => mediaProducingActions.has(operation.action))
    .reduce((total, operation) => total + operation.generatedGpxSize + operation.displayGeometrySize, 0);
  const archivedIneligible = archives.filter((operation) => operation.reason === 'ineligible').length;
  return finalizeCataloguePlan({
    version: 1,
    mode: 'calculate',
    codeVersion: input.codeVersion,
    algorithmVersion: ALGORITHM_VERSION.catalogue,
    inputHash: computeCalculationInputHash(
      input.route,
      input.routeCities,
      input.existingItineraries,
      input.baselineHash ?? null,
    ),
    scope: { routeKey: input.route.routeKey, baselineHash: input.baselineHash ?? null, sourceInputHash },
    summary: {
      validatedCities: usable.length,
      consideredPairs: usable.length * (usable.length - 1) / 2,
      eligiblePairs: upserts.length,
      blockedPairs,
      ineligiblePairs,
      errorPairs,
      creates: upserts.filter((operation) => operation.action === 'create').length,
      newRevisions: upserts.filter((operation) => operation.action === 'new_revision').length,
      reverifiedUnchanged: upserts.filter((operation) => operation.action === 'reverified_unchanged').length,
      unchanged: upserts.filter((operation) => operation.action === 'unchanged').length,
      stale: upserts.filter((operation) => operation.action === 'stale').length,
      warningRevisions: upserts.filter((operation) => operation.calculationStatus === 'warning').length,
      vincentyFallbacks: upserts.filter((operation) => operation.directDistanceMethod === 'haversine_fallback').length,
      archives: archives.length,
      errors: errorPairs,
      unaffected: Math.max(0, ineligiblePairs - archivedIneligible),
      baselineReferenceProducts: input.baselineProducts?.length ?? 0,
      baselineCompared: upserts.filter((operation) => operation.baselineDistanceDeltaMetres !== undefined).length,
      baselineDifferences: upserts.filter((operation) => operation.qualityWarningCodes.some((code) => (
        code === 'baseline_product_missing'
        || code === 'baseline_route_distance_diff'
        || code === 'baseline_direct_distance_diff'
      ))).length,
      thresholdQaCompared: comparedThresholdQaKeys.size,
      thresholdQaMatched: matchedThresholdQa,
      thresholdQaDifferences: differentThresholdQa,
      thresholdQaUnavailable: unavailableThresholdQaKeys.size,
      thresholdQaReviews: thresholdQaReviews.length,
      qualityWarnings: Object.values(warningCodeCounts).reduce((total, count) => total + count, 0),
      ...warningSummary,
      estimatedMediaBytes,
    },
    operations,
    generatedAt: new Date().toISOString(),
  });
}

export function materializeCalculationArtifacts(input: {
  operation: CalculationUpsertOperation;
  route: RuntimeRoute;
  routeCities: RuntimeRouteCity[];
}): { gpx: Uint8Array; display: Uint8Array } {
  const anchorByKey = new Map(input.routeCities.flatMap((item) => item.anchors).map((anchor) => [anchor.anchorKey, anchor]));
  const cityByKey = new Map(input.routeCities.map((item) => [item.city.municipalityKey, item.city]));
  const departureAnchor = anchorByKey.get(input.operation.departureAnchorKey);
  const arrivalAnchor = anchorByKey.get(input.operation.arrivalAnchorKey);
  const departure = cityByKey.get(input.operation.departureKey);
  const arrival = cityByKey.get(input.operation.arrivalKey);
  if (!departureAnchor || !arrivalAnchor || !departure || !arrival) throw new Error('Les entrées de la révision ne sont plus disponibles.');
  const arc = extractRouteArc(input.route.segments, departureAnchor, arrivalAnchor);
  const metrics = computeElevationMetrics(arc.sequences);
  const gpxText = serializeCatalogueGpx({
    departureName: departure.name,
    arrivalName: arrival.name,
    revisionKey: input.operation.revisionKey,
    sourceHash: input.operation.sourceHash,
    algorithmVersion: ALGORITHM_VERSION.catalogue,
    sequences: arc.sequences,
  });
  const displayText = JSON.stringify(buildDisplayGeometry({
    revisionKey: input.operation.revisionKey,
    algorithmVersion: ALGORITHM_VERSION.catalogue,
    sequences: arc.sequences,
    elevationAvailable: metrics.elevationAvailable,
  }));
  const gpx = new TextEncoder().encode(gpxText);
  const display = new TextEncoder().encode(displayText);
  if (
    sha256Hex(gpx) !== input.operation.generatedGpxSha256
    || gpx.byteLength !== input.operation.generatedGpxSize
    || sha256Hex(display) !== input.operation.displayGeometrySha256
    || display.byteLength !== input.operation.displayGeometrySize
  ) {
    throw new Error('Les artefacts régénérés divergent du dry-run exact.');
  }
  return { gpx, display };
}
