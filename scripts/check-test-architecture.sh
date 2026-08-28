#!/usr/bin/env bash
set -Eeuo pipefail

failed=0

fail() {
  printf 'TEST ARCHITECTURE: %s\n' "$1" >&2
  failed=1
}

while IFS= read -r path; do
  [[ -z "$path" ]] && continue
  fail "chronological/catch-all test filename is forbidden: ${path}"
done < <(find tests apps/web/tests -type f \(
  -name 'milestone*.test.ts' -o -name 'milestone*.spec.ts' -o
  -name '*corrections.test.ts' -o -name '*corrections.spec.ts' -o
  -name 'misc*.test.ts' -o -name 'misc*.spec.ts' -o
  -name 'regression*.test.ts' -o -name 'regression*.spec.ts'
\) -print)

browser_forbidden='\.toHaveCSS\(|\.toHaveClass\(|boundingBox\(|getComputedStyle\('
if matches="$(grep -RInE --include='*.spec.ts' "$browser_forbidden" apps/web/tests/e2e || true)"; [[ -n "$matches" ]]; then
  printf '%s\n' "$matches" >&2
  fail 'Playwright must assert user/browser behavior, not CSS classes, computed styles or pixel geometry.'
fi

repository_grep="readFile\\([[:space:]]*['\"](package\\.json|compose(\\.smoke)?\\.ya?ml|migrations/)"
if matches="$(grep -RInE --include='*.test.ts' "$repository_grep" tests/unit apps/web/tests/unit || true)"; [[ -n "$matches" ]]; then
  printf '%s\n' "$matches" >&2
  fail 'unit tests must not grep tracked package/Compose/migration source; use repository contracts or integration tests.'
fi

while IFS= read -r path; do
  lines="$(wc -l < "$path")"
  if (( lines > 600 )); then
    fail "unit test file is too broad (${lines} lines): ${path}"
  fi
done < <(find tests/unit apps/web/tests/unit -type f -name '*.test.ts' -print)

while IFS= read -r path; do
  lines="$(wc -l < "$path")"
  case "$path" in
    tests/integration/postgres.test.ts) max_lines=1750 ;;
    tests/integration/aggregation-retention.test.ts) max_lines=1325 ;;
    *) max_lines=800 ;;
  esac
  if (( lines > max_lines )); then
    fail "integration test file exceeded its architecture budget (${lines} > ${max_lines} lines): ${path}"
  fi
done < <(find tests/integration -type f -name '*.test.ts' -print)

while IFS= read -r path; do
  lines="$(wc -l < "$path")"
  if (( lines > 250 )); then
    fail "browser spec is too broad (${lines} lines); split by user/browser behavior: ${path}"
  fi
done < <(find apps/web/tests/e2e -type f -name '*.spec.ts' -print)

if (( failed != 0 )); then
  exit 1
fi

printf 'Test architecture contract passed.\n'
