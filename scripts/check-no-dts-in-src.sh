#!/usr/bin/env bash
# Fails if non-ambient .d.ts files are present in packages/*/src.
# Prevents leakage from vite-plugin-dts / tsup misconfigs.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

AMBIENT=(
  "packages/addon-post-analysis/src/embedding-encoder/shared/onnxruntime.d.ts"
  "packages/addon-provider-onvif/src/onvif.d.ts"
  "packages/addon-admin-ui/src/vite-env.d.ts"
  "packages/addon-agent-ui/src/vite-env.d.ts"
  "packages/addon-benchmark/src/vite-env.d.ts"
  "packages/werift-turn-fix/src/node-turn.d.ts"
  "packages/addon-pipeline/embed/src/scrub/mp4box.d.ts"
  # The server-side twin of the shim above: src and embed are separate tsconfig
  # projects and cannot share a declaration, so both exist on purpose.
  "packages/addon-pipeline/src/recorder/scrub/mp4box.d.ts"
  # The `onvif` package ships no types; hikvision uses WS-Discovery from it too
  # and carries its own minimal shim, as addon-provider-onvif does above.
  "packages/addon-provider-hikvision/src/onvif.d.ts"
  # Third WS-Discovery consumer of the untyped `onvif` package, same shim as
  # its two siblings above. Untracked until 2026-08-20: .gitignore swallowed
  # it and every CI run failed amcrest's typecheck while local trees passed.
  "packages/addon-provider-amcrest/src/onvif.d.ts"
  # Standard vite client-types ambients, same as the three tracked above.
  "packages/addon-model-studio/src/vite-env.d.ts"
  "packages/addon-osd-manager/src/vite-env.d.ts"
  "packages/cli/src/server-entry.d.ts"
  # lucide-react ships no types for its per-icon index module (D854, icon-glyphs.ts).
  "packages/ui-library/src/lucide-icons-module.d.ts"
)

leaks=()
while IFS= read -r f; do
  ok=false
  for a in "${AMBIENT[@]}"; do
    [ "$f" = "$a" ] && { ok=true; break; }
  done
  $ok || leaks+=("$f")
done < <(find packages -path '*/src/*.d.ts' -not -path '*/node_modules/*' 2>/dev/null | sort)

if [ "${#leaks[@]}" -gt 0 ]; then
  echo "::error::Found ${#leaks[@]} leaked .d.ts files in packages/*/src — should only be ambient declarations" >&2
  for l in "${leaks[@]}"; do echo "  - $l" >&2; done
  echo
  echo "If these are intentional ambient declarations, add them to the AMBIENT array in this script." >&2
  echo "Otherwise, the originating build tool needs its outDirs/outDir set to dist (see Bug-1 fix history)." >&2
  exit 1
fi

echo "✓ No leaked .d.ts files in packages/*/src (only ${#AMBIENT[@]} ambient declarations present)"
