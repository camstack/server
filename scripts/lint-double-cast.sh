#!/bin/bash
# Lint: find all double-cast patterns (as unknown as, as any as) in production code
# Run: ./scripts/lint-double-cast.sh
# Returns exit code 1 if violations found

violations=$(grep -rn " as unknown as \| as any as " --include="*.ts" --include="*.tsx" \
  packages/ server/backend/src/ \
  | grep -v "node_modules\|dist/\|__tests__\|\.spec\.\|\.test\.\|\.d\.ts\|TECH-DEBT:")

if [ -n "$violations" ]; then
  echo "❌ Double-cast violations found (as unknown as / as any as):"
  echo "$violations"
  echo ""
  echo "Fix: use type guards, generics, or fix the underlying interface."
  echo "If unavoidable: add // TECH-DEBT: reason to the line."
  count=$(echo "$violations" | wc -l | tr -d ' ')
  echo "Total: $count violation(s)"
  exit 1
else
  echo "✅ No double-cast violations found"
  exit 0
fi
