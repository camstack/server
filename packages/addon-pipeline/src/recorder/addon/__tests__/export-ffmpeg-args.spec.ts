import type { ExportOptions } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildAssembleConcatList,
  buildConcatPassArgs,
  buildExportArgs,
  buildExportConcatList,
  concatPassOutPath,
  EXPORT_FFMPEG_THREADS,
} from '../export-ffmpeg-args.js'

const base = { inputPlaylist: '/p/master.m3u8', outPath: '/o/e1.mp4' }
function opts(over: Partial<ExportOptions>): ExportOptions {
  return {
    includeAudio: false,
    maxLifeMs: 1,
    deleteAfterDownload: false,
    ...over,
  }
}

describe('buildExportArgs', () => {
  it('1x with audio is a pure remux', () => {
    const a = buildExportArgs({
      ...base,
      options: opts({ speed: 1, includeAudio: true }),
    })
    expect(a).toContain('-c')
    expect(a).toContain('copy')
    expect(a).not.toContain('libx264')
    expect(a).not.toContain('-an')
    expect(a).toContain('/o/e1.mp4')
  })

  it('1x without audio drops audio but still remuxes', () => {
    const a = buildExportArgs({
      ...base,
      options: opts({ speed: 1, includeAudio: false }),
    })
    expect(a).toContain('copy')
    expect(a).toContain('-an')
  })

  it('2x with audio keeps atempo and re-encodes', () => {
    const a = buildExportArgs({
      ...base,
      options: opts({ speed: 2, includeAudio: true }),
    })
    expect(a.join(' ')).toContain('setpts=PTS/2')
    expect(a.join(' ')).toContain('atempo=2')
    expect(a).toContain('libx264')
    expect(a).not.toContain('-an')
  })

  it('8x drops audio (out of atempo band) and re-encodes with setpts', () => {
    const a = buildExportArgs({
      ...base,
      options: opts({ speed: 8, includeAudio: true }),
    })
    expect(a.join(' ')).toContain('setpts=PTS/8')
    expect(a).toContain('-an')
    expect(a.join(' ')).not.toContain('atempo')
    expect(a).toContain('libx264')
  })

  it('0.5x (slow-mo) with audio keeps atempo', () => {
    const a = buildExportArgs({
      ...base,
      options: opts({ speed: 0.5, includeAudio: true }),
    })
    expect(a.join(' ')).toContain('atempo=0.5')
  })

  it('timelapse selects frames, sets fps, and is silent', () => {
    const a = buildExportArgs({
      ...base,
      options: opts({ timelapse: { everyMs: 2000, outputFps: 30 } }),
    })
    expect(a.join(' ')).toContain('select=')
    expect(a.join(' ')).toContain('fps=30')
    expect(a).toContain('-an')
    expect(a).toContain('libx264')
  })

  it('timelapse defaults to 30fps when outputFps omitted', () => {
    const a = buildExportArgs({
      ...base,
      options: opts({ timelapse: { everyMs: 5000 } }),
    })
    expect(a.join(' ')).toContain('fps=30')
  })
})

/**
 * The POST-HOC scheduled timelapse: one render, two rates. The dense ranges
 * come from the tracks that actually existed in the window, so the empty hours
 * cost 30 s per frame and the busy minutes cost 2 s per frame — in the SAME
 * export, from the SAME footage, with no second renderer.
 */
describe('buildExportArgs — dense (two-rate) timelapse', () => {
  const vf = (a: readonly string[]): string => {
    const i = a.indexOf('-vf')
    return a[i + 1] ?? ''
  }

  it('emits a single select expression that switches rate inside the ranges', () => {
    const a = buildExportArgs({
      ...base,
      options: opts({
        timelapse: {
          everyMs: 30_000,
          outputFps: 12,
          dense: {
            everyMs: 2000,
            ranges: [
              { fromSec: 10, toSec: 40 },
              { fromSec: 120.5, toSec: 180 },
            ],
          },
        },
      }),
    })
    expect(vf(a)).toBe(
      "select='isnan(prev_selected_t)+if(between(t,10,40)+between(t,120.5,180)," +
        "gte(t-prev_selected_t,2),gte(t-prev_selected_t,30))'," +
        'setpts=N/(12*TB),fps=12',
    )
    expect(a).toContain('-an')
    expect(a).toContain('libx264')
  })

  /**
   * The retiming step must place selected frames on the OUTPUT fps grid, never
   * the input's. `setpts=N/FRAME_RATE/TB` retimed the kept frames to the
   * SOURCE's nominal rate (25 fps on this deployment's cameras), and the
   * trailing `fps=12` then decimated ~52% of the frames the select had chosen —
   * blindly, dense and base alike. Measured on the real export `3a62ec17`
   * (camera 101, night of 2026-08-20): 594 frames delivered where the plan
   * selected ~1240, base cadence 60 s instead of 30 s, dense 2–3 s instead of
   * 1 s. A synthetic 300 s repro through the exact argv: 19 frames out, 40
   * planned; with the output-fps grid: exactly 40.
   */
  it('retimes selected frames on the OUTPUT fps grid — never the input FRAME_RATE', () => {
    const a = buildExportArgs({
      ...base,
      options: opts({ timelapse: { everyMs: 30_000, outputFps: 12 } }),
    })
    expect(vf(a)).not.toContain('FRAME_RATE')
    expect(vf(a)).toContain('setpts=N/(12*TB)')
  })

  it('leaves the plain single-rate expression untouched when dense is absent', () => {
    const a = buildExportArgs({
      ...base,
      options: opts({ timelapse: { everyMs: 30_000, outputFps: 12 } }),
    })
    expect(vf(a)).toBe(
      "select='isnan(prev_selected_t)+gte(t-prev_selected_t,30)',setpts=N/(12*TB),fps=12",
    )
  })

  it('never emits an empty predicate — an empty range list degrades to base cadence', () => {
    // `ExportDenseSchema` refuses `ranges: []` at the boundary, but the argv
    // builder is reached by the engine from a PERSISTED record too. A record
    // written before the schema tightened must render a plain timelapse, never
    // `if(,...)` — which ffmpeg rejects and which would fail every export for
    // that camera.
    const a = buildExportArgs({
      ...base,
      options: opts({
        timelapse: { everyMs: 30_000, dense: { everyMs: 2000, ranges: [] } },
      }),
    })
    expect(vf(a)).toBe(
      "select='isnan(prev_selected_t)+gte(t-prev_selected_t,30)',setpts=N/(30*TB),fps=30",
    )
  })
})

