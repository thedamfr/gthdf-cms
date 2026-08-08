import type { Core, Modules } from '@strapi/strapi';
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import { errors } from '@strapi/utils';
import {
  validateChapterForPublication,
  validatePublishedChapterOrder,
  validatePublishedChapterRemoval,
} from './domain/chapter-validation';
import {
  validateGpxBuilderRoute,
  type GpxBuilderChapter,
} from './domain/gpx-builder-validation';
import {
  normalizeAlternativeNames,
  validateCityCoordinates,
  validateCityForPublication,
  validateStableCityIdentity,
} from './domain/city-validation';
import {
  validateAnchorAgainstPublishedRoute,
  validateAnchorIdentity,
  validateCityItineraryForPublication,
  validateNoManualSystemFieldMutation,
  validateReferenceRouteForPublication,
  validateRevisionImmutability,
  validateRouteCityIdentity,
  validateWarningApproval,
  type PublishedPrd03Junction,
  type PublishedAnchorRouteSegment,
} from './domain/catalogue-validation';
import { hashCanonical, parseOfficialGpx, sha256Hex } from './domain/catalogue-core';

const { fetchOfficialMediaBytes } = require(resolve(process.cwd(), 'scripts/prepare-gpx-anchors.js')) as {
  fetchOfficialMediaBytes(media: Record<string, unknown>): Promise<Uint8Array>;
};

const MAX_SHARE_IMAGE_SIZE_KB = 600;
const { ApplicationError } = errors;
const SEO_CONTENT_TYPES = [
  'api::article.article',
  'api::chapter.chapter',
  'api::city.city',
  'api::city-itinerary.city-itinerary',
  'api::global.global',
  'api::homepage.homepage',
];
const CITY_UID = 'api::city.city';
const CHAPTER_UID = 'api::chapter.chapter';
const GLOBAL_UID = 'api::global.global';
const REFERENCE_ROUTE_UID = 'api::reference-route.reference-route';
const ROUTE_CITY_UID = 'api::route-city.route-city';
const ROUTE_ANCHOR_UID = 'api::route-anchor.route-anchor';
const CITY_ITINERARY_UID = 'api::city-itinerary.city-itinerary';
const ITINERARY_REVISION_UID = 'api::itinerary-revision.itinerary-revision';
const ITINERARY_REDIRECT_UID = 'api::itinerary-slug-redirect.itinerary-slug-redirect';
// Les scripts TS chargent parfois `src/index.ts` pendant que Strapi exécute sa
// copie compilée `dist/src/index.js`. Un stockage porté par globalThis garantit
// que les deux modules partagent le même contexte d’autorisation système.
const CATALOGUE_MUTATION_STORAGE_KEY = '__gthdfCatalogueSystemMutationStorage';
const catalogueMutationGlobal = globalThis as typeof globalThis & {
  [CATALOGUE_MUTATION_STORAGE_KEY]?: AsyncLocalStorage<boolean>;
};
const catalogueSystemMutation = catalogueMutationGlobal[CATALOGUE_MUTATION_STORAGE_KEY]
  ??= new AsyncLocalStorage<boolean>();

export function runAsCatalogueSystemMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
  return catalogueSystemMutation.run(true, operation);
}

function isCatalogueSystemMutation(): boolean {
  return catalogueSystemMutation.getStore() === true;
}

// Valeur ASCII hexadécimale de « GTHF », réservée dans cette base PostgreSQL
// à la sérialisation transactionnelle de l’ensemble des chapitres publiés.
export const CHAPTER_PUBLICATION_LOCK_KEY = 0x47544846;
// Namespace « CAT4 ». Toute mutation d’une source catalogue et toute unité
// d’apply prennent ce verrou transactionnel avant leur CAS court.
export const CATALOGUE_SOURCE_LOCK_KEY = 0x43415434;

type DocumentMiddlewareContext = {
  action: string;
  contentType: { uid: string };
  params: {
    data?: Record<string, unknown>;
    documentId?: string;
    status?: string;
  };
};

type DocumentMiddlewareNext = Parameters<Modules.Documents.Middleware.Middleware>[1];
type DocumentMiddlewareResult = ReturnType<Modules.Documents.Middleware.Middleware>;

type MediaReference = {
  id?: number;
  documentId?: string;
};

