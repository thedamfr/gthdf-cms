#!/bin/bash

# Clever Cloud post-build hook for Strapi
echo "=== Running Strapi build ==="
npm run build

echo "=== Strapi build completed ==="
