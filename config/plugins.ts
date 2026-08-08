export default ({ env }) => {
  // Use Cellar only in production (when NODE_ENV is production)
  const useCleverCloudCellar = env('NODE_ENV') === 'production' && env('CELLAR_ADDON_HOST');

  return {
    upload: {
      config: {
        provider: 'aws-s3',
        providerOptions: {
          baseUrl: useCleverCloudCellar
            ? `https://${env('CELLAR_ADDON_HOST')}/${env('AWS_BUCKET', 'gthdf-media')}`
            : env('AWS_CDN_URL'),
          s3Options: {
            credentials: {
              accessKeyId: useCleverCloudCellar 
                ? env('CELLAR_ADDON_KEY_ID')
                : env('AWS_ACCESS_KEY_ID'),
              secretAccessKey: useCleverCloudCellar
                ? env('CELLAR_ADDON_KEY_SECRET')
                : env('AWS_SECRET_ACCESS_KEY'),
            },
            region: env('AWS_REGION', 'us-east-1'),
            endpoint: useCleverCloudCellar
              ? `https://${env('CELLAR_ADDON_HOST')}`
              : env('AWS_ENDPOINT'),
            forcePathStyle: true,
            tls: useCleverCloudCellar ? true : false,
            bucketEndpoint: false,
            params: {
              Bucket: env('AWS_BUCKET', 'gthdf-media'),
            },
          },
        },
        sizeLimit: 10 * 1024 * 1024, // 10MB
        mimeTypes: [
          'image/jpeg',
          'image/png',
          'image/gif',
          'image/svg+xml',
          'image/webp',
          'application/pdf',
          'application/gpx+xml',
          'application/json',
          'application/xml',
          'text/xml',
        ],
      },
    },
  };
};