function extractMediaReference(value: unknown): MediaReference | null {
  if (!value) {
    return null;
  }

  if (typeof value === 'number') {
    return { id: value };
  }

  if (typeof value === 'string') {
    return /^\d+$/.test(value) ? { id: Number(value) } : { documentId: value };
  }

  if (Array.isArray(value)) {
    return extractMediaReference(value[0]);
  }

  if (typeof value !== 'object') {
    return null;
  }

  const relationValue = value as Record<string, unknown>;

  if (typeof relationValue.id === 'number') {
    return { id: relationValue.id };
  }

  if (typeof relationValue.documentId === 'string') {
    return { documentId: relationValue.documentId };
  }

  if ('connect' in relationValue) {
    return extractMediaReference(relationValue.connect);
  }

  if ('set' in relationValue) {
    return extractMediaReference(relationValue.set);
  }

  return null;
}

async function validateSeoShareImage(
  strapi: Core.Strapi,
  event: { params?: { data?: Record<string, unknown> } }
) {
  const seo = event.params?.data?.seo;

  if (!seo || typeof seo !== 'object') {
    return;
  }

  const shareImageReference = extractMediaReference(
    (seo as Record<string, unknown>).shareImage
  );

  if (!shareImageReference) {
    return;
  }

  const where = shareImageReference.id !== undefined
    ? { id: shareImageReference.id }
    : shareImageReference.documentId
      ? { documentId: shareImageReference.documentId }
      : null;

  if (!where) {
    return;
  }

  const file = await strapi.db.query('plugin::upload.file').findOne({
    where,
    select: ['id', 'name', 'size'],
  });

  if (!file || typeof file.size !== 'number' || file.size <= MAX_SHARE_IMAGE_SIZE_KB) {
    return;
  }

  throw new ApplicationError(
    `L'image de partage doit faire moins de ${MAX_SHARE_IMAGE_SIZE_KB} KB pour rester compatible avec WhatsApp. Taille actuelle : ${file.size.toFixed(2)} KB.`
  );
}

async function validateEntitySeoShareImage(
  strapi: Core.Strapi,
  uid: string,
  documentId: string | undefined
) {
  if (!documentId) {
    return;
  }

  const entity = await strapi.db.query(uid).findOne({
    where: { documentId },
    populate: {
      seo: {
        populate: ['shareImage'],
      },
    },
  });

  const shareImage = (entity as Record<string, any> | null)?.seo?.shareImage;

  if (!shareImage || typeof shareImage.size !== 'number' || shareImage.size <= MAX_SHARE_IMAGE_SIZE_KB) {
    return;
  }

  throw new ApplicationError(
    `L'image de partage doit faire moins de ${MAX_SHARE_IMAGE_SIZE_KB} KB pour rester compatible avec WhatsApp. Taille actuelle : ${shareImage.size.toFixed(2)} KB.`
  );
}

function throwApplicationError(error: unknown): never {
  const message = error instanceof Error ? error.message : 'Validation métier impossible.';
  throw new ApplicationError(message);
}

async function getDraftForValidation(
  strapi: Core.Strapi,
  uid: string,
  documentId: string | undefined,
  populate?: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  if (!documentId) {
    return null;
  }

  return strapi.db.query(uid).findOne({
    where: { documentId, publishedAt: null },
    ...(populate ? { populate } : {}),
  }) as Promise<Record<string, unknown> | null>;
}

const GPX_BUILDER_CHAPTER_POPULATE = {
  gpxFileAB: true,
  gpxFileBA: true,
  gpxJunctionAfterAB: true,
  gpxJunctionAfterBA: true,
  cityPassages: {
    populate: {
      city: true,
      gpxAnchorAB: true,
      gpxAnchorBA: true,
    },
  },
};

const CHAPTER_PUBLICATION_POPULATE = {
  cityPassages: {
    populate: {
      city: true,
    },
  },
};

async function isGpxBuilderEnabled(strapi: Core.Strapi): Promise<boolean> {
  const settings = await strapi.db.query(GLOBAL_UID).findOne({
    where: {},
    select: ['gpxBuilderEnabled'],
  }) as Record<string, unknown> | null;

  return settings?.gpxBuilderEnabled === true;
}

