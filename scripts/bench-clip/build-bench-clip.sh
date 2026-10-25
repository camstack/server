#!/usr/bin/env bash
# Build `camstack-bench-v1` — the public clip the node benchmark measures on.
#
# A ~2 min composite of CC BY / CC0 / public-domain footage only (no stock
# libraries): MEVA (Kitware / IARPA DIVA, CC BY 4.0) for people, faces,
# vehicles, thermal and an empty night negative control; Wikimedia Commons for
# a porch parcel, a bicycle with close faces, cats and birds; and a SYNTHETIC
# fictional plate ("CS 123 AB") drawn onto a MEVA car's empty plate recess, so
# plate detection + OCR have a known text and no personal data.
#
# Output (in $OUT, default ./out):
#   camstack-bench-v1-h264-1080p.mp4   1920x1080, 15 fps, H.264 High, no
#                                      B-frames, 2 s closed GOP, fragmented MP4
#   camstack-bench-v1-h265-1080p.mp4   the same in H.265 (hvc1)
#   SHA256SUMS                         pin the h264 hash in
#     packages/addon-pipeline/src/pipeline-runner/node-bench/bench-frames.ts
#     (BENCH_CLIP.sha256) after uploading to the HF dataset repo
#     camstack/camstack-bench-clips under camstack-bench-v1/.
# NOTICE.md and bench-manifest.json next to this script ship with the files.
#
# Needs: ffmpeg (libx264, libx265, drawtext), curl. Network: the public MEVA
# S3 bucket and upload.wikimedia.org. Re-encoding is not byte-reproducible
# across ffmpeg builds — always pin the hash of the file actually uploaded.
set -euo pipefail

OUT="${OUT:-$(pwd)/out}"
WORK="${WORK:-$OUT/work}"
FONT="${FONT:-}"
for f in "$FONT" "/System/Library/Fonts/Supplemental/Arial Bold.ttf" \
  /usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf; do
  if [ -n "$f" ] && [ -f "$f" ]; then FONT="$f"; break; fi
done
[ -f "$FONT" ] || { echo "set FONT to a bold TTF" >&2; exit 1; }
mkdir -p "$OUT" "$WORK"

MEVA=https://mevadata-public-01.s3.amazonaws.com/drops-123-r13
UA="camstack-bench-clip/1 (https://github.com/camstack/server)"
FPS=15
# Every segment: 1920x1080 (scaled to fit, padded), 15 fps, no audio.
NORM="scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=$FPS,format=yuv420p,setsar=1"
SEG_ENC=(-an -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p)

fetch() { # url dest [sha1]
  local url="$1" dest="$2" sha="${3:-}"
  if [ ! -s "$dest" ]; then curl -fsSL -A "$UA" -o "$dest.part" "$url" && mv "$dest.part" "$dest"; fi
  if [ -n "$sha" ]; then
    local got; got=$(shasum -a 1 "$dest" | cut -d' ' -f1)
    [ "$got" = "$sha" ] || { echo "sha1 mismatch for $dest ($got != $sha)" >&2; exit 1; }
  fi
}

# seg <name> <input> <start> <duration> [extra -vf prefix]
seg() {
  local name="$1" input="$2" ss="$3" dur="$4" pre="${5:-}"
  local vf="$NORM"; [ -n "$pre" ] && vf="$pre,$NORM"
  ffmpeg -v error -y -ss "$ss" -i "$input" -t "$dur" -vf "$vf" "${SEG_ENC[@]}" "$WORK/$name.mp4"
  echo "  $name ($dur s)"
}

echo "sources…"
fetch "https://upload.wikimedia.org/wikipedia/commons/e/e8/Don%27t_Tempt_a_Thief_with_Unattended_Parcels.ogv" \
  "$WORK/parcel.ogv" b2c78f874e9de8882d0bd38dbaa6413e1da34078
fetch "https://upload.wikimedia.org/wikipedia/commons/a/ae/Video_Codec_Test_pedestrian_area_1080p25.y4m.webm" \
  "$WORK/pedestrian.webm" 51e89a672896e45cca17aa46cd223630a6266e26
fetch "https://upload.wikimedia.org/wikipedia/commons/4/40/Busy_Bird_Feeder_%2831524812531%29.webm" \
  "$WORK/birds.webm" 2fec638eaada699dd8604a9f3b1fbc248ae4454b
