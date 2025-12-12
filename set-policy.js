const { S3Client, PutBucketPolicyCommand } = require('@aws-sdk/client-s3');

const client = new S3Client({
  credentials: {
    accessKeyId: 'gthdf',
    secretAccessKey: 'gthdfpassword',
  },
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:9000',
  forcePathStyle: true,
});

const policy = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: ['arn:aws:s3:::gthdf-media/*']
    }
  ]
};

async function setPolicy() {
  try {
    await client.send(new PutBucketPolicyCommand({
      Bucket: 'gthdf-media',
      Policy: JSON.stringify(policy)
    }));
    console.log('✅ Policy applied!');
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

setPolicy();
