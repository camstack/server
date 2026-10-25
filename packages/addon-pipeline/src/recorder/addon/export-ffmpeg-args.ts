/**
 * ffmpeg argv builder for recording EXPORTS (render a footage range → one MP4).
 *
 * Input is the export's OWN source playlist for the range — a per-export file
 * whose segment URIs are absolute on-disk paths (`export-source-playlist.ts`).
 * It is deliberately NOT the playback manifest's `localMasterPath`: those URIs
 * resolve only through the data-plane's multi-root search, which ffmpeg does not
 * have. Output is a single faststart MP4. Three shapes, from `ExportOptions`:
 *   - 1× + audio            → pure remux (`-c copy`), zero re-encode.
 *   - speed ≠ 1             → `setpts=PTS/speed` video re-encode; audio kept
 *                             only for 0.5–2× (single `atempo`), else dropped.
 *   - timelapse             → sample one frame per `everyMs`, output at
 *                             `outputFps`, always silent.
 * Distinct from `buildPassthroughArgs` (live segmentation) — do not conflate.
 *
 * A **timelapse of a long segment concat** is two argv sets, not one. Pass 1
 * (`buildConcatPassArgs`) remuxes the export's FFCONCAT list to a single
 * mpegts with `-c copy`. Pass 2 (`buildExportArgs` with that file as `-i`)
 * then selects frames. Selecting WHILE walking `#EXT-X-DISCONTINUITY` (one
 * per 10s segment from `-reset_timestamps`) is what parked a 30h hall job
 * at `rendering 0%` / 0% CPU — ffmpeg never left the concat demuxer.
 *
 * Pass 1 reads the ffconcat list, NOT the HLS playlist, because of WHOSE
 * clock the concatenation runs on. The dense-range map
 * (`export-dense-map.ts`) sums the segments' DECLARED `durMs`; the HLS
 * demuxer stitches segments by their CONTENT length. On footage whose PTS
 * span disagrees with its declared duration the two clocks drift apart
 * cumulatively — measured ~495 s by the end of camera 101's 10 h night of
 * 2026-08-20, which put every short dense range over a stretch that held no
 * detection. The concat demuxer's `duration` directive pins each segment's
 * start to the SAME cumulative sum the map computes, so the disagreement is
 * bounded per segment and never accumulates.
 */
import path from 'node:path'
import type { ExportDense, ExportOptions } from '@camstack/types'

/** Widest [min,max] speed a single ffmpeg `atempo` filter accepts. Outside this
 *  band audio is dropped rather than chained (kept simple + predictable). */
const ATEMPO_MIN = 0.5
const ATEMPO_MAX = 2

/**
 * Cores ONE export render may use.
 *
 * ffmpeg with no `-threads` takes every core it can see. This hub has 20 and
 * {@link EXPORT_MAX_CONCURRENT} allows two renders at once, so a pair of
 * exports could ask for forty threads of decode+encode while thirty-one
 * cameras were being recorded and analysed. On 2026-09-02 that took the host
 * to a load average of 846 and it had to be power-cycled.
 *
 * An export is a background chore on a machine whose real job is live video,
 * so it gets a fixed small share and never negotiates for more. Measured
 * 2026-09-03 on camera 101: a whole 8-hour night of `low` renders in 65 s at
 * two threads — the bound costs nothing that matters.
 */
export const EXPORT_FFMPEG_THREADS = 2

/** Applied to every re-encoding path. A `-c copy` remux decodes nothing. */
const THREADS = ['-threads', String(EXPORT_FFMPEG_THREADS)] as const

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'] as const
const FASTSTART = ['-movflags', '+faststart'] as const

/**
 * Format a seconds value for an ffmpeg expression.
 *
 * `String(n)` and nothing else: an exponent (`1e-7`) or a locale separator
 * would both be a filter ffmpeg refuses, and the values here are bounded
 * (`everyMs` is a positive integer of ms, range bounds are window offsets in
 * seconds), so neither can arise from a valid input. Kept as one function so
 * the base cadence and the dense cadence can never format differently.
 */
function sec(value: number): string {
  return String(value)
}

