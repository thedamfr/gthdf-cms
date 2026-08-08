import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';

import {
  ALGORITHM_VERSION,
  hashCanonical,
  parseOfficialGpx,
  sha256Hex,
} from '../../src/domain/catalogue-core';
import {
  applyCataloguePlan,
  CatalogueOperationError,
  mapWithConcurrency,
  type CatalogueApplyAdapter,
  type CataloguePlan,
  type CatalogueRunRecord,
  type CatalogueRunStatus,
} from '../../src/domain/catalogue-job';
import {
  buildRouteCityKey,
  computeArtifactIntegrityHash,
} from '../../src/domain/catalogue-validation';
import type { BoundarySnapshot } from '../../src/domain/catalogue-boundaries';
import type { ControlledCatalogueDataset } from '../../src/domain/catalogue-dataset';
import {
  buildRouteCityFingerprint,
  buildRouteFingerprint,
  computeAnchorsInputHash,
  computeCalculationInputHash,
  computeCalculationSourceInputHash,
  computeImportInputHash,
  expectedCalculationUpsertResultHash,
  expectedReferenceRouteResultHash,
  hashExistingItineraryCas,
  hashExistingItineraryPostCas,
  hashAnchorTargetState,
  hashImportResultState,
  hashImportTargetState,
  hashExistingItineraryState,
  materializeCalculationArtifacts,
  planCatalogueAnchors,
  planCatalogueCalculation,
  planCatalogueImport,
  slugifyCatalogueCity,
  type AnchorOperation,
  type CalculationOperation,
  type CalculationUpsertOperation,
  type ExistingItineraryState,
  type ImportOperation,
  type RuntimeAnchor,
  type RuntimeCity,
  type RuntimeRoute,
  type RuntimeRouteCity,
  type RuntimeRouteSegment,
  type RuntimePrd03PrimaryAnchor,
} from '../../src/services/catalogue-planner';
import { CATALOGUE_SOURCE_LOCK_KEY, runAsCatalogueSystemMutation } from '../../src/index';

const CITY_UID = 'api::city.city';
const CHAPTER_UID = 'api::chapter.chapter';
const ROUTE_UID = 'api::reference-route.reference-route';
const ROUTE_CITY_UID = 'api::route-city.route-city';
const ANCHOR_UID = 'api::route-anchor.route-anchor';
const ITINERARY_UID = 'api::city-itinerary.city-itinerary';
const REVISION_UID = 'api::itinerary-revision.itinerary-revision';
const RUN_UID = 'api::catalogue-run.catalogue-run';
const GLOBAL_UID = 'api::global.global';

type AnyPlan = CataloguePlan<ImportOperation | AnchorOperation | CalculationOperation>;

type ChapterContract = {
  id: number;
  documentId: string;
  slug: string;
  title: string;
  sourceSha256: string;
  sourceMediaDocumentId: string;
  sourceMediaFingerprint: string;
  document: ReturnType<typeof parseOfficialGpx>;
  primaryAnchors: RuntimePrd03PrimaryAnchor[];
  junction: {
    status: 'proposed' | 'exact' | 'accepted_gap' | 'blocked' | 'stale';
    sourceSha256: string;
    nextSourceSha256: string;
    gapMetres: number;
    reviewNote?: string | null;
  };
};

type AdapterContext = {
  app: any;
  dataset: ControlledCatalogueDataset;
  boundarySnapshot: BoundarySnapshot;
  routeKey: string;
  codeVersion: string;
  report: AnyPlan;
};

type PreparedCalculation = {
  route: RuntimeRoute;
  routeCities: RuntimeRouteCity[];
  gpxMedia: any;
  displayMedia: any;
  createdObjectKeys: string[];
};

type EnsuredMedia = {
  media: any;
  created: boolean;
  objectKey: string;
};

export function buildRevisionReverificationData(
  operation: CalculationUpsertOperation,
  runId: number | string | undefined,
): Record<string, unknown> {
  return {
    lastVerifiedEvaluationHash: operation.evaluationHash,
    lastVerifiedRun: runId,
    calculationStatus: operation.calculationStatus,
    artifactIntegrityStatus: 'verified',
    artifactIntegrityHash: computeArtifactIntegrityHash({
      sourceHash: operation.sourceHash,
      generatedGpxSha256: operation.generatedGpxSha256,
      displayGeometrySha256: operation.displayGeometrySha256,
    }),
    calculationReport: {
      version: 1,
      qualityWarningCodes: operation.qualityWarningCodes,
      directDistanceMethod: operation.directDistanceMethod,
      differences: operation.differences,
      thresholdQaComparison: operation.thresholdQaComparison ?? null,
    },
    ...(operation.calculationStatus === 'ready' ? {
      warningApproved: false,
      warningApprovedAt: null,
      warningApprovedBy: null,
    } : {}),
  };
}

const { fetchOfficialMediaBytes } = require('../prepare-gpx-anchors.js') as {
  fetchOfficialMediaBytes(media: Record<string, unknown>): Promise<Uint8Array>;
};

function relationDocumentId(value: any): string | null {
  if (typeof value === 'string' && value) return value;
  if (!value || typeof value !== 'object') return null;
  if (typeof value.documentId === 'string') return value.documentId;
  if (Array.isArray(value)) return relationDocumentId(value[0]);
  if (value.connect) return relationDocumentId(value.connect);
  if (value.set) return relationDocumentId(value.set);
  return null;
}

function canonicalEquals(first: unknown, second: unknown): boolean {
  return hashCanonical(first) === hashCanonical(second);
}

function revisionMatchesOperationResult(revision: any, operation: CalculationUpsertOperation): boolean {
  if (!revision) return false;
  const expectedIntegrityHash = computeArtifactIntegrityHash({
    sourceHash: operation.sourceHash,
    generatedGpxSha256: operation.generatedGpxSha256,
    displayGeometrySha256: operation.displayGeometrySha256,
  });
  const generatedIdentity = mediaIdentityFingerprint(revision.generatedGpx);
  const displayIdentity = mediaIdentityFingerprint(revision.displayGeometry);
  const mediaRelationsMatch = Boolean(revision.generatedGpx && revision.displayGeometry)
    && (!operation.expectedGeneratedGpxMediaIdentity
      || generatedIdentity === operation.expectedGeneratedGpxMediaIdentity)
    && (!operation.expectedDisplayGeometryMediaIdentity
      || displayIdentity === operation.expectedDisplayGeometryMediaIdentity);
  const actualChapters = (revision.chaptersOnRoute ?? []).map((chapter: any) => ({
    chapterDocumentId: relationDocumentId(chapter.chapter),
    chapterSlug: chapter.chapter?.slug,
    routeOrder: Number(chapter.routeOrder),
    distanceMetres: Number(chapter.distanceMetres),
    direction: chapter.direction,
  })).sort((first: any, second: any) => first.routeOrder - second.routeOrder);
  const actualCities = (revision.citiesOnRoute ?? []).map((city: any) => ({
    municipalityKey: city.city?.municipalityKey,
    cityDocumentId: relationDocumentId(city.city),
    routeOrder: Number(city.routeOrder),
    occurrenceIndex: Number(city.occurrenceIndex),
    chainageFromDepartureMetres: Number(city.chainageFromDepartureMetres),
  })).sort((first: any, second: any) => first.routeOrder - second.routeOrder);
  const report = revision.calculationReport ?? {};
  return revision.revisionKey === operation.revisionKey
    && revision.itinerary?.businessKey === operation.businessKey
    && revision.departure?.municipalityKey === operation.departureKey
    && revision.arrival?.municipalityKey === operation.arrivalKey
    && revision.departureAnchor?.anchorKey === operation.departureAnchorKey
    && revision.arrivalAnchor?.anchorKey === operation.arrivalAnchorKey
    && Number(revision.distanceMetres) === operation.distanceMetres
    && Number(revision.asTheCrowFliesMetres) === operation.directMetres
    && (revision.elevationGainMetres === null ? null : Number(revision.elevationGainMetres)) === operation.elevationGainMetres
    && (revision.elevationLossMetres === null ? null : Number(revision.elevationLossMetres)) === operation.elevationLossMetres
    && revision.elevationAvailable === operation.elevationAvailable
    && revision.eligibleByRoute === operation.eligibleByRoute
    && revision.eligibleByDirect === operation.eligibleByDirect
    && (revision.detourRatio === null ? null : Number(revision.detourRatio)) === operation.detourRatio
    && revision.usesLoopOrigin === operation.usesLoopOrigin
    && canonicalEquals(revision.junctionWarnings ?? [], operation.junctionWarnings)
    && canonicalEquals(actualChapters, operation.chaptersOnRoute)
    && canonicalEquals(actualCities, operation.citiesOnRoute)
    && revision.generatedGpxSha256 === operation.generatedGpxSha256
    && revision.displayGeometrySha256 === operation.displayGeometrySha256
    && mediaRelationsMatch
    && revision.sourceHash === operation.sourceHash
    && revision.lastVerifiedEvaluationHash === operation.evaluationHash
    && revision.algorithmVersion === ALGORITHM_VERSION.catalogue
    && revision.calculationStatus === operation.calculationStatus
    && revision.artifactIntegrityStatus === 'verified'
    && revision.artifactIntegrityHash === expectedIntegrityHash
    && canonicalEquals(report.qualityWarningCodes ?? [], operation.qualityWarningCodes)
    && report.directDistanceMethod === operation.directDistanceMethod
    && canonicalEquals(report.differences ?? [], operation.differences)
    && canonicalEquals(report.thresholdQaComparison ?? null, operation.thresholdQaComparison ?? null)
    && (operation.calculationStatus !== 'ready' || (
      revision.warningApproved === false
      && revision.warningApprovedAt === null
      && revision.warningApprovedBy === null
    ));
}

function safeArtifactName(name: string, extension: '.gpx' | '.json'): void {
  if (
    basename(name) !== name
    || extname(name) !== extension
    || !/^[a-f0-9]{64}-[a-z0-9-]+\.(?:gpx|json)$/.test(name)
  ) throw new Error(`Nom d’artefact non sûr : ${name}.`);
}

