import type { Core, Modules } from '@strapi/strapi';
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

const MAX_SHARE_IMAGE_SIZE_KB = 600;
const { ApplicationError } = errors;
const SEO_CONTENT_TYPES = [
  'api::article.article',
  'api::chapter.chapter',
  'api::city.city',
  'api::global.global',
  'api::homepage.homepage',
];
const CITY_UID = 'api::city.city';
const CHAPTER_UID = 'api::chapter.chapter';
const GLOBAL_UID = 'api::global.global';

// Valeur ASCII hexadécimale de « GTHF », réservée dans cette base PostgreSQL
// à la sérialisation transactionnelle de l’ensemble des chapitres publiés.
export const CHAPTER_PUBLICATION_LOCK_KEY = 0x47544846;

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

export async function runDocumentMiddleware(
  strapi: Core.Strapi,
  context: DocumentMiddlewareContext,
  next: DocumentMiddlewareNext
): DocumentMiddlewareResult {
  if (!changesPublishedChapterSet(context)) {
    return validateDocumentAndRunNext(strapi, context, next);
  }

  return strapi.db.transaction(async ({ trx }) => {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(?)',
      [CHAPTER_PUBLICATION_LOCK_KEY]
    );
    return validateDocumentAndRunNext(strapi, context, next);
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