/**
 * The timelapse frame-select PREDICATE — one rate, or two.
 *
 * **Elapsed since the last SELECTED frame, never `mod` on the timestamp.**
 * `not(mod(t,every))` is only true when `t` is an EXACT multiple of `every`,
 * and `t` here is the presentation timestamp of a frame concatenated out of
 * ~3,600 recorded segments: each segment's PTS carries its own rounding, so a
 * frame lands on 30.000000 essentially never. It rendered a 262-byte MP4 —
 * ffmpeg selected the frame at t=0 and nothing else — from ten hours of real
 * footage, and reported success while doing it. The cadence must be expressed
 * as "has `every` seconds passed since the frame I last kept", which is exactly
 * `prev_selected_t`, and it is robust to jitter, to a gap in the recording, and
 * to a variable source frame rate.
 *
 * `isnan(prev_selected_t)` seeds it: before anything has been selected
 * `prev_selected_t` is NaN, so the first frame is always kept and every
 * comparison after it has a defined origin. The leading `+` is ffmpeg's
 * expression OR.
 *
 * Two rates: `if(between(t,a,b)+…, <dense cadence>, <base cadence>)` — the `+`
 * is again OR, so one `if` covers every range without nesting. Both branches
 * measure from the SAME `prev_selected_t`, so crossing into a dense range
 * simply shortens the next interval; no state is reset and no frame is lost at
 * the boundary.
 *
 * An EMPTY range list degrades to the single-rate expression rather than
 * emitting `if(,…)`. `ExportDenseSchema` refuses `ranges: []` at the cap
 * boundary, but this builder is also reached from a PERSISTED export record
 * written before that boundary existed — and a malformed filter fails the
 * render for that camera forever, where a plain timelapse merely loses the
 * second rate.
 */
function selectPredicate(everySec: number, dense: ExportDense | undefined): string {
  const elapsed = (everyS: number): string => `gte(t-prev_selected_t,${sec(everyS)})`
  const seed = 'isnan(prev_selected_t)'
  if (dense === undefined || dense.ranges.length === 0) {
    return `${seed}+${elapsed(everySec)}`
  }
  const inside = dense.ranges.map((r) => `between(t,${sec(r.fromSec)},${sec(r.toSec)})`).join('+')
  return `${seed}+if(${inside},${elapsed(dense.everyMs / 1000)},${elapsed(everySec)})`
}

export interface ExportArgsInput {
  readonly inputPlaylist: string
  readonly outPath: string
  readonly options: ExportOptions
}

/**
 * Sidecar for timelapse pass 1: same directory as the final MP4, `.concat.ts`.
 * mpegts (not MP4) because `-c copy` across HLS discontinuities is reliable
 * in a transport stream and often is not in a fragmented MP4.
 */
export function concatPassOutPath(outPath: string): string {
  const dir = path.dirname(outPath)
  const base = path.basename(outPath, path.extname(outPath))
  return path.join(dir, `${base}.concat.ts`)
}

/** One entry of the pass-1 ffconcat list: where the file is, and how long the
 *  MAP believes it to be. `durMs` must be the same number
 *  `export-dense-map.ts` sums — that identity is the whole point of the list. */
export interface ExportConcatSegment {
  readonly uri: string
  readonly durMs: number
}

/** ffconcat `file` directive value: single-quoted, embedded quotes escaped the
 *  shell way (`'\''`), which is what ffmpeg's concat demuxer parses. */
function concatFileDirective(uri: string): string {
  return `file '${uri.replaceAll("'", "'\\''")}'`
}

/**
 * The FFCONCAT list pass 1 reads — one `file` + `duration` pair per segment.
 *
 * The `duration` line is load-bearing: it is what makes the concat demuxer
 * start segment k+1 at `Σ durMs[0..k]`, the exact cumulative sum
 * `recordedMsBefore` computes when the dense ranges are mapped. A segment
 * whose content is shorter than its declared duration leaves a sub-second
 * PTS hole; one that is longer overlaps the next start and the mpegts muxer
 * clamps it — both bounded per segment, neither cumulative. The HLS demuxer
 * this replaces had no declared clock at all and drifted without bound.
 */
