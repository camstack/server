#!/usr/bin/env bash
# Regenerate the bundled notification test samples.
#
# DEC-4 of docs/superpowers/specs/2026-07-28-notifiers-rules-overhaul.md: the
# samples are GENERATED from synthetic ffmpeg sources, never sourced from a
# third party — the addon is redistributed to every node, so a bundled asset
# must carry no licence and no provenance question.
#
# Sizes are deliberately small: they must fit under the TIGHTEST adapter
# attachment cap (pushover, 5 MB) with room to spare, and they travel inside
# the addon bundle to every node.
#
# Rerun after changing anything here; the output is deterministic for a given
# ffmpeg version.
set -euo pipefail
cd "$(dirname "$0")/../assets/samples"

# A readable test card — the operator must be able to tell at a glance whether
# the image arrived intact or was truncated/re-encoded by the backend.
ffmpeg -v error -y -f lavfi -i "testsrc2=size=640x360:rate=1:duration=1" \
  -frames:v 1 -q:v 6 image.jpg

# 2s @ 8fps, 32-colour palette. Small enough that no backend rejects it, long
# enough that a still-image fallback is obvious when a backend degrades it.
ffmpeg -v error -y -f lavfi -i "testsrc2=size=240x135:rate=8:duration=2" \
  -vf "split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 animation.gif

# H.264 + AAC, faststart so a player can begin without the whole file. Audio is
# included on purpose: several backends handle a silent mp4 differently.
ffmpeg -v error -y -f lavfi -i "testsrc2=size=640x360:rate=15:duration=3" \
  -f lavfi -i "sine=frequency=440:duration=3" \
  -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p \
  -c:a aac -b:a 48k -movflags +faststart clip.mp4

ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=2" \
  -c:a libmp3lame -b:a 64k tone.mp3

ls -l
