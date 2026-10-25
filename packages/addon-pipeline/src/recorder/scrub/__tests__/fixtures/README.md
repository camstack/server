# Scrub fixtures — REAL recorder LOW segments

Standalone fragmented-MP4 (`ftyp`+`moov`+`moof`+`mdat`) LOW-profile segments used
by the scrub keyframe extractor tests (Task 3). Each `.m4s` is self-initializing
(its own `moov`), exactly as the recorder writes them
(`buildPassthroughArgs` → `-segment_format mp4 -segment_format_options
movflags=+frag_keyframe+empty_moov+default_base_moof`, `-c:v copy`).

| file | device | codec | sample entry | segment basename (startMs-durMs-bytes) |
|---|---|---|---|---|
| low-h264.m4s | 104 | h264 | avc1 | 1784816817000-7989-88125.m4s |
| low-h265.m4s | 637 | h265 | hvc1 | 1784838441000-7986-54891.m4s |

- 640×360, ~8s each; well under the ~4MB soft cap (86 KB / 54 KB).
- Tests read start/dur from **this table's basenames** (`<startMs>-<durMs>-<bytes>`,
  the `segmentRelPath` convention in `recorder/segment-path.ts`). Re-fetch any time
  via `scratchpad/fetch-scrub-fixtures.mjs` and update the table.

## Provenance & codec verification

Fetched 2026-07-23 from the live `.9` hub via `scratchpad/fetch-scrub-fixtures.mjs`.
Codecs verified with `ffprobe` on the committed files:

- `low-h264.m4s` → `codec_name=h264`, `codec_tag_string=avc1`, 640×360, 7.989s.
- `low-h265.m4s` → `codec_name=hevc`, `codec_tag_string=hvc1`, 640×360, 7.986s.

**How each was produced (they differ — read this):**

- **low-h264.m4s** is a **genuine recorder segment**. On this hub only device 104
  (h264) has recorded footage, so it was downloaded straight from 104's playback
  plane (`recording.getPlaybackManifest` → `low.m3u8` → first `.m4s`). The basename
  is the recorder's own on-disk name.

- **low-h265.m4s** was produced from device 637's **live** low stream because **no
  h265 camera is currently recording** on this hub (637/102 are h265 but have zero
  recorded footage; `recording.getAvailability` = 0 ranges). It was muxed with the
  **exact recorder recipe** (`buildPassthroughArgs` in
  `recorder/addon/ffmpeg-args.ts`: `-c:v copy -tag:v hvc1 -f segment -segment_format
  mp4 -segment_format_options movflags=+frag_keyframe+empty_moov+default_base_moof`)
  against a transient broker `copy` restream (`streamBroker.getStreamWithCodec`,
  released after). Because video is `-c:v copy`, the payload is the camera's **real
  HEVC bitstream**, and the muxer + flags are identical to production — so the box
  layout (including the `hvc1` sample entry Apple/WebKit requires) matches a
  recorder-written segment byte-for-structure. Its basename is synthesized to the
  same `<startMs>-<durMs>-<bytes>` convention (epoch-sec start ×1000, ffprobe
  duration, file size).

  > Note: the brief tentatively cited 101/102 as "h264 4K". Live status on this hub
  > shows 101=h264, 102=h265, 637=h265, 103=h264, 104=h264 — 637 (h265) was used,
  > codec confirmed by both `streamBroker.getStreamWithCodec` (`videoCodec:"H265"`)
  > and `ffprobe` on the committed file (`hevc`/`hvc1`).
