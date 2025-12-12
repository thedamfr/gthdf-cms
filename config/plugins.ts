export default ({ env }) => ({
  upload: {
    config: {
      provider: 'aws-s3',
      providerOptions: {
        baseUrl: env('AWS_CDN_URL'),
        s3Options: {
          credentials: {
            accessKeyId: env('AWS_ACCESS_KEY_ID'),
            secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
          },
          region: env('AWS_REGION', 'us-east-1'),
          endpoint: env('AWS_ENDPOINT'),
          forcePathStyle: true,
          tls: false,
          bucketEndpoint: false,
        },
        params: {
          Bucket: env('AWS_BUCKET'),
        },
      },
      sizeLimit: 10 * 1024 * 1024, // 10MB
    },
  },
});