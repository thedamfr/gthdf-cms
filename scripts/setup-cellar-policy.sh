#!/bin/bash

# Script to configure Cellar bucket policy using s3cmd
# Usage: ./scripts/setup-cellar-policy.sh

set -e

# Load .env
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)
fi

CELLAR_HOST=${CELLAR_ADDON_HOST:-"cellar-c2.services.clever-cloud.com"}
CELLAR_KEY_ID=${CELLAR_ADDON_KEY_ID}
CELLAR_KEY_SECRET=${CELLAR_ADDON_KEY_SECRET}
BUCKET_NAME=${AWS_BUCKET:-"gthdf-media"}

echo "🔓 Configuring Cellar bucket policy with s3cmd..."
echo ""
echo "📊 Configuration:"
echo "  Host: $CELLAR_HOST"
echo "  Bucket: $BUCKET_NAME"
echo "  Key ID: ${CELLAR_KEY_ID:0:8}..."
echo ""

# Create policy file
cat > /tmp/cellar-policy.json << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${BUCKET_NAME}/*"
    }
  ]
}
EOF

echo "📝 Policy file created:"
cat /tmp/cellar-policy.json
echo ""

# Apply policy with s3cmd
echo "⚙️  Applying policy to bucket..."
s3cmd setpolicy /tmp/cellar-policy.json s3://${BUCKET_NAME} \
  --host=https://${CELLAR_HOST} \
  --host-bucket=https://${CELLAR_HOST}/${BUCKET_NAME} \
  --access_key=${CELLAR_KEY_ID} \
  --secret_key=${CELLAR_KEY_SECRET} \
  --ssl

echo ""
echo "✅ Policy applied successfully!"
echo ""
echo "🧪 Test public access with:"
echo "   curl https://${CELLAR_HOST}/${BUCKET_NAME}/[filename]"
echo ""

# Clean up
rm -f /tmp/cellar-policy.json
