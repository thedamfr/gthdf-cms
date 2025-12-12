#!/usr/bin/env node

/**
 * Script to initialize Cellar (Clever Cloud S3) bucket for Strapi uploads
 * Usage: node scripts/setup-cellar.js
 */

import { S3Client, CreateBucketCommand, ListBucketsCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const CELLAR_HOST = process.env.CELLAR_ADDON_HOST || 'cellar-c2.services.clever-cloud.com';
const CELLAR_KEY_ID = process.env.CELLAR_ADDON_KEY_ID;
const CELLAR_KEY_SECRET = process.env.CELLAR_ADDON_KEY_SECRET;
const BUCKET_NAME = process.env.AWS_BUCKET || 'gthdf-media';
const REGION = process.env.AWS_REGION || 'us-east-1';

// Validate required environment variables
if (!CELLAR_KEY_ID || !CELLAR_KEY_SECRET) {
  console.error('❌ Error: Cellar credentials not found in .env');
  console.error('Required variables:');
  console.error('  - CELLAR_ADDON_KEY_ID');
  console.error('  - CELLAR_ADDON_KEY_SECRET');
  process.exit(1);
}

// Configure S3 client for Cellar
const s3Client = new S3Client({
  endpoint: `https://${CELLAR_HOST}`,
  region: REGION,
  credentials: {
    accessKeyId: CELLAR_KEY_ID,
    secretAccessKey: CELLAR_KEY_SECRET,
  },
  forcePathStyle: true,
});

console.log('🚀 Initializing Cellar (Clever Cloud S3)...\n');
console.log('📊 Configuration:');
console.log(`  Endpoint: https://${CELLAR_HOST}`);
console.log(`  Region: ${REGION}`);
console.log(`  Bucket: ${BUCKET_NAME}`);
console.log(`  Key ID: ${CELLAR_KEY_ID.substring(0, 8)}...`);
console.log('');

async function listBuckets() {
  try {
    const command = new ListBucketsCommand({});
    const response = await s3Client.send(command);
    return response.Buckets || [];
  } catch (error) {
    console.error('❌ Error listing buckets:', error.message);
    throw error;
  }
}

async function createBucket(bucketName) {
  try {
    const command = new CreateBucketCommand({
      Bucket: bucketName,
    });
    await s3Client.send(command);
    console.log(`✅ Bucket "${bucketName}" created successfully`);
  } catch (error) {
    if (error.name === 'BucketAlreadyOwnedByYou' || error.Code === 'BucketAlreadyOwnedByYou') {
      console.log(`ℹ️  Bucket "${bucketName}" already exists and is owned by you`);
    } else if (error.name === 'BucketAlreadyExists' || error.Code === 'BucketAlreadyExists') {
      console.error(`❌ Bucket "${bucketName}" already exists and is owned by someone else`);
      throw error;
    } else {
      console.error('❌ Error creating bucket:', error.message);
      throw error;
    }
  }
}

async function setBucketPolicy(bucketName) {
  console.log('ℹ️  Note: Cellar bucket policies may need to be configured via Clever Cloud console');
  console.log('   For public access, you can:');
  console.log('   1. Use signed URLs (default Strapi behavior)');
  console.log('   2. Configure bucket policy in Clever Cloud console');
  console.log('   3. Use a CDN in front of Cellar');
  console.log('');
  
  // Cellar doesn't support PutBucketPolicy API
  // Policy must be configured via Clever Cloud console
  console.log('⚠️  Skipping automatic policy configuration (not supported by Cellar)');
  return;
}

async function main() {
  try {
    // List existing buckets
    console.log('📋 Listing existing buckets...');
    const buckets = await listBuckets();
    console.log(`Found ${buckets.length} bucket(s):`);
    buckets.forEach((bucket) => {
      console.log(`  - ${bucket.Name}`);
    });
    console.log('');

    // Check if bucket already exists
    const bucketExists = buckets.some((b) => b.Name === BUCKET_NAME);

    if (!bucketExists) {
      // Create bucket
      console.log(`🪣 Creating bucket "${BUCKET_NAME}"...`);
      await createBucket(BUCKET_NAME);
      console.log('');
    } else {
      console.log(`ℹ️  Bucket "${BUCKET_NAME}" already exists`);
      console.log('');
    }

    // Set public read policy
    console.log('🔓 Bucket policy configuration...');
    setBucketPolicy(BUCKET_NAME);
    console.log('');

    // Display CDN URL
    const cdnUrl = `https://${CELLAR_HOST}/${BUCKET_NAME}`;
    console.log('✨ Cellar setup complete!');
    console.log('');
    console.log('📝 Update your .env with:');
    console.log(`AWS_ACCESS_KEY_ID=${CELLAR_KEY_ID}`);
    console.log(`AWS_SECRET_ACCESS_KEY=${CELLAR_KEY_SECRET}`);
    console.log(`AWS_REGION=${REGION}`);
    console.log(`AWS_ENDPOINT=https://${CELLAR_HOST}`);
    console.log(`AWS_BUCKET=${BUCKET_NAME}`);
    console.log(`AWS_CDN_URL=${cdnUrl}`);
    console.log('');
    console.log('🌐 Your files will be accessible at:');
    console.log(`   ${cdnUrl}/[filename]`);

  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    process.exit(1);
  }
}

main();