fetch "https://upload.wikimedia.org/wikipedia/commons/2/20/%D0%9A%D1%96%D1%88%D0%BA%D0%B8_%D0%BC%D0%B5%D1%87%D0%B5%D1%82%D1%96_%D0%A8%D0%B5%D1%85%D0%B7%D0%B0%D0%B4%D0%B5_08.webm" \
  "$WORK/cats.webm" 35f0dd36864ade8397676daaaa8d7213eb120f81

G421="$MEVA/2018-03-07/17/2018-03-07.17-00-00.17-05-00.school.G421.r13.avi"
G339="$MEVA/2018-03-07/17/2018-03-07.17-00-06.17-05-06.school.G339.r13.avi"
G340="$MEVA/2018-03-07/17/2018-03-07.17-00-00.17-05-00.bus.G340.r13.avi"
G476="$MEVA/2018-03-07/17/2018-03-07.17-00-00.17-05-00.hospital.G476.r13.avi"
G506="$MEVA/2018-03-11/00/2018-03-11.23-55-00.00-00-00.bus.G506.r13.avi"

# The fictional plate: white EU-style plate, blue band, black text.
ffmpeg -v error -y -f lavfi -i "color=c=white:s=520x112:d=1" -frames:v 1 \
  -vf "drawbox=x=0:y=0:w=520:h=112:color=black@1:t=4,drawbox=x=4:y=4:w=52:h=104:color=0x003399:t=fill,drawtext=fontfile='$FONT':text='CS 123 AB':fontcolor=black:fontsize=78:x=74+(446-tw)/2:y=(h-th)/2" \
  "$WORK/plate.png"

echo "segments…"
seg s01-faces "$G421" 120 14
seg s02-vehicles "$G339" 30 12
seg s03-suv "$G340" 85 8
# S4 — the synthetic plate on the parked SUV of G340 (static between 118 and
# 132 s; its empty recess at x≈342..420, y≈648..710 of the 1920x1080 frame),
# then a slow pan over a 1280x720 window so the plate is ~120 px wide.
ffmpeg -v error -y -ss 118 -i "$G340" -i "$WORK/plate.png" -t 12 -filter_complex \
  "[1:v]scale=80:20,rotate=-0.05:c=none:ow=rotw(-0.05):oh=roth(-0.05)[p];[0:v][p]overlay=x=341:y=669[c];[c]crop=1280:720:x='min(t*6\,60)':y=330,$NORM[v]" \
  -map "[v]" "${SEG_ENC[@]}" "$WORK/s04-plate.mp4" && echo "  s04-plate (12 s)"
seg s05-parcel "$WORK/parcel.ogv" 2 20
seg s06-bicycle "$WORK/pedestrian.webm" 0 10
seg s07-cats "$WORK/cats.webm" 5 10
seg s08-birds "$WORK/birds.webm" 20 10
seg s09-thermal "$G476" 60 10
seg s10-night-empty "$G506" 60 8

echo "concat + encode…"
: >"$WORK/list.txt"
for s in s01-faces s02-vehicles s03-suv s04-plate s05-parcel s06-bicycle s07-cats s08-birds s09-thermal s10-night-empty; do
  echo "file '$WORK/$s.mp4'" >>"$WORK/list.txt"
done
ffmpeg -v error -y -f concat -safe 0 -i "$WORK/list.txt" -c copy "$WORK/master.mp4"
GOP=$((FPS * 2))
ffmpeg -v error -y -i "$WORK/master.mp4" -an -c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p \
  -bf 0 -g $GOP -keyint_min $GOP -sc_threshold 0 -b:v 4M -maxrate 4M -bufsize 8M \
  -movflags +frag_keyframe+empty_moov+default_base_moof "$OUT/camstack-bench-v1-h264-1080p.mp4"
ffmpeg -v error -y -i "$WORK/master.mp4" -an -c:v libx265 -tag:v hvc1 \
  -x265-params "keyint=$GOP:min-keyint=$GOP:scenecut=0:bframes=0:log-level=error" -b:v 2M \
  -movflags +frag_keyframe+empty_moov+default_base_moof "$OUT/camstack-bench-v1-h265-1080p.mp4"
(cd "$OUT" && shasum -a 256 camstack-bench-v1-*.mp4 >SHA256SUMS && cat SHA256SUMS)
