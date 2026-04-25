import type { Core } from '@strapi/strapi';
import { errors } from '@strapi/utils';

const MAX_SHARE_IMAGE_SIZE_KB = 600;
const { ApplicationError } = errors;
const SEO_CONTENT_TYPES = [
  'api::article.article',
  'api::chapter.chapter',
  'api::global.global',
  'api::homepage.homepage',
];

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
    strapi.documents.use(async (context, next) => {
      const documentParams = context.params as {
        data?: Record<string, unknown>;
        documentId?: string;
      };

      if (!SEO_CONTENT_TYPES.includes(context.contentType.uid)) {
        return next();
      }

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

      return next();
    });

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