/**
 * What the predicate has to DO, over timestamps that look like the ones ffmpeg
 * actually sees — not what it looks like.
 *
 * The live failure: a ten-hour 21:00→07:00 timelapse rendered a **262-byte**
 * MP4 and reported `state: ready`. The predicate was `not(mod(t,30))`, true
 * only when `t` is an EXACT multiple of 30. `t` is the PTS of a frame in a
 * concat of ~3,600 recorded segments, each carrying its own rounding, so it
 * lands on 30.000000 essentially never: ffmpeg kept the frame at t=0 and
 * discarded ten hours of footage without a single warning.
 *
 * `evaluate` below is a reference implementation of the two ffmpeg `select`
 * primitives this predicate uses — `prev_selected_t` (the timestamp of the last
 * frame the filter KEPT, NaN before the first) and `between` — applied frame by
 * frame. It is deliberately not a string assertion: the string assertions above
 * would have passed just as happily for the broken expression.
 */
describe('timelapse cadence over realistic frame timestamps', () => {
  /** A 15fps hour with per-frame rounding — never an exact multiple of anything. */
  function jitteryTimestamps(seconds: number, fps: number): number[] {
    const out: number[] = []
    for (let i = 0; i < seconds * fps; i += 1) {
      // ms-quantised PTS plus a sub-ms drift, as a segment concat produces.
      out.push(Math.round((i / fps) * 1000) / 1000 + ((i * 37) % 991) / 1e6 + 1e-6)
    }
    return out
  }

  /** Apply "keep a frame once `everySec` has passed since the last kept one". */
  function evaluate(timestamps: readonly number[], everySec: number): number[] {
    const kept: number[] = []
    let prevSelected = Number.NaN
    for (const t of timestamps) {
      if (Number.isNaN(prevSelected) || t - prevSelected >= everySec) {
        kept.push(t)
        prevSelected = t
      }
    }
    return kept
  }

  /** The OLD predicate, for contrast: exact modulo on the timestamp. */
  function evaluateModulo(timestamps: readonly number[], everySec: number): number[] {
    return timestamps.filter((t) => t % everySec === 0)
  }

  it('keeps one frame per interval across an hour of jittery 15fps timestamps', () => {
    const ts = jitteryTimestamps(3600, 15)
    const kept = evaluate(ts, 30)

    // 3600s / 30s: the seeded frame at t≈0, then one per interval.
    expect(kept.length).toBe(120)
    // Every gap is at least the cadence, and never more than one source frame over.
    for (let i = 1; i < kept.length; i += 1) {
      const gap = (kept[i] ?? 0) - (kept[i - 1] ?? 0)
      expect(gap).toBeGreaterThanOrEqual(30)
      expect(gap).toBeLessThan(30 + 1 / 15 + 0.01)
    }
  })

  it('the exact-modulo predicate it replaced keeps almost nothing — this is the 262-byte MP4', () => {
    const ts = jitteryTimestamps(3600, 15)
    expect(evaluateModulo(ts, 30).length).toBeLessThan(5)
    expect(evaluate(ts, 30).length).toBe(120)
  })

  it('survives a gap in the recording without losing the cadence afterwards', () => {
    // Ten minutes, then a twenty-minute hole, then ten minutes more.
    const ts = [...jitteryTimestamps(600, 15), ...jitteryTimestamps(600, 15).map((t) => t + 1800)]
    const kept = evaluate(ts, 30)
    // The frame after the hole is kept immediately (the hole exceeds the
    // cadence), and the cadence resumes from it.
    expect(kept.length).toBe(40)
    expect(kept.some((t) => t >= 1800 && t < 1800.1)).toBe(true)
  })
})

