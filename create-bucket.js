const { S3Client, CreateBucketCommand, ListBucketsCommand } = require('@aws-sdk/client-s3');

const client = new S3Client({
  credentials: {
    accessKeyId: 'gthdf',
    secretAccessKey: 'gthdfpassword',
  },
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:9000',
  forcePathStyle: true,
});

async function createBucket() {
  try {
    console.log('Creating bucket via S3 API...');
    await client.send(new CreateBucketCommand({
      Bucket: 'gthdf-media',
    }));
    console.log('✅ Bucket created!');

    const list = await client.send(new ListBucketsCommand({}));
    console.log('✅ Buckets:', list.Buckets.map(b => b.Name));
  } catch (error) {
    console.error('❌ Error:', error.message, error.Code);
  }
}

createBucket();
