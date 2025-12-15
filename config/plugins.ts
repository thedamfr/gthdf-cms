export default ({ env }) => ({
  upload: {
    config: {
      provider: 'aws-s3',
      providerOptions: {
        baseUrl: env('CELLAR_ADDON_HOST') 
          ? `https://${env('CELLAR_ADDON_HOST')}/${env('AWS_BUCKET', 'gthdf-media')}`
          : env('AWS_CDN_URL'),
        s3Options: {
          credentials: {
            accessKeyId: env('CELLAR_ADDON_KEY_ID') || env('AWS_ACCESS_KEY_ID'),
            secretAccessKey: env('CELLAR_ADDON_KEY_SECRET') || env('AWS_SECRET_ACCESS_KEY'),
          },
          region: env('AWS_REGION', 'us-east-1'),
          endpoint: env('CELLAR_ADDON_HOST') 
            ? `https://${env('CELLAR_ADDON_HOST')}`
            : env('AWS_ENDPOINT'),
          forcePathStyle: true,
          tls: env('CELLAR_ADDON_HOST') ? true : false,
          bucketEndpoint: false,
        },
        params: {
          Bucket: env('AWS_BUCKET', 'gthdf-media'),
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
        'application/xml',
        'text/xml',
      ],
    },
  },
});