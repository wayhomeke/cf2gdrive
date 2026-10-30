#!/usr/bin/env bash
# Build the Cloudflare Pages deployment directory for cf2gdrive.
#
# Why this exists: the Pages Functions adapter at functions/[[path]].js
# imports ../src/index.js (the shared app also used by the Worker deploy).
# Pages' cloud-side build only sees the uploaded directory, so we bundle the
# adapter into a single self-contained ESM file and stage it as
# dist/functions/[[path]].js alongside the static assets from pages/.
#
# Usage: npm run build:pages   (then: wrangler pages deploy dist)
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist/functions

npx -y esbuild "functions/[[path]].js" \
  --bundle \
  --format=esm \
  --platform=neutral \
  --target=es2022 \
  --outfile="dist/functions/[[path]].js"

cp -R pages/. dist/

echo "built dist/ ->"
find dist -type f | sort