async function getPublishedChaptersForGpxBuilder(
  strapi: Core.Strapi,
  includeGpxBuilderData = true
): Promise<GpxBuilderChapter[]> {
  return strapi.db.query(CHAPTER_UID).findMany({
    where: { publishedAt: { $ne: null } },
    select: ['documentId', 'slug', 'title', 'displayOrder'],
    ...(includeGpxBuilderData ? { populate: GPX_BUILDER_CHAPTER_POPULATE } : {}),
  }) as Promise<GpxBuilderChapter[]>;
}

async function validateGlobalDocument(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext
): Promise<void> {
  if (!['create', 'update'].includes(context.action)) {
    return;
  }

  const incomingData = context.params.data ?? {};
  const explicitlyEnables = Object.prototype.hasOwnProperty.call(
    incomingData,
    'gpxBuilderEnabled'
  ) && incomingData.gpxBuilderEnabled === true;
  if (!explicitlyEnables) {
    return;
  }

  const current = await strapi.db.query(GLOBAL_UID).findOne({
    where: {},
    select: ['gpxBuilderEnabled'],
  }) as Record<string, unknown> | null;
  if (current?.gpxBuilderEnabled === true) {
    return;
  }

  try {
    validateGpxBuilderRoute(await getPublishedChaptersForGpxBuilder(strapi));
  } catch (error) {
    throwApplicationError(error);
  }
}

async function validateCityDocument(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext
): Promise<void> {
  const { action, params } = context;
  const isWrite = action === 'create' || action === 'update';
  const isPublishing = action === 'publish'
    || (isWrite && params.status === 'published');

  if (!isWrite && !isPublishing) {
    return;
  }

  const draft = await getDraftForValidation(strapi, CITY_UID, params.documentId);
  const incomingData = params.data ?? {};

  if (isWrite && Object.prototype.hasOwnProperty.call(incomingData, 'alternativeNames')) {
    incomingData.alternativeNames = normalizeAlternativeNames(incomingData.alternativeNames);
  }

  const nextCity = {
    ...(draft ?? {}),
    ...incomingData,
  };

  try {
    validateCityCoordinates(nextCity);

    if (action === 'update' && params.documentId) {
      const publishedCity = await strapi.db.query(CITY_UID).findOne({
        where: {
          documentId: params.documentId,
          publishedAt: { $ne: null },
        },
        select: ['slug', 'municipalityKey'],
      }) as Record<string, unknown> | null;

      validateStableCityIdentity(publishedCity, nextCity);
    }

    if (isPublishing) {
      validateCityForPublication(nextCity);
    }
  } catch (error) {
    throwApplicationError(error);
  }
}

const REFERENCE_ROUTE_POPULATE = {
  segments: {
    populate: {
      chapter: true,
    },
  },
};

const ITINERARY_REVISION_PUBLICATION_POPULATE = {
  itinerary: true,
  departure: true,
  arrival: true,
  generatedGpx: true,
  displayGeometry: true,
};

const CITY_ITINERARY_PUBLICATION_POPULATE = {
  route: true,
  cityA: true,
  cityB: true,
  activeRevision: { populate: ITINERARY_REVISION_PUBLICATION_POPULATE },
};

async function getPublishedPrd03Junctions(
  strapi: Core.Strapi
): Promise<PublishedPrd03Junction[]> {
  const chapters = await strapi.db.query(CHAPTER_UID).findMany({
    where: { publishedAt: { $ne: null } },
    select: ['documentId'],
    populate: {
      gpxJunctionAfterAB: true,
      gpxJunctionAfterBA: true,
    },
  }) as Array<Record<string, any>>;

  return chapters.flatMap((chapter) => ([
    {
      chapterDocumentId: chapter.documentId,
      direction: 'ab' as const,
      status: chapter.gpxJunctionAfterAB?.status,
      gapMetres: chapter.gpxJunctionAfterAB?.gapMetres,
      sourceSha256: chapter.gpxJunctionAfterAB?.sourceSha256,
      nextSourceSha256: chapter.gpxJunctionAfterAB?.nextSourceSha256,
      reviewNote: chapter.gpxJunctionAfterAB?.reviewNote,
    },
    {
      chapterDocumentId: chapter.documentId,
      direction: 'ba' as const,
      status: chapter.gpxJunctionAfterBA?.status,
      gapMetres: chapter.gpxJunctionAfterBA?.gapMetres,
      sourceSha256: chapter.gpxJunctionAfterBA?.sourceSha256,
      nextSourceSha256: chapter.gpxJunctionAfterBA?.nextSourceSha256,
      reviewNote: chapter.gpxJunctionAfterBA?.reviewNote,
    },
  ])) as PublishedPrd03Junction[];
}

