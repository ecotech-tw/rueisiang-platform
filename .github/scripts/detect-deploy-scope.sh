#!/usr/bin/env bash
set -euo pipefail

output_file="${1:?output file is required}"
platform=false
migrations=false
hr=false

while IFS= read -r path; do
  case "$path" in
    apps/api/*|apps/portal/*|packages/assistant/*|packages/auth/*|packages/config/*|packages/cyberbiz/*|packages/db/src/*|packages/db/package.json|packages/db/tsconfig.json|packages/db/drizzle.config.ts|packages/tools/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|turbo.json|.github/workflows/deploy.yml|.github/scripts/deploy-baseline.mjs|.github/scripts/detect-deploy-scope.sh)
      platform=true ;;
  esac
  case "$path" in
    packages/db/migrations/*)
      migrations=true ;;
  esac
  case "$path" in
    apps/hr/*|packages/auth/*|packages/config/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|turbo.json|.github/workflows/deploy.yml|.github/scripts/deploy-baseline.mjs|.github/scripts/detect-deploy-scope.sh)
      hr=true ;;
  esac
done

{
  echo "platform=$platform"
  echo "migrations=$migrations"
  echo "hr=$hr"
} >> "$output_file"
