function getPreviewPathname(uid: string, document: Record<string, any> | null) {
  const slug = document?.slug;

  switch (uid) {
    case 'api::article.article':
      return slug ? `/article/${slug}` : '/blog';

    case 'api::chapter.chapter':
      return slug ? `/chapitres/${slug}` : '/chapitres';

    case 'api::author.author':
      return slug ? `/auteur/${slug}` : null;

    case 'api::about.about':
      return '/a-propos';

    case 'api::legal-notice.legal-notice':
      return '/mentions-legales';

    case 'api::checkpoints-page.checkpoints-page':
      return '/checkpoints';

    case 'api::homepage.homepage':
      return '/';

    default:
      return null;
  }
}

export default ({ env }) => {
  const clientUrl = env('CLIENT_URL', 'https://gthf.fr');

  return {
    auth: {
      secret: env('ADMIN_JWT_SECRET'),
    },
    apiToken: {
      salt: env('API_TOKEN_SALT'),
    },
    transfer: {
      token: {
        salt: env('TRANSFER_TOKEN_SALT'),
      },
    },
    secrets: {
      encryptionKey: env('ENCRYPTION_KEY'),
    },
    flags: {
      nps: env.bool('FLAG_NPS', true),
      promoteEE: env.bool('FLAG_PROMOTE_EE', true),
    },
    preview: {
      enabled: true,
      config: {
        allowedOrigins: [clientUrl],
        async handler(uid, { documentId, status }) {
          const document = await strapi.documents(uid).findOne({ documentId });
          const pathname = getPreviewPathname(uid, document as Record<string, any> | null);

          if (!pathname) {
            return null;
          }

          const params = new URLSearchParams({
            url: pathname,
            status,
          });

          return `${clientUrl}/api/preview?${params.toString()}`;
        },
      },
    },
  };
};