/**
 * Pass 1 of a long timelapse: remux the HLS concat into ONE continuous file
 * (mpegts + copy) so pass 2's `select` never walks `#EXT-X-DISCONTINUITY`.
 * A 30h hall render sat at `rendering 0%` / 0% CPU because ffmpeg was
 * selecting frames WHILE concatenating thousands of reset-timestamp pieces.
 */
describe('buildConcatPassArgs — timelapse pass 1', () => {
  /**
   * Pass 1 reads the export's FFCONCAT list, not the HLS playlist. The HLS
   * demuxer stitches segments by their CONTENT length while the dense map sums
   * the DECLARED `durMs` — and on segments whose PTS span disagrees with their
   * declared duration the two clocks drift apart cumulatively (~495 s by the
   * end of camera 101's night of 2026-08-20, which is why its 31 s dense range
   * fired over a stretch that held no detection). The concat demuxer's
   * `duration` directive pins each segment's start to the SAME cumulative sum
   * the map computes, so the error is bounded per segment and never accumulates.
   */
  it('reads the ffconcat list through the concat demuxer and remuxes to mpegts', () => {
    const a = buildConcatPassArgs({
      inputConcatList: '/p/e1.src.ffconcat',
      outPath: '/o/e1.concat.ts',
    })
    expect(a).toEqual([
      '-fflags',
      '+discardcorrupt+genpts',
      '-err_detect',
      'ignore_err',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      '/p/e1.src.ffconcat',
      '-c',
      'copy',
      '-an',
      '-f',
      'mpegts',
      '/o/e1.concat.ts',
    ])
    expect(a.join(' ')).not.toContain('select=')
    expect(a).not.toContain('libx264')
  })

  it('names the concat sidecar next to the final MP4', () => {
    expect(concatPassOutPath('/o/e1.mp4')).toBe('/o/e1.concat.ts')
  })
})

/**
 * The ffconcat list itself: one `file` + `duration` pair per segment, durations
 * from the SAME `durMs` the dense map sums (`export-dense-map.ts`), so the two
 * sides of the wall→stream translation can never disagree by construction.
 */
describe('buildExportConcatList', () => {
  it('emits one file/duration pair per segment, in playlist order', () => {
    const text = buildExportConcatList([
      { uri: '/rec/101/a.m4s', durMs: 11_983 },
      { uri: '/rec/101/b.m4s', durMs: 7_989 },
    ])
    expect(text).toBe(
      'ffconcat version 1.0\n' +
        "file '/rec/101/a.m4s'\nduration 11.983\n" +
        "file '/rec/101/b.m4s'\nduration 7.989\n",
    )
  })

  it('escapes a single quote in a path the way ffmpeg expects', () => {
    const text = buildExportConcatList([{ uri: "/rec/o'brien/a.m4s", durMs: 1_000 }])
    expect(text).toContain("file '/rec/o'\\''brien/a.m4s'")
  })
})

describe('buildAssembleConcatList', () => {
  it('lists whole surviving MP4s and does NOT pin a fake duration', () => {
    const text = buildAssembleConcatList(['/o/e.chunk0.mp4', '/o/e.chunk1.mp4'])
    expect(text).toBe(
      'ffconcat version 1.0\n' + "file '/o/e.chunk0.mp4'\n" + "file '/o/e.chunk1.mp4'\n",
    )
    expect(text).not.toContain('duration')
  })
})

/**
 * An export is a BACKGROUND chore on a box that is also a live NVR.
 *
 * ffmpeg with no `-threads` uses every core it can see. This deployment has 20,
 * and the engine already allows two renders at once, so a pair of exports could
 * ask for forty threads of decode+encode while thirty-one cameras were being
 * recorded and analysed. On 2026-09-02 an export took the host to a load
 * average of 846 and it had to be power-cycled.
 *
 * The profile fix (cost-ordered `pickProfile`) removed the reason a night job
 * ever touched 4K. This is the other half: even on the cheap profile, a render
 * must not be allowed to claim the machine.
 */
describe('an export never claims every core', () => {
  it('bounds the timelapse re-encode', () => {
    const args = buildExportArgs({
      inputPlaylist: '/tmp/in.m3u8',
      outPath: '/tmp/out.mp4',
      options: opts({ timelapse: { everyMs: 30_000, outputFps: 30 } }),
    })
    const at = args.indexOf('-threads')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(args[at + 1]).toBe(String(EXPORT_FFMPEG_THREADS))
  })

  it('bounds a speed-change re-encode too', () => {
    const args = buildExportArgs({
      inputPlaylist: '/tmp/in.m3u8',
      outPath: '/tmp/out.mp4',
      options: opts({ speed: 4 }),
    })
    expect(args).toContain('-threads')
  })

  it('keeps the bound small enough to leave the NVR its cores', () => {
    expect(EXPORT_FFMPEG_THREADS).toBeGreaterThan(0)
    expect(EXPORT_FFMPEG_THREADS).toBeLessThanOrEqual(4)
  })
})
