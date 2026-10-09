#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
scope_script="$script_dir/detect-deploy-scope.sh"

run_case() {
  local name="$1"
  local expected="$2"
  shift 2
  local output
  output="$(mktemp)"
  trap 'rm -f "$output"' RETURN
  printf '%s\n' "$@" | bash "$scope_script" "$output"
  actual="$(cat "$output")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Deploy scope case failed: %s\nExpected:\n%s\nActual:\n%s\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

run_case \
  "platform" \
  $'platform=true\nmigrations=false\nhr=false' \
  "apps/portal/src/App.tsx"
run_case \
  "migration" \
  $'platform=false\nmigrations=true\nhr=false' \
  "packages/db/migrations/0202_new_table.sql"
run_case \
  "hr static worker" \
  $'platform=false\nmigrations=false\nhr=true' \
  "apps/hr/src/main.tsx"
run_case \
  "shared auth" \
  $'platform=true\nmigrations=false\nhr=true' \
  "packages/auth/src/permissions.ts"
run_case \
  "irrelevant documentation" \
  $'platform=false\nmigrations=false\nhr=false' \
  "docs/architecture.md"
run_case \
  "deploy workflow" \
  $'platform=true\nmigrations=false\nhr=true' \
  ".github/workflows/deploy.yml"
run_case \
  "deploy baseline script" \
  $'platform=true\nmigrations=false\nhr=true' \
  ".github/scripts/deploy-baseline.mjs"
run_case \
  "deploy scope script" \
  $'platform=true\nmigrations=false\nhr=true' \
  ".github/scripts/detect-deploy-scope.sh"