async function validateReferenceRouteDocument(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext
): Promise<void> {
  const { action, params } = context;
  const isWrite = action === 'create' || action === 'update';
  const isPublishing = action === 'publish' || (isWrite && params.status === 'published');
  if (!isWrite && !isPublishing) return;

  try {
    if (isWrite && !isCatalogueSystemMutation()) validateNoManualSystemFieldMutation(REFERENCE_ROUTE_UID, params.data ?? {});
    if (action === 'update' && params.documentId) {
      const published = await strapi.db.query(REFERENCE_ROUTE_UID).findOne({
        where: { documentId: params.documentId, publishedAt: { $ne: null } },
        select: ['routeKey', 'slug'],
      }) as Record<string, unknown> | null;
      if (
        published
        && ((params.data?.routeKey !== undefined && params.data.routeKey !== published.routeKey)
          || (params.data?.slug !== undefined && params.data.slug !== published.slug))
      ) {
        throw new Error('routeKey et slug sont immuables après la première publication du parcours.');
      }
    }
    if (!isPublishing) return;
    const draft = await getDraftForValidation(
      strapi,
      REFERENCE_ROUTE_UID,
      params.documentId,
      REFERENCE_ROUTE_POPULATE
    );
    validateReferenceRouteForPublication(
      { ...(draft ?? {}), ...(params.data ?? {}) },
      await getPublishedPrd03Junctions(strapi)
    );
  } catch (error) {
    throwApplicationError(error);
  }
}

async function validateRouteAnchorDocument(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext
): Promise<void> {
  if (!['create', 'update'].includes(context.action)) return;
  try {
    const current = context.params.documentId
      ? await strapi.db.query(ROUTE_ANCHOR_UID).findOne({
        where: { documentId: context.params.documentId },
        populate: { chapter: true, routeCity: { populate: { route: true, city: true } } },
      }) as Record<string, unknown> | null
      : null;
    const next = { ...(current ?? {}), ...(context.params.data ?? {}) } as Record<string, any>;
    if (!next.routeCity?.route?.routeKey || !next.routeCity?.city?.municipalityKey) {
      const reference = extractMediaReference(next.routeCity);
      if (!reference) throw new Error('La relation routeCity est requise pour une ancre.');
      next.routeCity = await strapi.db.query(ROUTE_CITY_UID).findOne({
        where: reference.id !== undefined ? { id: reference.id } : { documentId: reference.documentId },
        populate: { route: true, city: true },
      });
    }
    validateAnchorIdentity(next);
    if (next.validationStatus === 'validated') {
      const routeDocumentId = next.routeCity?.route?.documentId;
      const cityDocumentId = next.routeCity?.city?.documentId;
      if (!routeDocumentId || !cityDocumentId) {
        throw new Error('La route et la ville publiées sont requises pour valider une ancre.');
      }
      const [route, city] = await Promise.all([
        strapi.db.query(REFERENCE_ROUTE_UID).findOne({
          where: { documentId: routeDocumentId, publishedAt: { $ne: null } },
          populate: { segments: { populate: { chapter: true } } },
        }) as Promise<Record<string, any> | null>,
        strapi.db.query(CITY_UID).findOne({
          where: { documentId: cityDocumentId, publishedAt: { $ne: null } },
          select: ['documentId', 'municipalityKey', 'latitude', 'longitude'],
        }) as Promise<Record<string, any> | null>,
      ]);
      if (!route || !city || !Array.isArray(route.segments)) {
        throw new Error('La route ou la ville publiée est absente pour recomposer l’ancre.');
      }
      // Lecture séquentielle et bornée : cette validation éditoriale rare ne
      // doit jamais ouvrir dix téléchargements GPX simultanés.
      const publishedSegments: PublishedAnchorRouteSegment[] = [];
      for (const [index, routeSegment] of route.segments.entries()) {
        const chapterDocumentId = routeSegment.chapter?.documentId;
        if (!chapterDocumentId || routeSegment.direction !== 'ab') {
          throw new Error(`Le segment ${index + 1} ne référence pas un chapitre AB publié.`);
        }
        const chapter = await strapi.db.query(CHAPTER_UID).findOne({
          where: { documentId: chapterDocumentId, publishedAt: { $ne: null } },
          select: ['documentId', 'slug'],
          populate: { gpxFileAB: true },
        }) as Record<string, any> | null;
        if (!chapter?.gpxFileAB) throw new Error(`Le GPX AB publié de ${chapterDocumentId} est absent.`);
        const bytes = await fetchOfficialMediaBytes(chapter.gpxFileAB);
        const actualSourceSha256 = sha256Hex(bytes);
        if (actualSourceSha256 !== String(routeSegment.sourceSha256 ?? '').toLowerCase()) {
          throw new Error(`Les octets GPX publiés de ${chapter.slug ?? chapterDocumentId} divergent de ReferenceRoute.`);
        }
        publishedSegments.push({
          index,
          chapterKey: chapter.slug,
          chapterDocumentId,
          sourceSha256: actualSourceSha256,
          document: parseOfficialGpx(new TextDecoder().decode(bytes)),
          junctionAfter: {
            status: routeSegment.junctionAfterStatus,
            gapMetres: Number(routeSegment.junctionAfterGapMetres),
            nextSourceSha256: String(routeSegment.nextSourceSha256 ?? '').toLowerCase(),
            reviewNote: routeSegment.junctionNote ?? null,
          },
        });
      }
      next.routeCity = { ...next.routeCity, route, city };
      validateAnchorIdentity(next);
      validateAnchorAgainstPublishedRoute(next, publishedSegments, city);
    }
  } catch (error) {
    throwApplicationError(error);
  }
}

