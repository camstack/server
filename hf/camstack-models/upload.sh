#!/usr/bin/env bash
# Upload the licence files of the Hugging Face model mirror camstack/camstack-models.
#
# ADDS FILES ONLY. It never deletes (no --delete is ever passed) and it refuses to
# overwrite a path that already exists on the Hub unless that path is in the
# approved REPLACE list below or named with --replace. What it uploads, and nothing else:
#   README.md, LICENSE, <category>/<model>/README.md   from hf/camstack-models/
#   LICENSES/*.txt                                     from licenses/models/
#   THIRD_PARTY_MODELS.md                              from the repo root
#   source/README.md                                   from hf/camstack-models/source/
#   source/build-camstack-models.py, source/export-models.py   from scripts/
#   source/convert_lib.py, source/requirements.txt     from packages/addon-model-studio/python/
# A staged file byte-identical to the Hub copy is dropped from the upload, so an
# unchanged path is never a clash and never a no-op commit.
#
# Usage (from anywhere inside the repo):
#   hf/camstack-models/upload.sh                 # dry run: stage, compare with the Hub, print the plan
#   hf/camstack-models/upload.sh --upload        # stage, compare, upload in ONE commit
#   hf/camstack-models/upload.sh --upload --replace <path>   # also replace <path> (operator approval needed)
#
# Token: HF_TOKEN from the environment if set, else from server/backend/.env
# (override the file with CAMSTACK_ENV_FILE). The token is never printed.
set -euo pipefail

REPO_ID="camstack/camstack-models"
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
SRC="$ROOT/hf/camstack-models"
ENV_FILE="${CAMSTACK_ENV_FILE:-$ROOT/server/backend/.env}"

DO_UPLOAD=0
# Paths the operator approved replacing on the Hub (read first, content kept in
# the new card). Anything else that already exists is refused.
#   2026-09-26: packageDetection/rfdetr-package/README.md (a two-line README)
REPLACE=("packageDetection/rfdetr-package/README.md")
while [ $# -gt 0 ]; do
  case "$1" in
    --upload) DO_UPLOAD=1 ;;
    --replace) shift; REPLACE+=("${1:?--replace needs a path}") ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/camstack-hf-cards.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

