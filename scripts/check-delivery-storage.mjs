import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { S3Client, HeadBucketCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const file = process.argv[2];
const inventory = process.argv[3] === '--inventory';
if (!file || process.argv.length > 4 || (process.argv[3] && !inventory)) {
  console.error('Usage: npm run delivery:storage:check -- /private/ovh-gthf.txt [--inventory]');
  process.exit(1);
}
let stage = 'credentials';
let uploaded = false;
let stagingVerified = false;
let client;
const bucket = 'gthf-staging-media-bis';
const key = '_delivery-probes/' + randomUUID() + '.txt';
try {
  const input = JSON.parse(await readFile(file, 'utf8'));
  if (!input.accessKey || !input.secretKey || typeof input.accessKey !== 'string' || typeof input.secretKey !== 'string') throw new Error('Invalid credentials');
  const credentials = { accessKeyId: input.accessKey, secretAccessKey: input.secretKey };
  client = new S3Client({ endpoint: 'https://s3.gra.io.cloud.ovh.net', region: 'gra', forcePathStyle: true, credentials, maxAttempts: 2 });
  stage = 'staging bucket access';
  await client.send(new HeadBucketCommand({ Bucket: bucket }));
  if (inventory) {
    stage = 'staging inventory';
    let continuation;
    let objects = 0;
    let bytes = 0;
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuation }));
      objects += page.Contents?.length ?? 0;
      bytes += (page.Contents ?? []).reduce((total, object) => total + (object.Size ?? 0), 0);
      continuation = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuation);
    console.log(JSON.stringify({ stagingBucket: bucket, objects, bytes, writes: 0 }));
  } else {
  stage = 'staging upload';
  const body = 'GTHF temporary staging storage verification\n';
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'text/plain', ACL: 'public-read', CacheControl: 'no-store' }));
  uploaded = true;
  stage = 'staging public media read';
  const response = await fetch(`https://${bucket}.s3.gra.io.cloud.ovh.net/${key}`, { redirect: 'error', signal: AbortSignal.timeout(20000) });
  if (!response.ok || await response.text() !== body) throw new Error('Media read failed');
  stage = 'staging probe cleanup';
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  uploaded = false;
  stagingVerified = true;
  stage = 'production bucket read access';
  const production = new S3Client({ endpoint: 'https://s3.eu-west-par.io.cloud.ovh.net', region: 'eu-west-par', forcePathStyle: true, credentials, maxAttempts: 2 });
  try {
    await production.send(new HeadBucketCommand({ Bucket: 'gthdf-staging-media' }));
  } finally {
    production.destroy();
  }
  console.log(JSON.stringify({ stagingBucket: bucket, stagingUploadReadDelete: 'passed', productionBucket: 'gthdf-staging-media', productionReadAccess: 'passed', productionWrites: 0 }));
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', stage, stagingUploadReadDelete: stagingVerified ? 'passed' : 'not verified', code: error?.name, httpStatus: error?.$metadata?.httpStatusCode, productionWrites: 0 }));
  process.exitCode = 1;
} finally {
  if (uploaded) {
    try { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); }
    catch { console.error(`Temporary staging probe requires cleanup: s3://${bucket}/${key}`); }
  }
  client?.destroy();
}