async function validateRouteCityDocument(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext
): Promise<void> {
  if (!['create', 'update'].includes(context.action)) return;
  try {
    if (!isCatalogueSystemMutation()) validateNoManualSystemFieldMutation(ROUTE_CITY_UID, context.params.data ?? {});
    const current = context.params.documentId
      ? await strapi.db.query(ROUTE_CITY_UID).findOne({
        where: { documentId: context.params.documentId },
        populate: { route: true, city: true },
      }) as Record<string, unknown> | null
      : null;
    const next = { ...(current ?? {}), ...(context.params.data ?? {}) } as Record<string, any>;
    // Les jobs et l’admin Strapi fournissent les relations peuplées dans les
    // créations contrôlées. Une relation réduite à un connect/id est relue
    // avant validation afin que la clé ne soit jamais acceptée par sa forme seule.
    for (const [field, uid] of [['route', REFERENCE_ROUTE_UID], ['city', CITY_UID]] as const) {
      const relation = next[field];
      if (relation && typeof relation === 'object' && (relation.routeKey || relation.municipalityKey)) continue;
      const reference = extractMediaReference(relation);
      if (!reference) throw new Error(`La relation ${field} est requise pour RouteCity.`);
      next[field] = await strapi.db.query(uid).findOne({
        where: reference.id !== undefined ? { id: reference.id } : { documentId: reference.documentId },
      });
    }
    validateRouteCityIdentity(next);
  } catch (error) {
    throwApplicationError(error);
  }
}

async function validateItineraryRevisionDocument(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext
): Promise<void> {
  if (!['create', 'update'].includes(context.action)) return;
  try {
    if (!isCatalogueSystemMutation()) validateNoManualSystemFieldMutation(ITINERARY_REVISION_UID, context.params.data ?? {});
    const current = context.params.documentId
      ? await strapi.db.query(ITINERARY_REVISION_UID).findOne({
        where: { documentId: context.params.documentId },
        populate: {
          itinerary: true,
          run: true,
          departure: true,
          arrival: true,
          departureAnchor: true,
          arrivalAnchor: true,
          generatedGpx: true,
          displayGeometry: true,
        },
      }) as Record<string, unknown> | null
      : null;
    const nextRevision = { ...(current ?? {}), ...(context.params.data ?? {}) };
    validateRevisionImmutability(current, nextRevision);
    validateWarningApproval(nextRevision);
  } catch (error) {
    throwApplicationError(error);
  }
}

