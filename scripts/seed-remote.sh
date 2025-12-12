#!/bin/bash

# Script pour seeder la base PostgreSQL distante sur Clever Cloud
# Usage: ./scripts/seed-remote.sh

set -e  # Exit on error

echo "=== Seeding Remote PostgreSQL Database ==="
echo ""

# Load .env file to get credentials
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | grep -v '^$' | xargs)
fi

# Use Clever Cloud addon variables if available, otherwise fallback to custom names
DATABASE_HOST_REMOTE=${DATABASE_HOST_REMOTE:-$POSTGRESQL_ADDON_HOST_REMOTE}
DATABASE_PORT_REMOTE=${DATABASE_PORT_REMOTE:-$POSTGRESQL_ADDON_PORT_REMOTE}
DATABASE_NAME_REMOTE=${DATABASE_NAME_REMOTE:-$POSTGRESQL_ADDON_DB_REMOTE}
DATABASE_USERNAME_REMOTE=${DATABASE_USERNAME_REMOTE:-$POSTGRESQL_ADDON_USER_REMOTE}
DATABASE_PASSWORD_REMOTE=${DATABASE_PASSWORD_REMOTE:-$POSTGRESQL_ADDON_PASSWORD_REMOTE}

# Check if required environment variables are set
if [ -z "$DATABASE_HOST_REMOTE" ] || [ -z "$DATABASE_NAME_REMOTE" ] || [ -z "$DATABASE_USERNAME_REMOTE" ] || [ -z "$DATABASE_PASSWORD_REMOTE" ]; then
  echo "❌ Error: Remote database environment variables not set"
  echo ""
  echo "Please set the following variables:"
  echo "  - DATABASE_HOST_REMOTE"
  echo "  - DATABASE_PORT_REMOTE (default: 5432)"
  echo "  - DATABASE_NAME_REMOTE"
  echo "  - DATABASE_USERNAME_REMOTE"
  echo "  - DATABASE_PASSWORD_REMOTE"
  echo ""
  echo "Example:"
  echo "  export DATABASE_HOST_REMOTE=your-db-host.clever-cloud.com"
  echo "  export DATABASE_PORT_REMOTE=5432"
  echo "  export DATABASE_NAME_REMOTE=your_db_name"
  echo "  export DATABASE_USERNAME_REMOTE=your_username"
  echo "  export DATABASE_PASSWORD_REMOTE=your_password"
  echo ""
  exit 1
fi

# Set default port if not provided
DATABASE_PORT_REMOTE=${DATABASE_PORT_REMOTE:-5432}

echo "📊 Database Configuration:"
echo "  Host: $DATABASE_HOST_REMOTE"
echo "  Port: $DATABASE_PORT_REMOTE"
echo "  Database: $DATABASE_NAME_REMOTE"
echo "  Username: $DATABASE_USERNAME_REMOTE"
echo ""

# Backup current .env
if [ -f .env ]; then
  echo "💾 Backing up current .env to .env.backup..."
  cp .env .env.backup
fi

# Create temporary .env with remote database config
echo "🔧 Creating temporary .env with remote database configuration..."
cat > .env.remote << EOF
# Server
HOST=0.0.0.0
PORT=1337

# Secrets (copy from your .env)
APP_KEYS=${APP_KEYS}
API_TOKEN_SALT=${API_TOKEN_SALT}
ADMIN_JWT_SECRET=${ADMIN_JWT_SECRET}
TRANSFER_TOKEN_SALT=${TRANSFER_TOKEN_SALT}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
JWT_SECRET=${JWT_SECRET}

# Remote Database
DATABASE_CLIENT=postgres
DATABASE_HOST=${DATABASE_HOST_REMOTE}
DATABASE_PORT=${DATABASE_PORT_REMOTE}
DATABASE_NAME=${DATABASE_NAME_REMOTE}
DATABASE_USERNAME=${DATABASE_USERNAME_REMOTE}
DATABASE_PASSWORD=${DATABASE_PASSWORD_REMOTE}
DATABASE_SSL=true

# S3/MinIO Upload (use production values if different)
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-gthdf}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-gthdfpassword}
AWS_REGION=${AWS_REGION:-us-east-1}
AWS_ENDPOINT=${AWS_ENDPOINT_REMOTE:-${AWS_ENDPOINT}}
AWS_BUCKET=${AWS_BUCKET:-gthdf-media}
AWS_CDN_URL=${AWS_CDN_URL_REMOTE:-${AWS_CDN_URL}}
EOF

# Replace .env temporarily
mv .env .env.local
mv .env.remote .env

echo ""
echo "🌱 Running seed script against remote database..."
echo ""

# Run the seed script
node scripts/seed.js

# Check exit code
SEED_EXIT_CODE=$?

# Restore original .env
echo ""
echo "♻️  Restoring original .env..."
mv .env .env.remote
mv .env.local .env

if [ $SEED_EXIT_CODE -eq 0 ]; then
  echo ""
  echo "✅ Remote database seeded successfully!"
  echo ""
  echo "🗑️  Cleaning up temporary files..."
  rm -f .env.remote .env.backup
  echo ""
  echo "✨ Done!"
else
  echo ""
  echo "❌ Seed script failed with exit code $SEED_EXIT_CODE"
  echo ""
  echo "Your local .env has been restored."
  echo "Temporary config saved in .env.remote for debugging."
  exit $SEED_EXIT_CODE
fi