function objectKeyFromUrl(url: string): string {
  if (!url || /[\0\r\n]/.test(url)) throw new Error('URL média invalide.');
  if (/^https?:\/\//i.test(url)) return new URL(url).pathname.replace(/^\/+/, '');
  return url.replace(/^\/+/, '');
}

async function listDocuments(app: any, uid: string, options: Record<string, unknown>): Promise<any[]> {
  const values: any[] = [];
  const pageSize = 100;
  for (let page = 1; ; page += 1) {
    const batch = await app.documents(uid).findMany({
      ...options,
      sort: options.sort ?? ['documentId:asc', 'id:asc'],
      pagination: { page, pageSize },
    });
    values.push(...batch);
    if (batch.length < pageSize) return values;
  }
}

async function findDocument(app: any, uid: string, options: Record<string, unknown>): Promise<any | null> {
  const values = await listDocuments(app, uid, { ...options, pagination: { page: 1, pageSize: 2 } });
  return values[0] ?? null;
}

function primaryAnchorsFromChapterEntity(entity: any): RuntimePrd03PrimaryAnchor[] {
  const anchors: RuntimePrd03PrimaryAnchor[] = [];
  for (const passage of entity?.cityPassages ?? []) {
    const anchor = passage?.gpxAnchorAB;
    if (!anchor || anchor.status !== 'validated') continue;
    const municipalityKey = passage.city?.municipalityKey;
    const sourceSha256 = String(anchor.sourceSha256 ?? '').toLowerCase();
    const numeric = {
      trackIndex: Number(anchor.trackIndex),
      segmentIndex: Number(anchor.segmentIndex),
      pointIndex: Number(anchor.pointIndex),
      fraction: Number(anchor.fraction),
      chapterChainageMetres: Number(anchor.chainageMetres),
      projectedLatitude: Number(anchor.projectedLatitude),
      projectedLongitude: Number(anchor.projectedLongitude),
      distanceToCityMetres: Number(anchor.distanceToCityMetres),
    };
    if (
      typeof municipalityKey !== 'string' || !municipalityKey
      || !/^[a-f0-9]{64}$/.test(sourceSha256)
      || ![numeric.trackIndex, numeric.segmentIndex, numeric.pointIndex].every(Number.isSafeInteger)
      || numeric.trackIndex < 0 || numeric.segmentIndex < 0 || numeric.pointIndex < 0
      || !Number.isFinite(numeric.fraction) || numeric.fraction < 0 || numeric.fraction > 1
      || ![
        numeric.chapterChainageMetres,
        numeric.projectedLatitude,
        numeric.projectedLongitude,
        numeric.distanceToCityMetres,
      ].every(Number.isFinite)
      || numeric.chapterChainageMetres < 0 || numeric.distanceToCityMetres < 0
      || typeof anchor.algorithmVersion !== 'string' || !anchor.algorithmVersion
    ) throw new Error(`Une ancre PRD03 AB validée de ${entity?.slug ?? entity?.documentId ?? 'chapitre'} est mal formée.`);
    anchors.push({
      municipalityKey,
      status: 'validated',
      sourceSha256,
      ...numeric,
      algorithmVersion: anchor.algorithmVersion,
    });
  }
  return anchors.sort((first, second) => (
    first.municipalityKey.localeCompare(second.municipalityKey)
    || first.chapterChainageMetres - second.chapterChainageMetres
  ));
}

async function loadChapterContract(app: any, dataset: ControlledCatalogueDataset): Promise<{
  chapters: ChapterContract[];
  chapterContractHash: string;
}> {
  const expectedSlugs = dataset.chapters.map((chapter) => chapter.slug);
  const entities = await listDocuments(app, CHAPTER_UID, {
    status: 'published',
    filters: { slug: { $in: expectedSlugs } },
    fields: ['documentId', 'slug', 'title'],
    populate: {
      gpxFileAB: { fields: ['url', 'documentId', 'name', 'mime', 'size', 'hash', 'updatedAt'] },
      gpxJunctionAfterAB: true,
      cityPassages: {
        populate: {
          city: { fields: ['documentId', 'municipalityKey'] },
          gpxAnchorAB: true,
        },
      },
    },
  });
  const bySlug = new Map(entities.map((entity) => [entity.slug, entity]));
  const chapters: ChapterContract[] = [];
  for (const expected of dataset.chapters) {
    const entity = bySlug.get(expected.slug);
    if (!entity?.gpxFileAB || !entity.gpxJunctionAfterAB) {
      throw new Error(`Le chapitre publié ${expected.slug} n’expose pas son GPX/jonction PRD03 AB.`);
    }
    const bytes = await fetchOfficialMediaBytes(entity.gpxFileAB);
    const actualSha = sha256Hex(bytes);
    const junction = entity.gpxJunctionAfterAB;
    if (
      actualSha !== expected.sourceSha256
      || junction.sourceSha256?.toLowerCase() !== actualSha
      || !/^[a-f0-9]{64}$/i.test(junction.nextSourceSha256 ?? '')
    ) throw new Error(`Le chapitre ${expected.slug} diverge du GPX/manifeste/PRD03 publié.`);
    chapters.push({
      id: entity.id,
      documentId: entity.documentId,
      slug: entity.slug,
      title: entity.title,
      sourceSha256: actualSha,
      sourceMediaDocumentId: entity.gpxFileAB.documentId,
      sourceMediaFingerprint: hashCanonical({
        documentId: entity.gpxFileAB.documentId,
        name: entity.gpxFileAB.name,
        mime: entity.gpxFileAB.mime,
        size: entity.gpxFileAB.size,
        hash: entity.gpxFileAB.hash,
        url: entity.gpxFileAB.url,
        updatedAt: entity.gpxFileAB.updatedAt,
      }),
      document: parseOfficialGpx(new TextDecoder().decode(bytes)),
      primaryAnchors: primaryAnchorsFromChapterEntity(entity),
      junction: {
        status: junction.status,
        sourceSha256: actualSha,
        nextSourceSha256: String(junction.nextSourceSha256).toLowerCase(),
        gapMetres: Number(junction.gapMetres),
        reviewNote: junction.reviewNote ?? null,
      },
    });
  }
  for (let index = 0; index < chapters.length; index += 1) {
    const next = chapters[(index + 1) % chapters.length];
    if (chapters[index].junction.nextSourceSha256 !== next.sourceSha256) {
      throw new Error(`La jonction PRD03 ${chapters[index].slug} ne pointe pas vers ${next.slug}.`);
    }
  }
  return {
    chapters,
    chapterContractHash: hashCanonical(chapters.map((chapter) => ({
      documentId: chapter.documentId,
      slug: chapter.slug,
      sourceSha256: chapter.sourceSha256,
      sourceMediaDocumentId: chapter.sourceMediaDocumentId,
      sourceMediaFingerprint: chapter.sourceMediaFingerprint,
      primaryAnchors: chapter.primaryAnchors,
      junction: chapter.junction,
    }))),
  };
}

async function loadChapterContractMetadata(app: any, dataset: ControlledCatalogueDataset): Promise<string> {
  const expectedSlugs = dataset.chapters.map((chapter) => chapter.slug);
  const entities = await listDocuments(app, CHAPTER_UID, {
    status: 'published',
    filters: { slug: { $in: expectedSlugs } },
    fields: ['documentId', 'slug'],
    populate: {
      gpxFileAB: { fields: ['documentId', 'name', 'mime', 'size', 'hash', 'url', 'updatedAt'] },
      gpxJunctionAfterAB: true,
      cityPassages: {
        populate: {
          city: { fields: ['documentId', 'municipalityKey'] },
          gpxAnchorAB: true,
        },
      },
    },
  });
  const bySlug = new Map(entities.map((entity) => [entity.slug, entity]));
  const metadata = dataset.chapters.map((expected) => {
    const entity = bySlug.get(expected.slug);
    const junction = entity?.gpxJunctionAfterAB;
    if (
      !entity || !entity.gpxFileAB?.documentId || !junction
      || String(junction.sourceSha256).toLowerCase() !== expected.sourceSha256
      || !/^[a-f0-9]{64}$/i.test(junction.nextSourceSha256 ?? '')
    ) throw new Error(`Le contrat DB publié du chapitre ${expected.slug} a changé.`);
    return {
      documentId: entity.documentId,
      slug: entity.slug,
      sourceSha256: expected.sourceSha256,
      sourceMediaDocumentId: entity.gpxFileAB.documentId,
      sourceMediaFingerprint: hashCanonical({
        documentId: entity.gpxFileAB.documentId,
        name: entity.gpxFileAB.name,
        mime: entity.gpxFileAB.mime,
        size: entity.gpxFileAB.size,
        hash: entity.gpxFileAB.hash,
        url: entity.gpxFileAB.url,
        updatedAt: entity.gpxFileAB.updatedAt,
      }),
      primaryAnchors: primaryAnchorsFromChapterEntity(entity),
      junction: {
        status: junction.status,
        sourceSha256: expected.sourceSha256,
        nextSourceSha256: String(junction.nextSourceSha256).toLowerCase(),
        gapMetres: Number(junction.gapMetres),
        reviewNote: junction.reviewNote ?? null,
      },
    };
  });
  return hashCanonical(metadata);
}

async function loadRouteEntity(app: any, routeKey: string, status: 'draft' | 'published'): Promise<any | null> {
  return findDocument(app, ROUTE_UID, {
    status,
    filters: { routeKey: { $eq: routeKey } },
    populate: {
      segments: {
        populate: {
          chapter: {
            fields: ['documentId', 'slug', 'title'],
            populate: {
              gpxFileAB: { fields: ['documentId', 'name', 'mime', 'size', 'hash', 'url', 'updatedAt'] },
              cityPassages: {
                populate: {
                  city: { fields: ['documentId', 'municipalityKey'] },
                  gpxAnchorAB: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

async function loadRuntimeRoute(
  app: any,
  routeKey: string,
  dataset: ControlledCatalogueDataset,
  status: 'draft' | 'published' = 'published',
  preparedContract?: Awaited<ReturnType<typeof loadChapterContract>>,
): Promise<RuntimeRoute> {
  const [entity, contract] = await Promise.all([
    loadRouteEntity(app, routeKey, status),
    preparedContract ?? loadChapterContract(app, dataset),
  ]);
  if (!entity) throw new Error(`ReferenceRoute ${routeKey} (${status}) est absent.`);
  if (!Array.isArray(entity.segments) || entity.segments.length !== 10) throw new Error('ReferenceRoute doit contenir dix segments.');
  const chapterByDocument = new Map(contract.chapters.map((chapter) => [chapter.documentId, chapter]));
  const segments: RuntimeRouteSegment[] = entity.segments.map((segment: any, index: number) => {
    const documentId = relationDocumentId(segment.chapter);
    const chapter = documentId ? chapterByDocument.get(documentId) : null;
    if (!chapter || segment.direction !== 'ab') throw new Error(`Segment ${index + 1} absent ou non AB.`);
    if (
      String(segment.sourceSha256).toLowerCase() !== chapter.sourceSha256
      || String(segment.nextSourceSha256).toLowerCase() !== chapter.junction.nextSourceSha256
      || segment.junctionAfterStatus !== chapter.junction.status
      || Number(segment.junctionAfterGapMetres) !== chapter.junction.gapMetres
      || (segment.junctionNote ?? null) !== (chapter.junction.reviewNote ?? null)
    ) throw new Error(`Segment ${index + 1} divergent de la décision PRD03 publiée.`);
    return {
      index,
      chapterKey: chapter.slug,
      chapterId: chapter.id,
      chapterDocumentId: chapter.documentId,
      chapterTitle: chapter.title,
      direction: 'ab',
      sourceSha256: chapter.sourceSha256,
      sourceMediaDocumentId: chapter.sourceMediaDocumentId,
      sourceMediaFingerprint: chapter.sourceMediaFingerprint,
      primaryAnchors: chapter.primaryAnchors,
      document: chapter.document,
      junctionAfter: {
        status: chapter.junction.status,
        gapMetres: chapter.junction.gapMetres,
        nextSourceSha256: chapter.junction.nextSourceSha256,
        reviewNote: chapter.junction.reviewNote,
      },
    };
  });
  return {
    id: entity.id,
    documentId: entity.documentId,
    routeKey: entity.routeKey,
    name: entity.name,
    slug: entity.slug,
    catalogueEnabled: entity.catalogueEnabled === true,
    sourceManifestHash: entity.sourceManifestHash,
    segments,
  };
}

async function loadRuntimeRouteMetadata(app: any, routeKey: string): Promise<RuntimeRoute> {
  const entity = await loadRouteEntity(app, routeKey, 'published');
  if (!entity || !Array.isArray(entity.segments) || entity.segments.length !== 10) {
    throw new Error(`ReferenceRoute publiée ${routeKey} absente ou incomplète.`);
  }
  return {
    id: entity.id,
    documentId: entity.documentId,
    routeKey: entity.routeKey,
    name: entity.name,
    slug: entity.slug,
    catalogueEnabled: entity.catalogueEnabled === true,
    sourceManifestHash: entity.sourceManifestHash,
    segments: entity.segments.map((segment: any, index: number) => ({
      index,
      chapterKey: segment.chapter?.slug,
      chapterId: segment.chapter?.id,
      chapterDocumentId: segment.chapter?.documentId,
      chapterTitle: segment.chapter?.title,
      direction: segment.direction,
      sourceSha256: String(segment.sourceSha256).toLowerCase(),
      sourceMediaDocumentId: segment.chapter?.gpxFileAB?.documentId,
      sourceMediaFingerprint: segment.chapter?.gpxFileAB ? hashCanonical({
        documentId: segment.chapter.gpxFileAB.documentId,
        name: segment.chapter.gpxFileAB.name,
        mime: segment.chapter.gpxFileAB.mime,
        size: segment.chapter.gpxFileAB.size,
        hash: segment.chapter.gpxFileAB.hash,
        url: segment.chapter.gpxFileAB.url,
        updatedAt: segment.chapter.gpxFileAB.updatedAt,
      }) : undefined,
      primaryAnchors: primaryAnchorsFromChapterEntity(segment.chapter),
      // La géométrie n’entre pas dans le fingerprint DB court; ses octets ont
      // déjà été relus hors transaction et toute nouvelle relation média passe
      // par le verrou catalogue du middleware.
      document: { tracks: [], pointCount: 0 },
      junctionAfter: {
        status: segment.junctionAfterStatus,
        gapMetres: Number(segment.junctionAfterGapMetres),
        nextSourceSha256: String(segment.nextSourceSha256).toLowerCase(),
        reviewNote: segment.junctionNote ?? null,
      },
    })),
  } as RuntimeRoute;
}

function cityFromEntity(entity: any): RuntimeCity {
  return {
    id: entity.id,
    documentId: entity.documentId,
    municipalityKey: entity.municipalityKey,
    name: entity.name,
    slug: entity.slug,
    countryCode: entity.countryCode,
    municipalityCode: entity.municipalityCode,
    administrativeArea: entity.administrativeArea,
    latitude: Number(entity.latitude),
    longitude: Number(entity.longitude),
    coordinateSource: entity.coordinateSource,
    hasPublicPage: entity.hasPublicPage === true,
  };
}

function anchorFromEntity(anchor: any, parentRouteCityKey?: string): RuntimeAnchor {
  return {
    id: anchor.id,
    documentId: anchor.documentId,
    anchorKey: anchor.anchorKey,
    anchorSemanticKey: anchor.anchorSemanticKey,
    occurrenceIndex: anchor.occurrenceIndex,
    routeSegmentIndex: anchor.sourceSegmentIndex,
    sourceSha256: String(anchor.sourceHash).toLowerCase(),
    trackIndex: anchor.trackIndex,
    segmentIndex: anchor.sourceTrackSegmentIndex,
    pointIndex: anchor.sourcePointIndex,
    fraction: Number(anchor.sourceFraction),
    chainageMetres: Number(anchor.chainageMetres),
    projectedLatitude: Number(anchor.projectedLatitude),
    projectedLongitude: Number(anchor.projectedLongitude),
    distanceToTraceMetres: Number(anchor.distanceToTraceMetres),
    status: anchor.validationStatus,
    chapterId: anchor.chapter?.id,
    chapterDocumentId: anchor.chapter?.documentId,
    algorithmVersion: anchor.algorithmVersion,
    sourceDirection: anchor.sourceDirection,
    origin: anchor.origin,
    routeCityKey: anchor.routeCity?.routeCityKey ?? parentRouteCityKey ?? null,
    ambiguityReasons: Array.isArray(anchor.calculationReport?.ambiguityReasons)
      ? anchor.calculationReport.ambiguityReasons
      : [],
  };
}

async function loadRouteCities(app: any, route: RuntimeRoute, publishedOnly = true): Promise<RuntimeRouteCity[]> {
  const entities = await listDocuments(app, ROUTE_CITY_UID, {
    filters: { route: { documentId: { $eq: route.documentId } } },
    populate: {
      route: { fields: ['documentId', 'routeKey'] },
      city: true,
      anchors: { populate: { chapter: { fields: ['documentId'] } } },
    },
  });
  const municipalityKeys = entities.map((entity) => entity.city?.municipalityKey).filter(Boolean);
  const publishedCities = publishedOnly && municipalityKeys.length ? await listDocuments(app, CITY_UID, {
    status: 'published',
    filters: { municipalityKey: { $in: municipalityKeys } },
  }) : [];
  const publishedCityByKey = new Map(publishedCities.map((city) => [city.municipalityKey, city]));
  return entities.map((entity) => {
    const municipalityKey = entity.city?.municipalityKey;
    const selectedCity = publishedOnly ? publishedCityByKey.get(municipalityKey) : entity.city;
    if (!selectedCity) throw new Error(`La City ${municipalityKey ?? 'inconnue'} doit être publiée avant calculate.`);
    const city = cityFromEntity(selectedCity);
    const anchors: RuntimeAnchor[] = (entity.anchors ?? []).map((anchor: any) => (
      anchorFromEntity(anchor, entity.routeCityKey)
    ));
    return {
      id: entity.id,
      documentId: entity.documentId,
      routeCityKey: entity.routeCityKey,
      qualificationStatus: entity.qualificationStatus,
      qualificationSourceHash: String(entity.qualificationSourceHash).toLowerCase(),
      qualificationEvidence: entity.qualificationEvidence ?? null,
      expectedOccurrences: entity.expectedOccurrences,
      routeKey: entity.route?.routeKey ?? null,
      reviewNote: entity.reviewNote ?? null,
      city,
      anchors,
    } as RuntimeRouteCity;
  }).sort((first, second) => first.routeCityKey.localeCompare(second.routeCityKey));
}

function mediaIdentityFingerprint(media: any): string | null {
  if (!media) return null;
  return hashCanonical({
    id: media.id ?? null,
    documentId: media.documentId ?? null,
    name: media.name ?? null,
    mime: media.mime ?? null,
    size: media.size ?? null,
    hash: media.hash ?? null,
    url: media.url ?? null,
    updatedAt: media.updatedAt ?? null,
  });
}

function requireMediaRelationId(media: any, label: string): number {
  if (!Number.isSafeInteger(media?.id) || media.id <= 0) {
    throw new Error(`Le média ${label} ne possède pas d’identifiant numérique Strapi.`);
  }
  return media.id;
}

async function verifyMediaBytes(media: any, expected: {
  name?: string;
  mime: string;
  sha256: string;
  size?: number;
}, cache?: Map<string, Promise<boolean>>): Promise<boolean> {
  if (!media || (expected.name !== undefined && media.name !== expected.name) || media.mime !== expected.mime) return false;
  const cacheKey = hashCanonical({
    mediaIdentity: mediaIdentityFingerprint(media),
    expected,
  });
  if (cache?.has(cacheKey)) return cache.get(cacheKey)!;
  const verification = (async () => {
  try {
    const bytes = await fetchOfficialMediaBytes(media);
    return (expected.size === undefined || bytes.byteLength === expected.size)
      && sha256Hex(bytes) === expected.sha256;
  } catch {
    return false;
  }
  })();
  if (cache) cache.set(cacheKey, verification);
  return verification;
}

async function loadExistingItineraries(
  app: any,
  routeDocumentId?: string,
  verifyArtifacts = true,
  businessKey?: string,
  verificationCache?: Map<string, Promise<boolean>>,
): Promise<ExistingItineraryState[]> {
  const filters: Record<string, unknown> = {};
  if (routeDocumentId) filters.route = { documentId: { $eq: routeDocumentId } };
  if (businessKey) filters.businessKey = { $eq: businessKey };
  const entities = await listDocuments(app, ITINERARY_UID, {
    status: 'draft',
    filters,
    fields: ['documentId', 'businessKey', 'slug', 'title', 'currentEvaluationHash', 'publicationNext'],
    populate: {
      cityA: { fields: ['municipalityKey'] },
      cityB: { fields: ['municipalityKey'] },
      activeRevision: {
        populate: {
          departure: { fields: ['municipalityKey'] },
          arrival: { fields: ['municipalityKey'] },
          generatedGpx: true,
          displayGeometry: true,
        },
      },
      revisions: { fields: ['documentId', 'revisionKey'] },
    },
  });
  return mapWithConcurrency(entities, 3, async (entity) => {
    const active = entity.activeRevision;
    const activeArtifactsVerified = active && verifyArtifacts ? (
      active.artifactIntegrityStatus === 'verified'
      && await verifyMediaBytes(active.generatedGpx, {
        name: active.generatedGpx?.name,
        mime: 'application/gpx+xml',
        sha256: active.generatedGpxSha256,
      }, verificationCache)
      && await verifyMediaBytes(active.displayGeometry, {
        name: active.displayGeometry?.name,
        mime: 'application/json',
        sha256: active.displayGeometrySha256,
      }, verificationCache)
    ) : false;
    return {
      documentId: entity.documentId,
      businessKey: entity.businessKey,
      slug: entity.slug,
      title: entity.title,
      cityAKey: entity.cityA?.municipalityKey ?? null,
      cityBKey: entity.cityB?.municipalityKey ?? null,
      currentEvaluationHash: entity.currentEvaluationHash ?? null,
      activeRevisionKey: active?.revisionKey ?? null,
      activeRevisionSourceHash: active?.sourceHash ?? null,
      activeDepartureKey: active?.departure?.municipalityKey ?? null,
      activeArrivalKey: active?.arrival?.municipalityKey ?? null,
      activeLastVerifiedEvaluationHash: active?.lastVerifiedEvaluationHash ?? null,
      activeArtifactsVerified,
      activeGeneratedGpxMediaIdentity: mediaIdentityFingerprint(active?.generatedGpx),
      activeDisplayGeometryMediaIdentity: mediaIdentityFingerprint(active?.displayGeometry),
      activeGeneratedGpxSha256: active?.generatedGpxSha256 ?? null,
      activeDisplayGeometrySha256: active?.displayGeometrySha256 ?? null,
      activeRevisionCalculationStatus: active?.calculationStatus ?? null,
      activeArtifactIntegrityStatus: active?.artifactIntegrityStatus ?? null,
      activeArtifactIntegrityHash: active?.artifactIntegrityHash ?? null,
      publicationNext: entity.publicationNext === true,
      revisionKeys: (entity.revisions ?? []).map((revision: any) => revision.revisionKey).sort(),
    };
  });
}

async function loadImportState(
  app: any,
  dataset: ControlledCatalogueDataset,
  routeKey: string,
  preparedContract?: Awaited<ReturnType<typeof loadChapterContract>>,
) {
  const contract = preparedContract ?? await loadChapterContract(app, dataset);
  const [routeEntity, cities] = await Promise.all([
    loadRouteEntity(app, routeKey, 'draft'),
    listDocuments(app, CITY_UID, { status: 'draft' }),
  ]);
  let route: RuntimeRoute | null = null;
  if (routeEntity) route = await loadRuntimeRoute(app, routeKey, dataset, 'draft', contract);
  const routeCities = route ? await loadRouteCities(app, route, false) : [];
  return {
    route,
    cities: cities.filter((city) => city.municipalityKey).map(cityFromEntity),
    routeCities,
    chapters: contract.chapters,
    chapterContractHash: contract.chapterContractHash,
  };
}

function hashSetupReferenceRouteResult(input: {
  entity: any | null;
  contract: Awaited<ReturnType<typeof loadChapterContract>>;
  dataset: ControlledCatalogueDataset;
  routeKey: string;
}): string {
  const { entity, contract, dataset, routeKey } = input;
  const segments = Array.isArray(entity?.segments) ? entity.segments : [];
  const exactSegments = segments.length === contract.chapters.length
    && segments.every((segment: any, index: number) => {
      const chapter = contract.chapters[index];
      return relationDocumentId(segment.chapter) === chapter.documentId
        && segment.direction === 'ab'
        && String(segment.sourceSha256).toLowerCase() === chapter.sourceSha256
        && String(segment.nextSourceSha256).toLowerCase() === chapter.junction.nextSourceSha256
        && segment.junctionAfterStatus === chapter.junction.status
        && Number(segment.junctionAfterGapMetres) === chapter.junction.gapMetres
        && (segment.junctionNote ?? null) === (chapter.junction.reviewNote ?? null);
    });
  const exact = entity
    && entity.name === 'Grand Tour des Hauts-de-France'
    && entity.routeKey === routeKey
    && entity.slug === routeKey
    && entity.isLoop === true
    && entity.catalogueEnabled === false
    && entity.algorithmVersion === ALGORITHM_VERSION.catalogue
    && entity.sourceManifestHash === dataset.datasetHash
    && entity.notes === 'Import PRD04 en brouillon. Vérifier puis publier sans activer le catalogue.'
    && exactSegments;
  if (exact) return expectedReferenceRouteResultHash({
    routeKey,
    datasetHash: dataset.datasetHash,
    chapterContractHash: contract.chapterContractHash,
  });
  return hashCanonical(entity ? {
    name: entity.name,
    routeKey: entity.routeKey,
    slug: entity.slug,
    isLoop: entity.isLoop,
    catalogueEnabled: entity.catalogueEnabled,
    algorithmVersion: entity.algorithmVersion,
    sourceManifestHash: entity.sourceManifestHash,
    notes: entity.notes ?? null,
    segments: segments.map((segment: any) => ({
      chapterDocumentId: relationDocumentId(segment.chapter),
      direction: segment.direction,
      sourceSha256: segment.sourceSha256,
      nextSourceSha256: segment.nextSourceSha256,
      junctionAfterStatus: segment.junctionAfterStatus,
      junctionAfterGapMetres: segment.junctionAfterGapMetres,
      junctionNote: segment.junctionNote ?? null,
    })),
  } : null);
}

async function ensureImmutableMedia(app: any, input: {
  bytes: Uint8Array;
  name: string;
  mime: 'application/gpx+xml' | 'application/json';
  sha256: string;
  extension: '.gpx' | '.json';
}, verificationCache?: Map<string, Promise<boolean>>): Promise<EnsuredMedia> {
  safeArtifactName(input.name, input.extension);
  if (sha256Hex(input.bytes) !== input.sha256) throw new Error(`SHA-256 préparé invalide pour ${input.name}.`);
  const uploadQuery = app.db.query('plugin::upload.file');
  const businessFingerprint = `PRD04 ${input.sha256}`;
  const byBusinessSha = await uploadQuery.findMany({
    where: { caption: businessFingerprint },
    orderBy: { id: 'asc' },
  });
  const legacyByName = await uploadQuery.findOne({ where: { name: input.name } });
  const candidates = [...(Array.isArray(byBusinessSha) ? byBusinessSha : []), legacyByName]
    .filter((media, index, values) => media && values.findIndex((candidate) => (
      candidate?.id === media.id && candidate?.documentId === media.documentId
    )) === index);
  for (const existing of candidates) {
    if (await verifyMediaBytes(existing, {
      mime: input.mime,
      sha256: input.sha256,
      size: input.bytes.byteLength,
    }, verificationCache)) return {
      media: existing,
      created: false,
      objectKey: objectKeyFromUrl(existing.url),
    };
  }
  if (candidates.length > 0) {
    throw new Error(`Un média portant l’empreinte métier ${input.sha256} existe avec des octets incompatibles.`);
  }
  const directory = await mkdtemp(join(tmpdir(), 'gthdf-catalogue-artifact-'));
  const filepath = join(directory, input.name);
  try {
    await writeFile(filepath, input.bytes, { flag: 'wx' });
    const uploaded = await app.plugin('upload').service('upload').upload({
      files: {
        filepath,
        originalFileName: input.name,
        size: input.bytes.byteLength,
        mimetype: input.mime,
      },
      data: { fileInfo: { name: input.name, caption: `PRD04 ${input.sha256}` } },
    });
    const media = Array.isArray(uploaded) ? uploaded[0] : uploaded;
    const objectKey = objectKeyFromUrl(media?.url);
    if (!await verifyMediaBytes(media, {
      name: input.name,
      mime: input.mime,
      sha256: input.sha256,
      size: input.bytes.byteLength,
    }, verificationCache)) throw new CatalogueOperationError(
      `La relecture binaire après upload de ${input.name} a échoué.`,
      { orphanObjectKeys: [objectKey] },
    );
    return { media, created: true, objectKey };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class CatalogueStrapiAdapter implements CatalogueApplyAdapter<any> {
  private runEntity: any | null = null;
  private calculationSnapshotPromise: Promise<{ route: RuntimeRoute; routeCities: RuntimeRouteCity[] }> | null = null;
  private anchorsSnapshotPromise: Promise<{ route: RuntimeRoute; routeCities: RuntimeRouteCity[] }> | null = null;
  private importStatePromise: ReturnType<typeof loadImportState> | null = null;
  private chapterContractPromise: ReturnType<typeof loadChapterContract> | null = null;
  private readonly artifactVerificationCache = new Map<string, Promise<boolean>>();
  private sourceBytesValidated = false;

  constructor(private readonly context: AdapterContext) {}

  private chapterContract(): ReturnType<typeof loadChapterContract> {
    if (!this.chapterContractPromise) {
      this.chapterContractPromise = loadChapterContract(this.context.app, this.context.dataset);
    }
    return this.chapterContractPromise;
  }

  private calculationSnapshot(): Promise<{ route: RuntimeRoute; routeCities: RuntimeRouteCity[] }> {
    if (!this.calculationSnapshotPromise) {
      this.calculationSnapshotPromise = (async () => {
        const route = await loadRuntimeRoute(
          this.context.app,
          this.context.routeKey,
          this.context.dataset,
          'published',
        );
        return { route, routeCities: await loadRouteCities(this.context.app, route, true) };
      })();
    }
    return this.calculationSnapshotPromise;
  }

  private anchorsSnapshot(): Promise<{ route: RuntimeRoute; routeCities: RuntimeRouteCity[] }> {
    if (!this.anchorsSnapshotPromise) {
      this.anchorsSnapshotPromise = (async () => {
        const route = await loadRuntimeRoute(
          this.context.app,
          this.context.routeKey,
          this.context.dataset,
          'published',
        );
        return { route, routeCities: await loadRouteCities(this.context.app, route, false) };
      })();
    }
    return this.anchorsSnapshotPromise;
  }

  private importState(): ReturnType<typeof loadImportState> {
    if (!this.importStatePromise) {
      this.importStatePromise = this.chapterContract().then((contract) => loadImportState(
        this.context.app,
        this.context.dataset,
        this.context.routeKey,
        contract,
      ));
    }
    return this.importStatePromise;
  }

  async readCurrentInputHash(): Promise<string> {
    const { app, dataset, boundarySnapshot, report } = this.context;
    if (report.mode === 'import') {
      return computeImportInputHash(dataset, await this.importState());
    }
    if (report.mode === 'anchors') {
      const { route, routeCities } = await this.anchorsSnapshot();
      return computeAnchorsInputHash({
        route,
        routeCities,
        datasetHash: dataset.datasetHash,
        boundaryManifestHash: boundarySnapshot.manifestHash,
      });
    }
    const { route, routeCities } = await this.calculationSnapshot();
    return computeCalculationInputHash(
      route,
      routeCities,
      await loadExistingItineraries(
        app,
        route.documentId,
        true,
        undefined,
        this.artifactVerificationCache,
      ),
      dataset.datasetHash,
    );
  }

  async readCurrentSourceInputHash(): Promise<string> {
    const { app, dataset, boundarySnapshot, routeKey, report } = this.context;
    if (report.mode === 'import') {
      const contract = await this.chapterContract();
      const hash = hashCanonical({
        version: 1,
        routeKey,
        datasetHash: dataset.datasetHash,
        chapterContractHash: contract.chapterContractHash,
      });
      this.sourceBytesValidated = true;
      return hash;
    }
    const snapshot = report.mode === 'calculate'
      ? await this.calculationSnapshot()
      : await this.anchorsSnapshot();
    const { route, routeCities } = await snapshot;
    if (report.mode === 'anchors') {
      this.sourceBytesValidated = true;
      return hashCanonical({
      version: 1,
      routeFingerprint: buildRouteFingerprint(route),
      datasetHash: dataset.datasetHash,
      boundaryManifestHash: boundarySnapshot.manifestHash,
      routeCities: routeCities.map((item) => ({
        routeCityKey: item.routeCityKey,
        qualificationStatus: item.qualificationStatus,
        qualificationSourceHash: item.qualificationSourceHash,
        expectedOccurrences: item.expectedOccurrences,
        municipalityKey: item.city.municipalityKey,
        latitude: item.city.latitude,
        longitude: item.city.longitude,
      })).sort((first, second) => first.routeCityKey.localeCompare(second.routeCityKey)),
      });
    }
    this.sourceBytesValidated = true;
    return computeCalculationSourceInputHash(route, routeCities, dataset.datasetHash);
  }

  async verifyRunState(input: { report: AnyPlan; run: CatalogueRunRecord }): Promise<void> {
    if (!this.sourceBytesValidated) {
      throw new Error('La relecture complète des GPX source doit précéder toute reprise catalogue.');
    }
    await mapWithConcurrency(input.report.operations, 3, async (candidate, operationIndex) => {
      const operationWasCheckpointed = input.run.status === 'succeeded' || operationIndex < input.run.cursor;
      if (candidate.kind === 'setup_reference_route' || candidate.kind === 'upsert_city_route_city') {
        if (!operationWasCheckpointed) return;
        const contract = candidate.kind === 'setup_reference_route' ? await this.chapterContract() : null;
        const target = await this.importTargetState(candidate, contract);
        if (target.resultHash !== candidate.expectedResultHash) {
          throw new Error(`Le post-état import ${candidate.key} a dérivé depuis son checkpoint.`);
        }
        return;
      }
      if (candidate.kind === 'upsert_anchor') {
        if (!operationWasCheckpointed) return;
        const target = await this.anchorTargetState(candidate);
        if (target.resultHash !== candidate.expectedResultHash) {
          throw new Error(`Le post-état de l’ancre ${candidate.anchorKey} a dérivé depuis son checkpoint.`);
        }
        return;
      }
      if (candidate.kind === 'archive_itinerary') {
        if (!operationWasCheckpointed) return;
        const current = (await loadExistingItineraries(
          this.context.app,
          undefined,
          true,
          candidate.businessKey,
          this.artifactVerificationCache,
        ))[0];
        if (current?.activeRevisionKey && !current.activeArtifactsVerified) {
          throw new Error(`Les octets archivés de ${candidate.businessKey} ne sont plus vérifiables.`);
        }
        if (hashExistingItineraryCas(current) !== candidate.expectedItineraryResultHash) {
          throw new Error(`Le post-état archivé de ${candidate.businessKey} a dérivé depuis son checkpoint.`);
        }
        return;
      }
      if (candidate.kind !== 'upsert_itinerary_revision') return;
      const mustExist = operationWasCheckpointed
        || candidate.action === 'unchanged'
        || candidate.action === 'reverified_unchanged';
      await this.verifyExistingRevisionArtifacts(candidate, mustExist);
      if (
        operationWasCheckpointed
        && await this.calculationUpsertResultHash(candidate) !== candidate.expectedItineraryResultHash
      ) throw new Error(`Le post-état calculé de ${candidate.businessKey} a dérivé depuis son checkpoint.`);
    });
  }

  async acquireLock(input: { lockKey: string; runKey: string; ownerKey: string; acquiredAt: string; expiresAt: string }): Promise<boolean> {
    const result = await this.context.app.db.connection.raw(`
      INSERT INTO catalogue_apply_locks (lock_key, run_key, owner_key, acquired_at, expires_at, heartbeat_at)
      VALUES (?, ?, ?, ?::timestamptz, ?::timestamptz, ?::timestamptz)
      ON CONFLICT (lock_key) DO UPDATE SET
        run_key = EXCLUDED.run_key,
        owner_key = EXCLUDED.owner_key,
        acquired_at = EXCLUDED.acquired_at,
        expires_at = EXCLUDED.expires_at,
        heartbeat_at = EXCLUDED.heartbeat_at
      WHERE catalogue_apply_locks.expires_at < now()
      RETURNING lock_key
    `, [input.lockKey, input.runKey, input.ownerKey, input.acquiredAt, input.expiresAt, input.acquiredAt]);
    return (result?.rows ?? result?.[0] ?? []).length === 1;
  }

  async heartbeatLock(input: { lockKey: string; runKey: string; ownerKey: string; heartbeatAt: string; expiresAt: string }): Promise<void> {
    const result = await this.context.app.db.connection.raw(`
      UPDATE catalogue_apply_locks
      SET heartbeat_at = ?::timestamptz, expires_at = ?::timestamptz
      WHERE lock_key = ? AND run_key = ? AND owner_key = ? AND expires_at >= now()
      RETURNING lock_key
    `, [input.heartbeatAt, input.expiresAt, input.lockKey, input.runKey, input.ownerKey]);
    if ((result?.rows ?? result?.[0] ?? []).length !== 1) throw new Error('Le verrou catalogue a expiré ou changé de propriétaire.');
  }

  async releaseLock(input: { lockKey: string; runKey: string; ownerKey: string }): Promise<void> {
    await this.context.app.db.connection.raw(
      'DELETE FROM catalogue_apply_locks WHERE lock_key = ? AND run_key = ? AND owner_key = ?',
      [input.lockKey, input.runKey, input.ownerKey],
    );
  }

  async beginOrResumeRun(input: {
    runKey: string;
    report: AnyPlan;
    operator: string;
    startedAt: string;
    heartbeatAt: string;
    lockExpiresAt: string;
  }): Promise<CatalogueRunRecord> {
    let entity = await this.context.app.db.query(RUN_UID).findOne({ where: { runKey: input.runKey } });
    const fresh = !entity;
    if (entity) {
      if (entity.reportHash !== input.report.reportHash || entity.inputHash !== input.report.inputHash) {
        throw new Error('Le run existant ne correspond pas exactement au rapport demandé.');
      }
    } else {
      entity = await this.context.app.db.query(RUN_UID).create({ data: {
        runKey: input.runKey,
        mode: input.report.mode === 'calculate' ? 'apply' : input.report.mode,
        scope: input.report.scope,
        operator: input.operator,
        startedAt: input.startedAt,
        heartbeatAt: input.heartbeatAt,
        lockExpiresAt: input.lockExpiresAt,
        codeVersion: input.report.codeVersion,
        inputHash: input.report.inputHash,
        reportHash: input.report.reportHash,
        status: 'running',
        cursor: '0',
        counters: {},
        report: input.report,
      } });
    }
    this.runEntity = entity;
    return {
      runKey: entity.runKey,
      status: entity.status,
      cursor: Number(entity.cursor ?? 0),
      counters: entity.counters ?? {},
      fresh,
    };
  }

  async checkpointRun(input: {
    lockKey: string;
    runKey: string;
    ownerKey: string;
    status: CatalogueRunStatus;
    cursor: number;
    counters: Record<string, number>;
    heartbeatAt: string;
    lockExpiresAt?: string | null;
    completedAt?: string | null;
    errorSummary?: Record<string, unknown> | null;
  }): Promise<void> {
    if (!this.runEntity) throw new Error('CatalogueRun n’est pas initialisé.');
    const runEntityId = this.runEntity.id;
    const updated = await this.context.app.db.transaction(async ({ trx }: { trx: any }) => {
      const fence = await trx.raw(`
        SELECT lock_key
        FROM catalogue_apply_locks
        WHERE lock_key = ? AND run_key = ? AND owner_key = ? AND expires_at >= now()
        FOR UPDATE
      `, [input.lockKey, input.runKey, input.ownerKey]);
      if ((fence?.rows ?? fence?.[0] ?? []).length !== 1) {
        throw new Error('Le checkpoint catalogue est refusé : le lease a expiré ou changé de propriétaire.');
      }
      return this.context.app.db.query(RUN_UID).update({
        where: { id: runEntityId },
        data: {
          status: input.status,
          cursor: String(input.cursor),
          counters: input.counters,
          heartbeatAt: input.heartbeatAt,
          lockExpiresAt: input.lockExpiresAt,
          completedAt: input.completedAt,
          errorSummary: input.errorSummary,
        },
      });
    });
    this.runEntity = updated;
  }

  private async currentSourceInputHash(): Promise<string> {
    if (!this.sourceBytesValidated) {
      throw new Error('Les GPX source n’ont pas encore été relus pour cette invocation.');
    }
    const { app, dataset, boundarySnapshot, routeKey, report } = this.context;
    let actual: string;
    if (report.mode === 'import') {
      actual = hashCanonical({
        version: 1,
        routeKey,
        datasetHash: dataset.datasetHash,
        chapterContractHash: await loadChapterContractMetadata(app, dataset),
      });
    } else {
      const route = await loadRuntimeRouteMetadata(app, routeKey);
      const routeCities = await loadRouteCities(app, route, report.mode !== 'anchors');
      if (report.mode === 'anchors') {
        actual = hashCanonical({
          version: 1,
          routeFingerprint: buildRouteFingerprint(route),
          datasetHash: dataset.datasetHash,
          boundaryManifestHash: boundarySnapshot.manifestHash,
          routeCities: routeCities.map((item) => ({
            routeCityKey: item.routeCityKey,
            qualificationStatus: item.qualificationStatus,
            qualificationSourceHash: item.qualificationSourceHash,
            expectedOccurrences: item.expectedOccurrences,
            municipalityKey: item.city.municipalityKey,
            latitude: item.city.latitude,
            longitude: item.city.longitude,
          })).sort((first, second) => first.routeCityKey.localeCompare(second.routeCityKey)),
        });
      } else actual = computeCalculationSourceInputHash(route, routeCities, dataset.datasetHash);
    }
    return actual;
  }

  private async assertSourceUnchangedLightweight(): Promise<void> {
    if (await this.currentSourceInputHash() !== this.context.report.scope.sourceInputHash) {
      throw new Error('Une source catalogue a changé depuis le dry-run exact.');
    }
  }

  private async importTargetState(
    operation: ImportOperation,
    preparedContract?: Awaited<ReturnType<typeof loadChapterContract>> | null,
  ): Promise<{
    hash: string;
    resultHash: string;
  }> {
    const { app, dataset, routeKey } = this.context;
    if (operation.kind === 'setup_reference_route') {
      const route = await loadRouteEntity(app, routeKey, 'draft');
      const contract = preparedContract ?? await this.chapterContract();
      return {
        hash: hashCanonical(route ? { documentId: route.documentId, routeKey: route.routeKey } : null),
        resultHash: hashSetupReferenceRouteResult({ entity: route, contract, dataset, routeKey }),
      };
    }
    const source = dataset.cities.find((item) => item.municipalityKey === operation.municipalityKey);
    if (!source) throw new Error(`Source ${operation.municipalityKey} absente.`);
    const cityEntity = await findDocument(app, CITY_UID, {
      status: 'draft', filters: { municipalityKey: { $eq: source.municipalityKey } },
    });
    const routeCityEntity = await app.db.query(ROUTE_CITY_UID).findOne({
      where: { routeCityKey: buildRouteCityKey(routeKey, source.municipalityKey) },
      populate: { city: true, route: true },
    });
    const city = cityEntity ? cityFromEntity(cityEntity) : null;
    const routeCity = routeCityEntity ? {
      id: routeCityEntity.id,
      documentId: routeCityEntity.documentId,
      routeCityKey: routeCityEntity.routeCityKey,
      qualificationStatus: routeCityEntity.qualificationStatus,
      qualificationSourceHash: routeCityEntity.qualificationSourceHash,
      qualificationEvidence: routeCityEntity.qualificationEvidence ?? null,
      expectedOccurrences: routeCityEntity.expectedOccurrences,
      routeKey: routeCityEntity.route?.routeKey ?? null,
      reviewNote: routeCityEntity.reviewNote ?? null,
      city: routeCityEntity.city ? cityFromEntity(routeCityEntity.city) : city,
      anchors: [],
    } as RuntimeRouteCity : null;
    return {
      hash: hashImportTargetState(city, routeCity),
      resultHash: hashImportResultState(city, routeCity),
    };
  }

  private async anchorTargetState(operation: AnchorOperation): Promise<{
    hash: string;
    resultHash: string;
  }> {
    const entity = await this.context.app.db.query(ANCHOR_UID).findOne({
      where: { anchorKey: operation.anchorKey },
      populate: { chapter: true, routeCity: true },
    });
    const anchor = entity ? anchorFromEntity(entity) : null;
    const hash = hashAnchorTargetState(anchor);
    return { hash, resultHash: hash };
  }

  private async calculationUpsertResultHash(operation: CalculationUpsertOperation): Promise<string> {
    const [current, revision] = await Promise.all([
      loadExistingItineraries(
        this.context.app,
        undefined,
        false,
        operation.businessKey,
      ).then((values) => values[0]),
      this.context.app.db.query(REVISION_UID).findOne({
        where: { revisionKey: operation.revisionKey },
        populate: {
          itinerary: { select: ['businessKey'] },
          departure: { select: ['municipalityKey'] },
          arrival: { select: ['municipalityKey'] },
          departureAnchor: { select: ['anchorKey'] },
          arrivalAnchor: { select: ['anchorKey'] },
          generatedGpx: true,
          displayGeometry: true,
          chaptersOnRoute: { populate: { chapter: { select: ['documentId', 'slug'] } } },
          citiesOnRoute: { populate: { city: { select: ['documentId', 'municipalityKey'] } } },
        },
      }),
    ]);
    const itineraryPostCasHash = hashExistingItineraryPostCas(current);
    if (
      itineraryPostCasHash === operation.expectedItineraryPostCasHash
      && revisionMatchesOperationResult(revision, operation)
      && expectedCalculationUpsertResultHash(operation) === operation.expectedItineraryResultHash
    ) return operation.expectedItineraryResultHash;
    return hashCanonical({
      exact: false,
      itineraryPostCasHash,
      revisionKey: revision?.revisionKey ?? null,
      revisionUpdatedAt: revision?.updatedAt ?? null,
      generatedGpxMediaIdentity: mediaIdentityFingerprint(revision?.generatedGpx),
      displayGeometryMediaIdentity: mediaIdentityFingerprint(revision?.displayGeometry),
    });
  }

  private async applyImport(
    operation: ImportOperation,
    preparedContract: Awaited<ReturnType<typeof loadChapterContract>> | null,
  ): Promise<'created' | 'reused' | 'skipped'> {
    const { app, dataset, routeKey } = this.context;
    if (operation.action === 'conflict') return 'skipped';
    if (operation.kind === 'setup_reference_route') {
      const existing = await loadRouteEntity(app, routeKey, 'draft');
      if (existing) return 'reused';
      if (!preparedContract) throw new Error('Le contrat chapitre préparé est absent.');
      const contract = preparedContract;
      await app.documents(ROUTE_UID).create({ status: 'draft', data: {
        name: 'Grand Tour des Hauts-de-France',
        routeKey,
        slug: routeKey,
        isLoop: true,
        catalogueEnabled: false,
        algorithmVersion: ALGORITHM_VERSION.catalogue,
        sourceManifestHash: dataset.datasetHash,
        segments: contract.chapters.map((chapter) => ({
          chapter: chapter.documentId,
          direction: 'ab',
          sourceSha256: chapter.sourceSha256,
          nextSourceSha256: chapter.junction.nextSourceSha256,
          junctionAfterStatus: chapter.junction.status,
          junctionAfterGapMetres: chapter.junction.gapMetres,
          junctionNote: chapter.junction.reviewNote,
        })),
        notes: 'Import PRD04 en brouillon. Vérifier puis publier sans activer le catalogue.',
      } });
      return 'created';
    }
    const source = dataset.cities.find((city) => city.municipalityKey === operation.municipalityKey);
    if (!source) throw new Error(`Source ville ${operation.municipalityKey} absente.`);
    let city = await findDocument(app, CITY_UID, {
      status: 'draft',
      filters: { municipalityKey: { $eq: source.municipalityKey } },
    });
    let created = false;
    if (!city) {
      city = await app.documents(CITY_UID).create({ status: 'draft', data: {
        name: source.name,
        slug: slugifyCatalogueCity(source.name),
        municipalityKey: source.municipalityKey,
        countryCode: source.countryCode,
        municipalityCode: source.municipalityCode,
        administrativeArea: source.administrativeArea,
        latitude: source.latitude,
        longitude: source.longitude,
        coordinateSource: source.coordinateSource,
        hasPublicPage: false,
      } });
      created = true;
    } else if (operation.action === 'enrich') {
      const additions: Record<string, unknown> = {};
      for (const [field, value] of Object.entries({
        countryCode: source.countryCode,
        municipalityCode: source.municipalityCode,
        administrativeArea: source.administrativeArea,
        latitude: source.latitude,
        longitude: source.longitude,
        coordinateSource: source.coordinateSource,
      })) if (city[field] === null || city[field] === undefined || city[field] === '') additions[field] = value;
      if (Object.keys(additions).length) city = await app.documents(CITY_UID).update({
        documentId: city.documentId,
        status: 'draft',
        data: additions,
      });
    }
    const route = await loadRouteEntity(app, routeKey, 'draft');
    if (!route) throw new Error('ReferenceRoute brouillon absent après setup_reference_route.');
    const routeCityKey = buildRouteCityKey(routeKey, source.municipalityKey);
    const routeCity = await this.context.app.db.query(ROUTE_CITY_UID).findOne({ where: { routeCityKey } });
    if (!routeCity) {
      await app.documents(ROUTE_CITY_UID).create({ data: {
        routeCityKey,
        route: route.documentId,
        city: city.documentId,
        qualificationStatus: 'proposed',
        qualificationSourceHash: dataset.datasetHash,
        expectedOccurrences: source.expectedOccurrences,
        qualificationEvidence: source.qualificationEvidence,
        reviewNote: 'Proposition importée du lot PRD04; validation humaine requise.',
      } });
      return 'created';
    }
    return created ? 'created' : 'reused';
  }

  private async applyAnchor(operation: AnchorOperation): Promise<'created' | 'reused' | 'skipped'> {
    if (operation.action === 'conflict') return 'skipped';
    const existing = await this.context.app.db.query(ANCHOR_UID).findOne({ where: { anchorKey: operation.anchorKey } });
    if (existing) return 'reused';
    const routeCity = await this.context.app.db.query(ROUTE_CITY_UID).findOne({ where: { routeCityKey: operation.routeCityKey } });
    const chapter = await findDocument(this.context.app, CHAPTER_UID, {
      status: 'published', filters: { documentId: { $eq: operation.chapterDocumentId } },
    });
    if (!routeCity || !chapter) throw new Error(`Relations absentes pour ${operation.anchorKey}.`);
    await this.context.app.documents(ANCHOR_UID).create({ data: {
      anchorKey: operation.anchorKey,
      anchorSemanticKey: operation.anchorSemanticKey,
      routeCity: routeCity.documentId,
      occurrenceIndex: operation.occurrenceIndex,
      chapter: chapter.documentId,
      sourceSegmentIndex: operation.sourceSegmentIndex,
      trackIndex: operation.trackIndex,
      sourceTrackSegmentIndex: operation.segmentIndex,
      sourcePointIndex: operation.pointIndex,
      sourceFraction: operation.fraction,
      chainageMetres: operation.chainageMetres,
      projectedLatitude: operation.projectedLatitude,
      projectedLongitude: operation.projectedLongitude,
      distanceToTraceMetres: operation.distanceToTraceMetres,
      sourceHash: operation.sourceHash,
      algorithmVersion: ALGORITHM_VERSION.projection,
      validationStatus: operation.validationStatus,
      origin: operation.origin,
      sourceDirection: 'ab',
      calculationReport: { version: 1, ambiguityReasons: operation.ambiguityReasons },
    } });
    return 'created';
  }

  private async applyArchive(operation: Extract<CalculationOperation, { kind: 'archive_itinerary' }>): Promise<'reused' | 'skipped'> {
    const itinerary = await findDocument(this.context.app, ITINERARY_UID, {
      status: 'draft',
      filters: { documentId: { $eq: operation.itineraryDocumentId } },
      populate: { activeRevision: true, revisions: { fields: ['revisionKey'] } },
    });
    if (!itinerary) return 'skipped';
    if (operation.activeRevisionKey && itinerary.activeRevision?.revisionKey === operation.activeRevisionKey) {
      await this.context.app.documents(REVISION_UID).update({
        documentId: itinerary.activeRevision.documentId,
        data: { calculationStatus: 'archived' },
      });
    }
    // Draft & Publish peut faire pointer le brouillon et la version publiée
    // vers deux révisions différentes. L’archive doit donc fermer l’empreinte
    // système sur toutes les lignes du document, pas seulement sur le draft
    // chargé par le planner.
    await this.context.app.db.query(ITINERARY_UID).updateMany({
      where: { documentId: itinerary.documentId },
      data: { currentEvaluationHash: null },
    });
    await this.context.app.documents(ITINERARY_UID).update({
      documentId: itinerary.documentId,
      status: 'draft',
      data: { publicationNext: false, currentEvaluationHash: null },
    });
    return 'reused';
  }

  private async writeCalculationFingerprints(
    operation: CalculationUpsertOperation,
    itinerary: any,
    restorePublishedVersion: boolean,
  ): Promise<void> {
    const { app, dataset, routeKey } = this.context;
    const route = await loadRuntimeRouteMetadata(app, routeKey);
    const routeCities = await loadRouteCities(app, route, true);
    await app.db.query(ROUTE_UID).updateMany({
      where: { documentId: route.documentId },
      data: { currentInputFingerprint: buildRouteFingerprint(route) },
    });
    for (const routeCity of routeCities.filter((item) => (
      [operation.cityAKey, operation.cityBKey].includes(item.city.municipalityKey)
    ))) {
      await app.db.query(ROUTE_CITY_UID).update({
        where: { id: routeCity.id },
        data: { currentInputFingerprint: buildRouteCityFingerprint(routeCity) },
      });
    }
    await app.db.query(ITINERARY_UID).update({
      where: { id: itinerary.id },
      data: { currentEvaluationHash: operation.evaluationHash },
    });
    if (!restorePublishedVersion) return;
    const published = await app.db.query(ITINERARY_UID).findOne({
      where: { documentId: itinerary.documentId, publishedAt: { $ne: null } },
      populate: { activeRevision: true },
    });
    // Never reopen a published document whose editorial active revision has
    // changed. Reverification only restores the system hash for the exact
    // active revision that was byte-checked by calculate.
    if (
      published?.businessKey === operation.businessKey
      && published.activeRevision?.revisionKey === operation.revisionKey
    ) {
      await app.db.query(ITINERARY_UID).update({
        where: { id: published.id },
        data: { currentEvaluationHash: operation.evaluationHash },
      });
    }
  }

  private async applyVerificationOnly(
    operation: CalculationUpsertOperation,
  ): Promise<'reused' | 'reverified'> {
    const { app } = this.context;
    const [itinerary, revision] = await Promise.all([
      findDocument(app, ITINERARY_UID, {
        status: 'draft',
        filters: { businessKey: { $eq: operation.businessKey } },
        populate: { activeRevision: true },
      }),
      app.db.query(REVISION_UID).findOne({ where: { revisionKey: operation.revisionKey } }),
    ]);
    if (!itinerary || !revision) {
      throw new Error(`La révision ${operation.revisionKey} à revérifier est absente.`);
    }
    if (
      revision.sourceHash !== operation.sourceHash
      || revision.generatedGpxSha256 !== operation.generatedGpxSha256
      || revision.displayGeometrySha256 !== operation.displayGeometrySha256
    ) throw new Error(`La révision immuable ${operation.revisionKey} diverge du rapport.`);
    if (operation.action === 'reverified_unchanged') {
      await app.db.query(REVISION_UID).update({
        where: { id: revision.id },
        data: buildRevisionReverificationData(operation, this.runEntity?.id),
      });
    }
    await this.writeCalculationFingerprints(operation, itinerary, true);
    return operation.action === 'unchanged' ? 'reused' : 'reverified';
  }

  private async verifyExistingRevisionArtifacts(
    operation: CalculationUpsertOperation,
    required = true,
  ): Promise<void> {
    const revision = await this.context.app.db.query(REVISION_UID).findOne({
      where: { revisionKey: operation.revisionKey },
      populate: { generatedGpx: true, displayGeometry: true },
    });
    if (!revision && !required) return;
    const gpxIdentity = mediaIdentityFingerprint(revision?.generatedGpx);
    const displayIdentity = mediaIdentityFingerprint(revision?.displayGeometry);
    if (
      !revision
      || revision.sourceHash !== operation.sourceHash
      || revision.generatedGpxSha256 !== operation.generatedGpxSha256
      || revision.displayGeometrySha256 !== operation.displayGeometrySha256
      || (operation.expectedGeneratedGpxMediaIdentity
        && gpxIdentity !== operation.expectedGeneratedGpxMediaIdentity)
      || (operation.expectedDisplayGeometryMediaIdentity
        && displayIdentity !== operation.expectedDisplayGeometryMediaIdentity)
      || !await verifyMediaBytes(revision.generatedGpx, {
        mime: 'application/gpx+xml',
        sha256: operation.generatedGpxSha256,
        size: operation.generatedGpxSize,
      }, this.artifactVerificationCache)
      || !await verifyMediaBytes(revision.displayGeometry, {
        mime: 'application/json',
        sha256: operation.displayGeometrySha256,
        size: operation.displayGeometrySize,
      }, this.artifactVerificationCache)
    ) throw new Error(`Les octets immuables de ${operation.revisionKey} ont changé depuis le dry-run.`);
  }

  private async prepareCalculation(operation: CalculationUpsertOperation): Promise<PreparedCalculation> {
    const { app, dataset, routeKey } = this.context;
    const { route, routeCities } = await this.calculationSnapshot();
    if (computeCalculationSourceInputHash(route, routeCities, dataset.datasetHash) !== this.context.report.scope.sourceInputHash) {
      throw new Error('Une source réelle a changé avant la préparation des artefacts.');
    }
    const artifactBytes = materializeCalculationArtifacts({ operation, route, routeCities });
    const mediaResults = await Promise.allSettled([
      ensureImmutableMedia(app, {
        bytes: artifactBytes.gpx,
        name: operation.generatedGpxName,
        mime: 'application/gpx+xml',
        sha256: operation.generatedGpxSha256,
        extension: '.gpx',
      }, this.artifactVerificationCache),
      ensureImmutableMedia(app, {
        bytes: artifactBytes.display,
        name: operation.displayGeometryName,
        mime: 'application/json',
        sha256: operation.displayGeometrySha256,
        extension: '.json',
      }, this.artifactVerificationCache),
    ]);
    const createdObjectKeys = mediaResults.flatMap((result) => (
      result.status === 'fulfilled' && result.value.created ? [result.value.objectKey] : []
    ));
    const rejected = mediaResults.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) {
      const nestedOrphans = rejected.reason instanceof CatalogueOperationError
        && Array.isArray(rejected.reason.catalogueDetails.orphanObjectKeys)
        ? rejected.reason.catalogueDetails.orphanObjectKeys.filter((value): value is string => typeof value === 'string')
        : [];
      throw new CatalogueOperationError(
        `La préparation des médias de ${operation.revisionKey} a échoué.`,
        {
          operationKey: operation.key,
          revisionKey: operation.revisionKey,
          orphanObjectKeys: [...new Set([...createdObjectKeys, ...nestedOrphans])].sort(),
        },
        rejected.reason,
      );
    }
    const [gpxResult, displayResult] = mediaResults as [
      PromiseFulfilledResult<EnsuredMedia>,
      PromiseFulfilledResult<EnsuredMedia>,
    ];
    return {
      route,
      routeCities,
      gpxMedia: gpxResult.value.media,
      displayMedia: displayResult.value.media,
      createdObjectKeys,
    };
  }

  private async applyCalculation(
    operation: CalculationUpsertOperation,
    prepared: PreparedCalculation,
  ): Promise<'created' | 'reused' | 'reverified'> {
    const { app } = this.context;
    const { route, routeCities, gpxMedia, displayMedia } = prepared;
    const cityByKey = new Map(routeCities.map((item) => [item.city.municipalityKey, item.city]));
    const anchorByKey = new Map(routeCities.flatMap((item) => item.anchors).map((anchor) => [anchor.anchorKey, anchor]));
    let itinerary = await findDocument(app, ITINERARY_UID, {
      status: 'draft',
      filters: { businessKey: { $eq: operation.businessKey } },
      populate: { activeRevision: true },
    });
    let createdItinerary = false;
    if (!itinerary) {
      itinerary = await app.documents(ITINERARY_UID).create({ status: 'draft', data: {
        businessKey: operation.businessKey,
        title: operation.title,
        slug: operation.slug,
        route: route.documentId,
        cityA: cityByKey.get(operation.cityAKey)?.documentId,
        cityB: cityByKey.get(operation.cityBKey)?.documentId,
        reviewStatus: 'to_review',
        publicationNext: false,
        seoStatus: 'noindex',
        featuredOnCityPages: false,
        currentEvaluationHash: operation.evaluationHash,
      } });
      createdItinerary = true;
    }
    if (
      operation.action === 'stale'
      && itinerary.activeRevision?.documentId
      && itinerary.activeRevision.revisionKey !== operation.revisionKey
    ) {
      await app.documents(REVISION_UID).update({
        documentId: itinerary.activeRevision.documentId,
        data: { calculationStatus: 'stale' },
      });
    }
    let revision = await this.context.app.db.query(REVISION_UID).findOne({
      where: { revisionKey: operation.revisionKey },
      populate: { generatedGpx: true, displayGeometry: true },
    });
    const integrityHash = computeArtifactIntegrityHash({
      sourceHash: operation.sourceHash,
      generatedGpxSha256: operation.generatedGpxSha256,
      displayGeometrySha256: operation.displayGeometrySha256,
    });
    if (revision) {
      if (
        revision.sourceHash !== operation.sourceHash
        || revision.generatedGpxSha256 !== operation.generatedGpxSha256
        || revision.displayGeometrySha256 !== operation.displayGeometrySha256
        || (revision.generatedGpx?.id !== gpxMedia.id && revision.generatedGpx?.documentId !== gpxMedia.documentId)
        || (revision.displayGeometry?.id !== displayMedia.id && revision.displayGeometry?.documentId !== displayMedia.documentId)
      ) {
        await app.documents(REVISION_UID).update({
          documentId: revision.documentId,
          data: { artifactIntegrityStatus: 'invalid' },
        });
        throw new Error(`La révision immuable ${operation.revisionKey} existe avec des artefacts invalides.`);
      }
      await app.documents(REVISION_UID).update({
        documentId: revision.documentId,
        data: {
          lastVerifiedEvaluationHash: operation.evaluationHash,
          lastVerifiedRun: this.runEntity?.documentId,
          artifactIntegrityStatus: 'verified',
          artifactIntegrityHash: integrityHash,
        },
      });
    } else {
      const chapterByDocument = new Map(route.segments.map((segment) => [segment.chapterDocumentId, segment]));
      revision = await app.documents(REVISION_UID).create({ data: {
        revisionKey: operation.revisionKey,
        itinerary: itinerary.documentId,
        run: this.runEntity?.documentId,
        departure: cityByKey.get(operation.departureKey)?.documentId,
        arrival: cityByKey.get(operation.arrivalKey)?.documentId,
        departureAnchor: anchorByKey.get(operation.departureAnchorKey)?.documentId,
        arrivalAnchor: anchorByKey.get(operation.arrivalAnchorKey)?.documentId,
        distanceMetres: operation.distanceMetres,
        asTheCrowFliesMetres: operation.directMetres,
        elevationGainMetres: operation.elevationGainMetres,
        elevationLossMetres: operation.elevationLossMetres,
        elevationAvailable: operation.elevationAvailable,
        eligibleByRoute: operation.eligibleByRoute,
        eligibleByDirect: operation.eligibleByDirect,
        detourRatio: operation.detourRatio,
        usesLoopOrigin: operation.usesLoopOrigin,
        junctionWarnings: operation.junctionWarnings,
        chaptersOnRoute: operation.chaptersOnRoute.map((chapter) => ({
          chapter: chapterByDocument.get(chapter.chapterDocumentId)?.chapterDocumentId,
          routeOrder: chapter.routeOrder,
          distanceMetres: chapter.distanceMetres,
          direction: chapter.direction,
        })),
        citiesOnRoute: operation.citiesOnRoute.map((city) => ({
          city: city.cityDocumentId,
          routeOrder: city.routeOrder,
          occurrenceIndex: city.occurrenceIndex,
          chainageFromDepartureMetres: city.chainageFromDepartureMetres,
        })),
        generatedGpx: requireMediaRelationId(gpxMedia, 'GPX généré'),
        generatedGpxSha256: operation.generatedGpxSha256,
        generatedGpxObjectKey: objectKeyFromUrl(gpxMedia.url),
        displayGeometry: requireMediaRelationId(displayMedia, 'géométrie d’affichage'),
        displayGeometrySha256: operation.displayGeometrySha256,
        displayGeometryObjectKey: objectKeyFromUrl(displayMedia.url),
        sourceHash: operation.sourceHash,
        lastVerifiedEvaluationHash: operation.evaluationHash,
        lastVerifiedRun: this.runEntity?.documentId,
        algorithmVersion: ALGORITHM_VERSION.catalogue,
        calculationStatus: operation.calculationStatus,
        warningApproved: false,
        artifactIntegrityStatus: 'verified',
        artifactIntegrityHash: integrityHash,
        calculationReport: {
          version: 1,
          reportHash: this.context.report.reportHash,
          qualityWarningCodes: operation.qualityWarningCodes,
          directDistanceMethod: operation.directDistanceMethod,
          differences: operation.differences,
          thresholdQaComparison: operation.thresholdQaComparison ?? null,
        },
      } });
    }
    await this.writeCalculationFingerprints(operation, itinerary, false);
    return revision && !createdItinerary ? 'reverified' : 'created';
  }

  async applyOperation(input: {
    operation: ImportOperation | AnchorOperation | CalculationOperation;
    operationIndex: number;
    report: AnyPlan;
    run: CatalogueRunRecord;
    expectedInputHash: string;
  }): Promise<'created' | 'reused' | 'reverified' | 'skipped'> {
    // Les octets immuables sont préparés avant la transaction; une éventuelle
    // source devenue stale laisse au pire un objet dédupliqué orphelin, jamais
    // une révision publiée. Toute écriture DB et le CAS source sont atomiques.
    const operation = input.operation;
    if (operation.kind === 'calculation_error' || operation.kind === 'threshold_qa_review') return 'skipped';
    if (
      operation.kind === 'upsert_itinerary_revision'
      && (operation.action === 'unchanged' || operation.action === 'reverified_unchanged')
    ) await this.verifyExistingRevisionArtifacts(operation);
    const prepared = operation.kind === 'upsert_itinerary_revision'
      && operation.action !== 'unchanged'
      && operation.action !== 'reverified_unchanged'
      ? await this.prepareCalculation(operation)
      : null;
    const preparedImport = operation.kind === 'setup_reference_route'
      ? await this.chapterContract()
      : null;
    try {
      return await this.context.app.db.transaction(async ({ trx }: { trx: any }) => {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(?)',
          [CATALOGUE_SOURCE_LOCK_KEY],
        );
        await this.assertSourceUnchangedLightweight();
        if (operation.kind === 'setup_reference_route' || operation.kind === 'upsert_city_route_city') {
          const target = await this.importTargetState(operation as ImportOperation, preparedImport);
          if (target.hash !== operation.expectedTargetHash) {
            if (target.resultHash === operation.expectedResultHash) return 'reused';
            throw new Error(`La cible import ${operation.key} a changé depuis le dry-run.`);
          }
        }
        if (operation.kind === 'upsert_anchor') {
          const target = await this.anchorTargetState(operation);
          if (target.hash !== operation.expectedTargetHash) {
            if (target.resultHash === operation.expectedResultHash) return 'reused';
            throw new Error(`L’ancre ${operation.anchorKey} a changé depuis le dry-run.`);
          }
        }
        if (operation.kind === 'upsert_itinerary_revision' || operation.kind === 'archive_itinerary') {
          const current = (await loadExistingItineraries(
            this.context.app,
            undefined,
            false,
            operation.businessKey,
          ))[0];
          if (hashExistingItineraryCas(current) !== operation.expectedItineraryCasHash) {
            // Reprise idempotente après commit réussi mais checkpoint manquant.
            if (operation.kind === 'upsert_itinerary_revision') {
              if (await this.calculationUpsertResultHash(operation) === operation.expectedItineraryResultHash) {
                return 'reverified';
              }
            } else if (hashExistingItineraryCas(current) === operation.expectedItineraryResultHash) {
              return 'reused';
            }
            throw new Error(`L’état éditorial de ${operation.businessKey} a changé depuis le dry-run.`);
          }
        }
        const result = await runAsCatalogueSystemMutation(async () => {
          if (operation.kind === 'setup_reference_route' || operation.kind === 'upsert_city_route_city') {
            return this.applyImport(operation as ImportOperation, preparedImport);
          }
          if (operation.kind === 'upsert_anchor') return this.applyAnchor(operation);
          if (operation.kind === 'archive_itinerary') return this.applyArchive(operation);
          if (
            operation.kind === 'upsert_itinerary_revision'
            && (operation.action === 'unchanged' || operation.action === 'reverified_unchanged')
          ) {
            if (operation.action === 'unchanged') return 'reused';
            return this.applyVerificationOnly(operation);
          }
          return this.applyCalculation(operation as CalculationUpsertOperation, prepared!);
        });
        if (operation.kind === 'setup_reference_route' || operation.kind === 'upsert_city_route_city') {
          const post = await this.importTargetState(operation as ImportOperation, preparedImport);
          if (post.resultHash !== operation.expectedResultHash) {
            throw new Error(`La cible import ${operation.key} ne correspond pas au post-état exact.`);
          }
        } else if (operation.kind === 'upsert_anchor') {
          const post = await this.anchorTargetState(operation);
          if (post.resultHash !== operation.expectedResultHash) {
            throw new Error(`L’ancre ${operation.anchorKey} ne correspond pas au post-état exact.`);
          }
        } else if (operation.kind === 'archive_itinerary') {
          const post = (await loadExistingItineraries(
            this.context.app,
            undefined,
            false,
            operation.businessKey,
          ))[0];
          if (hashExistingItineraryCas(post) !== operation.expectedItineraryResultHash) {
            throw new Error(`L’archive ${operation.businessKey} ne correspond pas au post-état exact.`);
          }
        } else if (operation.kind === 'upsert_itinerary_revision') {
          if (await this.calculationUpsertResultHash(operation) !== operation.expectedItineraryResultHash) {
            throw new Error(`La révision ${operation.revisionKey} ne correspond pas au post-état exact.`);
          }
        }
        return result;
      });
    } catch (error) {
      const orphanObjectKeys = prepared?.createdObjectKeys ?? [];
      if (orphanObjectKeys.length === 0 || error instanceof CatalogueOperationError) throw error;
      throw new CatalogueOperationError(
        `L’opération ${operation.key} a échoué après upload de média.`,
        {
          operationKey: operation.key,
          revisionKey: operation.kind === 'upsert_itinerary_revision' ? operation.revisionKey : null,
          orphanObjectKeys: [...new Set(orphanObjectKeys)].sort(),
        },
        error,
      );
    }
  }
}

export async function buildCataloguePlanFromStrapi(input: Omit<AdapterContext, 'report'> & {
  mode: 'import' | 'anchors' | 'calculate';
}): Promise<AnyPlan> {
  if (input.mode === 'import') {
    const state = await loadImportState(input.app, input.dataset, input.routeKey);
    return planCatalogueImport({
      dataset: input.dataset,
      state,
      routeKey: input.routeKey,
      codeVersion: input.codeVersion,
    });
  }
  const route = await loadRuntimeRoute(input.app, input.routeKey, input.dataset, 'published');
  const routeCities = await loadRouteCities(input.app, route, input.mode !== 'anchors');
  if (input.mode === 'anchors') return planCatalogueAnchors({
    route,
    routeCities,
    dataset: input.dataset,
    boundarySnapshot: input.boundarySnapshot,
    codeVersion: input.codeVersion,
  });
  return planCatalogueCalculation({
    route,
    routeCities,
    baselineProducts: input.dataset.products,
    thresholdQa: input.dataset.thresholdQa,
    baselineHash: input.dataset.datasetHash,
    existingItineraries: await loadExistingItineraries(input.app, route.documentId),
    codeVersion: input.codeVersion,
  });
}

export async function executeCataloguePlanOnStrapi(input: AdapterContext & {
  confirmationHash: string;
  operator: string;
  signal?: AbortSignal;
}): Promise<CatalogueRunRecord> {
  return applyCataloguePlan({
    adapter: new CatalogueStrapiAdapter(input),
    report: input.report,
    confirmationHash: input.confirmationHash,
    operator: input.operator,
    signal: input.signal,
  });
}

export const testing = {
  loadChapterContract,
  loadExistingItineraries,
  loadImportState,
  loadRouteCities,
  loadRuntimeRoute,
  objectKeyFromUrl,
  primaryAnchorsFromChapterEntity,
  requireMediaRelationId,
  safeArtifactName,
  verifyMediaBytes,
};