async function hydrateIncomingCityItineraryRelations(
  strapi: Core.Strapi,
  incomingData: Record<string, unknown>,
  nextItinerary: Record<string, any>,
): Promise<void> {
  const relations = [
    { field: 'route', uid: REFERENCE_ROUTE_UID },
    { field: 'cityA', uid: CITY_UID },
    { field: 'cityB', uid: CITY_UID },
    {
      field: 'activeRevision',
      uid: ITINERARY_REVISION_UID,
      populate: ITINERARY_REVISION_PUBLICATION_POPULATE,
    },
  ] as const;
  for (const relation of relations) {
    if (!Object.prototype.hasOwnProperty.call(incomingData, relation.field)) continue;
    const reference = extractMediaReference(incomingData[relation.field]);
    if (!reference) {
      nextItinerary[relation.field] = null;
      continue;
    }
    nextItinerary[relation.field] = await strapi.db.query(relation.uid).findOne({
      where: reference.id !== undefined ? { id: reference.id } : { documentId: reference.documentId },
      ...('populate' in relation ? { populate: relation.populate } : {}),
    });
  }
}

export async function validateCityItineraryDocument(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext
): Promise<void> {
  const { action, params } = context;
  const isWrite = action === 'create' || action === 'update';
  const isPublishing = action === 'publish' || (isWrite && params.status === 'published');
  if (!isWrite && !isPublishing) return;
  try {
    if (isWrite && !isCatalogueSystemMutation()) validateNoManualSystemFieldMutation(CITY_ITINERARY_UID, params.data ?? {});
    if (action === 'update' && params.documentId && params.data?.slug !== undefined) {
      const published = await strapi.db.query(CITY_ITINERARY_UID).findOne({
        where: { documentId: params.documentId, publishedAt: { $ne: null } },
        select: ['documentId', 'slug'],
      }) as Record<string, any> | null;
      const nextSlug = String(params.data.slug ?? '').trim();
      if (published?.slug && nextSlug !== published.slug) {
        const redirect = await strapi.db.query(ITINERARY_REDIRECT_UID).findOne({
          where: { oldSlug: published.slug, enabled: true },
          populate: { itinerary: true },
        }) as Record<string, any> | null;
        if (
          !redirect
          || !String(redirect.reason ?? '').trim()
          || redirect.itinerary?.documentId !== params.documentId
        ) {
          throw new Error('Changer un slug publié exige d’abord une redirection activée, motivée et reliée au même itinéraire.');
        }
        const conflictingRedirect = await strapi.db.query(ITINERARY_REDIRECT_UID).findOne({
          where: { oldSlug: nextSlug, enabled: true },
        });
        if (conflictingRedirect) {
          throw new Error('Le nouveau slug est déjà réservé par une redirection active.');
        }
        const conflictingItinerary = await strapi.db.query(CITY_ITINERARY_UID).findOne({
          where: { slug: nextSlug, publishedAt: { $ne: null }, documentId: { $ne: params.documentId } },
          select: ['documentId'],
        });
        if (conflictingItinerary) throw new Error('Le nouveau slug appartient déjà à un itinéraire publié.');
      }
    }
    if (!isPublishing && params.data?.publicationNext !== true) return;
    const draft = await getDraftForValidation(
      strapi,
      CITY_ITINERARY_UID,
      params.documentId,
      CITY_ITINERARY_PUBLICATION_POPULATE
    );
    const nextItinerary = { ...(draft ?? {}), ...(params.data ?? {}) } as Record<string, any>;
    await hydrateIncomingCityItineraryRelations(strapi, params.data ?? {}, nextItinerary);
    validateCityItineraryForPublication(nextItinerary);
  } catch (error) {
    throwApplicationError(error);
  }
}