export function buildExportConcatList(segments: readonly ExportConcatSegment[]): string {
  const lines = segments.map(
    (s) => `${concatFileDirective(s.uri)}\nduration ${sec(s.durMs / 1000)}`,
  )
  return `ffconcat version 1.0\n${lines.map((l) => `${l}\n`).join('')}`
}

/**
 * Concat list for already-finished MP4s. A `duration` line here would
 * TRUNCATE each hour to whatever dummy we wrote (the stream clock is
 * already inside the file).
 */
export function buildAssembleConcatList(uris: readonly string[]): string {
  return `ffconcat version 1.0\n${uris.map((u) => `${concatFileDirective(u)}\n`).join('')}`
}

/** Pass 1 of a timelapse: remux the ffconcat list into one continuous file.
 *  `-safe 0` because the list's paths are absolute — which is exactly what the
 *  per-export source list contains (`export-source-playlist.ts`). */
export function buildConcatPassArgs(input: {
  readonly inputConcatList: string
  readonly outPath: string
}): readonly string[] {
  return [
    // A single corrupt `.m4s` used to park pass 1 at `time=` never printed
    // (rendering 0%, 0% CPU). Discard the bad packet and keep the hour; the
    // chunk walker then skips the hour only if ffmpeg still dies.
    '-fflags',
    '+discardcorrupt+genpts',
    '-err_detect',
    'ignore_err',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    input.inputConcatList,
    '-c',
    'copy',
    '-an',
    '-f',
    'mpegts',
    input.outPath,
  ]
}

/** Final stitch of the surviving per-hour MP4s. Already selected + encoded. */
export function buildAssembleArgs(input: {
  readonly inputConcatList: string
  readonly outPath: string
}): readonly string[] {
  return [
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    input.inputConcatList,
    '-c',
    'copy',
    ...FASTSTART,
    input.outPath,
  ]
}

/** Build the ffmpeg argv for one export render. */
export function buildExportArgs(input: ExportArgsInput): readonly string[] {
  const { inputPlaylist, outPath, options } = input
  const inArgs = ['-i', inputPlaylist] as const

  // Timelapse: frame-select + fps, silent, re-encode.
  //
  // The retiming is `setpts=N/(<outputFps>*TB)` — the OUTPUT grid — and never
  // `N/FRAME_RATE/TB`. `FRAME_RATE` is the INPUT stream's nominal rate (25 fps
  // on this deployment's cameras), so the old form parked the kept frames on a
  // 25 fps grid and the trailing `fps=12` then dropped ~52% of them — blindly,
  // base and dense alike: base cadence 60 s instead of 30, dense 2–3 s instead
  // of 1, on the delivered export `3a62ec17` (camera 101, 2026-08-20). On the
  // output grid the fps filter is an identity pass that only pins CFR metadata.
  if (options.timelapse) {
    const everySec = options.timelapse.everyMs / 1000
    const fps = options.timelapse.outputFps ?? 30
    return [
      ...inArgs,
      '-vf',
      `select='${selectPredicate(everySec, options.timelapse.dense)}',setpts=N/(${fps}*TB),fps=${fps}`,
      '-an',
      ...THREADS,
      ...X264,
      ...FASTSTART,
      outPath,
    ]
  }

  const speed = options.speed ?? 1

  // Realtime remux — no re-encode. Audio rides along when requested.
  if (speed === 1) {
    return [
      ...inArgs,
      '-map',
      '0',
      '-c',
      'copy',
      ...(options.includeAudio ? [] : ['-an']),
      ...FASTSTART,
      outPath,
    ]
  }

  // Speed change: re-time video; keep audio only when atempo can express it.
  const keepAudio = options.includeAudio && speed >= ATEMPO_MIN && speed <= ATEMPO_MAX
  return [
    ...inArgs,
    '-filter:v',
    `setpts=PTS/${speed}`,
    ...(keepAudio ? ['-filter:a', `atempo=${speed}`, '-c:a', 'aac'] : ['-an']),
    ...THREADS,
    ...X264,
    ...FASTSTART,
    outPath,
  ]
}