# ── Stage ────────────────────────────────────────────────────────────────────
cp "$SRC/README.md" "$SRC/LICENSE" "$STAGE/"
cp "$ROOT/THIRD_PARTY_MODELS.md" "$STAGE/"
mkdir -p "$STAGE/LICENSES"
cp "$ROOT"/licenses/models/*.txt "$STAGE/LICENSES/"
( cd "$SRC" && find . -mindepth 3 -maxdepth 3 -name README.md -print ) | while read -r card; do
  mkdir -p "$STAGE/$(dirname "$card")"
  cp "$SRC/$card" "$STAGE/$card"
done
# The AGPL Corresponding Source for the Ultralytics-derived weights (see the
# source offer in THIRD_PARTY_MODELS.md). The build script finds convert_lib.py
# as a sibling, so these are verbatim copies of the repository files.
mkdir -p "$STAGE/source"
cp "$SRC/source/README.md" "$STAGE/source/"
cp "$ROOT/scripts/build-camstack-models.py" "$ROOT/scripts/export-models.py" "$STAGE/source/"
cp "$ROOT/packages/addon-model-studio/python/convert_lib.py" \
   "$ROOT/packages/addon-model-studio/python/requirements.txt" "$STAGE/source/"
STAGED="$(cd "$STAGE" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)"
echo "Staged $(echo "$STAGED" | wc -l | tr -d ' ') files in $STAGE"

# ── Paths this script must never write, whatever the flags ───────────────────
# faceDetection/yunet/README.md is YuNet's own card, uploaded with its weights
# (HF commit 3161a530b996b9dd716738991e2a3b59cd07c014) from scripts/build-yunet-model.py.
# clip/siglip2/README.md is SigLIP 2's own card, uploaded with its weights by
# scripts/build-siglip2-model.py --upload (D649).
# plateDetection/yolox-tiny-plate/README.md is the open-lpr detector's own card,
# uploaded with its weights, LICENSE and NOTICE from scripts/build-yolox-plate-model.py (D719).
NEVER=("faceDetection/yunet/README.md" "clip/siglip2/README.md" "plateDetection/yolox-tiny-plate/README.md")
for n in "${NEVER[@]}"; do
  if printf '%s\n' "$STAGED" | grep -qxF "$n"; then
    echo "Refusing: $n is owned by another upload and must not be written here." >&2
    exit 1
  fi
done

# ── Compare with the Hub: never overwrite unless asked by name ───────────────
REMOTE="$(curl -fsS "https://huggingface.co/api/models/$REPO_ID/tree/main?recursive=true" \
  | python3 -c 'import sys,json; [print(e["path"]) for e in json.load(sys.stdin) if e["type"]=="file"]')"
CLASH=()
while read -r p; do
  if printf '%s\n' "$REMOTE" | grep -qxF "$p"; then
    if curl -fsSL "https://huggingface.co/$REPO_ID/resolve/main/$p" | cmp -s - "$STAGE/$p"; then
      echo "  unchanged: $p"
      rm "$STAGE/$p"
      continue
    fi
    allowed=0
    for r in "${REPLACE[@]+"${REPLACE[@]}"}"; do [ "$r" = "$p" ] && allowed=1; done
    if [ "$allowed" = 1 ]; then echo "  replace (asked): $p"; else CLASH+=("$p"); fi
  else
    echo "  add: $p"
  fi
done <<< "$STAGED"
if [ "${#CLASH[@]}" -gt 0 ]; then
  echo "Refusing: these paths already exist on the Hub and were not named with --replace:" >&2
  printf '  %s\n' "${CLASH[@]}" >&2
  echo "Read the Hub copy first (https://huggingface.co/$REPO_ID/blob/main/<path>), then re-run with --replace <path>." >&2
  exit 1
fi

# ── The source-offer premise ─────────────────────────────────────────────────
# THIRD_PARTY_MODELS.md names the mirror's source/ folder as the AGPL
# Corresponding Source. It must be in the staged notice, and either already
# public or about to be uploaded by this run.
SOURCE_URL="https://huggingface.co/$REPO_ID/tree/main/source"
grep -qF "$SOURCE_URL" "$ROOT/THIRD_PARTY_MODELS.md" \
  || { echo "Refusing: THIRD_PARTY_MODELS.md does not name $SOURCE_URL as the Corresponding Source." >&2; exit 1; }
SRC_STATUS="$(curl -sL -o /dev/null -w '%{http_code}' "https://huggingface.co/$REPO_ID/resolve/main/source/build-camstack-models.py" || true)"
if [ "$SRC_STATUS" != "200" ] && [ ! -f "$STAGE/source/build-camstack-models.py" ]; then
  echo "WARNING: $SOURCE_URL answers $SRC_STATUS for build-camstack-models.py, but the source offer in THIRD_PARTY_MODELS.md points there." >&2
fi

if [ -z "$(find "$STAGE" -type f -print -quit)" ]; then
  echo "Nothing to upload: every staged file matches the Hub."
  exit 0
fi

if [ "$DO_UPLOAD" != 1 ]; then
  echo "Dry run only. Re-run with --upload to commit these files to $REPO_ID."
  exit 0
fi

# ── Upload (one commit, additive) ────────────────────────────────────────────
if [ -z "${HF_TOKEN:-}" ]; then
  [ -r "$ENV_FILE" ] || { echo "no HF_TOKEN in the environment and $ENV_FILE is not readable" >&2; exit 1; }
  HF_TOKEN="$(grep -E '^HF_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"'\'' \r')"
fi
[ -n "$HF_TOKEN" ] || { echo "HF_TOKEN is empty" >&2; exit 1; }
export HF_TOKEN

hf auth whoami
hf upload "$REPO_ID" "$STAGE" . \
  --repo-type model \
  --commit-message "${HF_COMMIT_MESSAGE:-docs: licence, notices, model cards and source/}" \
  --commit-description "Licence files, notices, model cards and the source/ folder (AGPL Corresponding Source scripts) from the CamStack repository. Only files that differ from the Hub are included. No weight file is touched."