export async function validateChapterDocument(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext
): Promise<void> {
  const { action, params } = context;
  const isWrite = action === 'create' || action === 'update';
  const isPublishing = action === 'publish'
    || (isWrite && params.status === 'published');
  const isRemovingPublishedVersion = action === 'unpublish' || action === 'delete';

  if (!isPublishing && !isRemovingPublishedVersion) {
    return;
  }

  const builderEnabled = await isGpxBuilderEnabled(strapi);
  const publishedChapters = await getPublishedChaptersForGpxBuilder(
    strapi,
    builderEnabled
  );

  if (isRemovingPublishedVersion) {
    try {
      validatePublishedChapterRemoval(publishedChapters, params.documentId);
      if (builderEnabled) {
        validateGpxBuilderRoute(
          publishedChapters.filter((chapter) => chapter.documentId !== params.documentId)
        );
      }
    } catch (error) {
      throwApplicationError(error);
    }
    return;
  }

  const draft = await getDraftForValidation(
    strapi,
    CHAPTER_UID,
    params.documentId,
    builderEnabled ? GPX_BUILDER_CHAPTER_POPULATE : CHAPTER_PUBLICATION_POPULATE
  );

  const nextChapter = {
    ...(draft ?? {}),
    ...(params.data ?? {}),
  };

  const nextPublishedSet = [
    ...publishedChapters.filter((chapter) => (
      !params.documentId || chapter.documentId !== params.documentId
    )),
    nextChapter,
  ];

  try {
    validateChapterForPublication(nextChapter);
    validatePublishedChapterOrder(nextPublishedSet);
    if (builderEnabled) {
      validateGpxBuilderRoute(nextPublishedSet);
    }
  } catch (error) {
    throwApplicationError(error);
  }
}

function changesPublishedChapterSet(context: DocumentMiddlewareContext): boolean {
  if (context.contentType.uid === GLOBAL_UID) {
    return ['create', 'update'].includes(context.action)
      && context.params.data?.gpxBuilderEnabled === true;
  }

  if (context.contentType.uid !== CHAPTER_UID) {
    return false;
  }

  const { action, params } = context;
  const publishesFromWrite = (action === 'create' || action === 'update')
    && params.status === 'published';

  return action === 'publish'
    || action === 'unpublish'
    || action === 'delete'
    || publishesFromWrite;
}

async function validateDocumentAndRunNext(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext,
  next: DocumentMiddlewareNext
): DocumentMiddlewareResult {
  const documentParams = context.params as {
    data?: Record<string, unknown>;
    documentId?: string;
  };

  if (context.contentType.uid === CITY_UID) {
    await validateCityDocument(strapi, context);
  }

  if (context.contentType.uid === CHAPTER_UID) {
    await validateChapterDocument(strapi, context);
  }

  if (context.contentType.uid === GLOBAL_UID) {
    await validateGlobalDocument(strapi, context);
  }

  if (context.contentType.uid === REFERENCE_ROUTE_UID) {
    await validateReferenceRouteDocument(strapi, context);
  }

  if (context.contentType.uid === ROUTE_CITY_UID) {
    await validateRouteCityDocument(strapi, context);
  }

  if (context.contentType.uid === ROUTE_ANCHOR_UID) {
    await validateRouteAnchorDocument(strapi, context);
  }

  if (context.contentType.uid === ITINERARY_REVISION_UID) {
    await validateItineraryRevisionDocument(strapi, context);
  }

  if (context.contentType.uid === CITY_ITINERARY_UID) {
    await validateCityItineraryDocument(strapi, context);
  }

  if (SEO_CONTENT_TYPES.includes(context.contentType.uid)) {
    if (['create', 'update'].includes(context.action)) {
      await validateSeoShareImage(strapi, {
        params: { data: documentParams.data },
      });
    }

    if (['update', 'publish'].includes(context.action)) {
      await validateEntitySeoShareImage(
        strapi,
        context.contentType.uid,
        documentParams.documentId
      );
    }
  }

  return next();
}

export function invalidatesCataloguePublication(
  context: DocumentMiddlewareContext
): boolean {
  const { uid } = context.contentType;
  const { action, params } = context;
  if ([ROUTE_CITY_UID, ROUTE_ANCHOR_UID].includes(uid)) {
    return ['create', 'update', 'delete'].includes(action);
  }
  if (![CITY_UID, CHAPTER_UID, REFERENCE_ROUTE_UID].includes(uid)) return false;
  const writesPublishedVersion = ['create', 'update'].includes(action)
    && params.status === 'published';
  return writesPublishedVersion || ['publish', 'unpublish', 'delete'].includes(action);
}

