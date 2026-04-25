export default ({ env }) => {
  const rawClientUrl = env('CLIENT_URL', 'http://localhost:3000');
  const clientUrl = rawClientUrl.replace(/\/$/, '');

  const envAllowedOrigins = env('PREVIEW_ALLOWED_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const allowedOrigins = Array.from(new Set([
    clientUrl,
    ...envAllowedOrigins,
    'http://localhost:3000',
    'https://localhost:3000',
    'http://localhost:8080',
    'https://localhost:8080',
  ]));

  const staticPathByUid: Record<string, string> = {
    'api::about.about': '/a-propos',
    'api::legal-notice.legal-notice': '/mentions-legales',
    'api::checkpoints-page.checkpoints-page': '/checkpoints',
    'api::homepage.homepage': '/',
  };

  const dynamicPathByUid: Record<string, { basePath: string }> = {
    'api::article.article': { basePath: '/article' },
    'api::chapter.chapter': { basePath: '/chapitres' },
    'api::author.author': { basePath: '/auteur' },
  };

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
        allowedOrigins,
        async handler(uid, { documentId, status }) {
          try {
            const staticPath = staticPathByUid[uid];
            if (staticPath) {
              const params = new URLSearchParams({
                url: staticPath,
                status: status || 'draft',
              });
              return `${clientUrl}/api/preview?${params.toString()}`;
            }

            const dynamicPath = dynamicPathByUid[uid];
            if (!dynamicPath) {
              return null;
            }

            const document = await strapi.documents(uid).findOne({ documentId });
            const slug = (document as Record<string, any> | null)?.slug;

            if (!slug) {
              return null;
            }

            const pathname = `${dynamicPath.basePath}/${slug}`;
            const params = new URLSearchParams({
              url: pathname,
              status: status || 'draft',
            });

            return `${clientUrl}/api/preview?${params.toString()}`;
          } catch (error) {
            strapi.log.error(`Preview handler error for ${uid}:`, error);
            return null;
          }
        },
      },
    },
  };
};
