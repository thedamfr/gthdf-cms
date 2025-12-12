const { S3Client, ListBucketsCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const client = new S3Client({
  credentials: {
    accessKeyId: 'gthdf',
    secretAccessKey: 'gthdfpassword',
  },
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:9000',
  forcePathStyle: true,
  tls: false,
});

async function test() {
  try {
    console.log('1. Testing list buckets...');
    const listResult = await client.send(new ListBucketsCommand({}));
    console.log('✅ Buckets:', listResult.Buckets.map(b => b.Name));

    console.log('\n2. Testing upload to gthdf-media...');
    const uploadResult = await client.send(new PutObjectCommand({
      Bucket: 'gthdf-media',
      Key: 'test-from-node.txt',
      Body: 'Hello from Node.js!',
    }));
    console.log('✅ Upload success:', uploadResult);

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error('Code:', error.Code);
    console.error('Endpoint used:', error.$metadata);
  }
}

test();