export async function invalidateCataloguePublicationFingerprints(
  strapi: Core.Strapi
): Promise<void> {
  // Conservative by design: a route change can change the winning circular
  // arc of every pair. These are three short UPDATEs in the surrounding unit;
  // no GPX/media read or pair calculation happens here.
  await strapi.db.query(CITY_ITINERARY_UID).updateMany({
    where: { currentEvaluationHash: { $notNull: true } },
    data: { currentEvaluationHash: null },
  });
  await strapi.db.query(ROUTE_CITY_UID).updateMany({
    where: { currentInputFingerprint: { $notNull: true } },
    data: { currentInputFingerprint: null },
  });
  await strapi.db.query(REFERENCE_ROUTE_UID).updateMany({
    where: { currentInputFingerprint: { $notNull: true } },
    data: { currentInputFingerprint: null },
  });
}

async function publishedReferenceRouteCalculationSignature(
  strapi: Core.Strapi,
  documentId: string | undefined,
): Promise<string | null> {
  if (!documentId) return null;
  const route = await strapi.db.query(REFERENCE_ROUTE_UID).findOne({
    where: { documentId, publishedAt: { $ne: null } },
    select: ['routeKey', 'isLoop', 'algorithmVersion', 'sourceManifestHash'],
    populate: { segments: { populate: { chapter: true } } },
  }) as Record<string, any> | null;
  if (!route) return null;
  return hashCanonical({
    routeKey: route.routeKey,
    isLoop: route.isLoop,
    algorithmVersion: route.algorithmVersion,
    sourceManifestHash: route.sourceManifestHash,
    segments: (route.segments ?? []).map((segment: Record<string, any>) => ({
      chapterDocumentId: segment.chapter?.documentId,
      direction: segment.direction,
      sourceSha256: segment.sourceSha256,
      nextSourceSha256: segment.nextSourceSha256,
      junctionAfterStatus: segment.junctionAfterStatus,
      junctionAfterGapMetres: segment.junctionAfterGapMetres,
      junctionNote: segment.junctionNote ?? null,
    })),
  });
}

export async function runDocumentMiddleware(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext,
  next: DocumentMiddlewareNext
): DocumentMiddlewareResult {
  const needsChapterLock = changesPublishedChapterSet(context);
  const needsCatalogueInvalidation = invalidatesCataloguePublication(context);
  if (!needsChapterLock && !needsCatalogueInvalidation) {
    return validateDocumentAndRunNext(strapi, context, next);
  }

  return strapi.db.transaction(async ({ trx }) => {
    if (needsChapterLock) {
      await trx.raw(
        'SELECT pg_advisory_xact_lock(?)',
        [CHAPTER_PUBLICATION_LOCK_KEY]
      );
    }
    if (needsCatalogueInvalidation) {
      await trx.raw('SELECT pg_advisory_xact_lock(?)', [CATALOGUE_SOURCE_LOCK_KEY]);
    }
    // Read the before/after calculation signature while holding the same lock
    // as catalogue apply. In particular, toggling catalogueEnabled is only a
    // publication gate and must not invalidate otherwise current artefacts.
    const referenceRouteSignatureBefore = context.contentType.uid === REFERENCE_ROUTE_UID
      ? await publishedReferenceRouteCalculationSignature(strapi, context.params.documentId)
      : null;
    const result = await validateDocumentAndRunNext(strapi, context, next);
    if (needsCatalogueInvalidation) {
      const referenceRouteSignatureAfter = context.contentType.uid === REFERENCE_ROUTE_UID
        ? await publishedReferenceRouteCalculationSignature(strapi, context.params.documentId)
        : null;
      if (
        context.contentType.uid !== REFERENCE_ROUTE_UID
        || referenceRouteSignatureBefore !== referenceRouteSignatureAfter
      ) await invalidateCataloguePublicationFingerprints(strapi);
    }
    return result;
  });
}

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap({ strapi }: { strapi: Core.Strapi }) {
    strapi.documents.use((context, next) => (
      runDocumentMiddleware(strapi, context as DocumentMiddlewareContext, next)
    ));

    strapi.db.lifecycles.subscribe({
      models: SEO_CONTENT_TYPES,
      async beforeCreate(event) {
        await validateSeoShareImage(strapi, event);
      },
      async beforeUpdate(event) {
        await validateSeoShareImage(strapi, event);
      },
    });
  },
};
