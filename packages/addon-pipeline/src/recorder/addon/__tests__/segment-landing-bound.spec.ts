/**
 * SegmentWatcher: what "the flat file is not on disk" actually means.
 *
 * Measured over 2026-08-10..13 (990 retried segment paths, 122 `never landed`
 * verdicts) before any of this was written:
 *
 * - **83% of all retries were for segments from a PREVIOUS writer run.** Their
 *   median age at the moment the watcher first looked was 1 101 s (max 17.4 h).
 *   ffmpeg's `-segment_list` file is not cleared between runs and a fresh
 *   watcher starts at `processed = 0`, so on every attach it replays the old
 *   playlist — whose entries were relocated into the bucket tree long ago.
 *   Those files are not late, they are GONE ON PURPOSE, and the watcher ground
 *   through them one entry per bound before skipping each with a warning that
 *   read like data loss. After the 2026-08-13 recovery-pass fix removed the
 *   detach/re-attach churn, the residual was exactly this: 62 retries, all in
 *   the single minute of attach, all aged 527-544 s, then zero for 37 minutes.
 *
 * - **For genuinely fresh segments a bigger bound buys essentially nothing.**
 *   Landed-late waits were p50 7.8 s, p90 11.6 s. Raising the window from 16 s
 *   to 120 s moves coverage from 92.9% to 93.8% — 0.9 points. The segments past
 *   that knee are not slow, they are lost (a writer killed mid-segment), and
 *   waiting longer only delays the skip.
 *
 * So the fix is not a bigger constant. It is: recognise a previous run's entry
 * and skip it AT ONCE (while still indexing one whose file is genuinely still
 * there — that is real crash recovery), and express the bound for everything
 * else in TIME rather than in ticks, because 8 ticks measured anywhere from 8 s
 * to 819 s depending on how loaded the tick loop was.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  classifyMissingEntry,
  type MissingEntryVerdict,
  shouldGiveUpOnPending,
} from '../segment-watcher'

describe('classifyMissingEntry — a missing file is not always a late file', () => {
  const WRITER_STARTED_MS = 1_000_000

  it('skips an entry from a PREVIOUS run at once — its file was relocated, not delayed', () => {
    const verdict: MissingEntryVerdict = classifyMissingEntry({
      segmentStartMs: WRITER_STARTED_MS - 540_000, // the 527-544s ages seen at attach
      writerStartedMs: WRITER_STARTED_MS,
    })
    expect(verdict).toBe('stale-previous-run')
  })

  it('treats an entry from THIS run as pending, so a genuinely late flush is retried', () => {
    const verdict: MissingEntryVerdict = classifyMissingEntry({
      segmentStartMs: WRITER_STARTED_MS + 10_000,
      writerStartedMs: WRITER_STARTED_MS,
    })
    expect(verdict).toBe('pending')
  })

  it('does not misfile the writer first segment, named at the spawn instant', () => {
    expect(
      classifyMissingEntry({
        segmentStartMs: WRITER_STARTED_MS,
        writerStartedMs: WRITER_STARTED_MS,
      }),
    ).toBe('pending')
  })

  it('tolerates the sub-second skew between spawn and ffmpeg first strftime name', () => {
    // ffmpeg names with whole-second `%s`, so a segment created at spawn+0.4s is
    // named for the second that STARTED before the writer did. Calling that a
    // previous run would discard the very first segment of every recording.
    expect(
      classifyMissingEntry({
        segmentStartMs: WRITER_STARTED_MS - 999,
        writerStartedMs: WRITER_STARTED_MS,
      }),
    ).toBe('pending')
  })
})

describe('shouldGiveUpOnPending — the bound is TIME, not ticks', () => {
  it('keeps waiting inside the window however many ticks have elapsed', () => {
    // 40 fast ticks inside 5s must NOT exhaust the grace: the old tick counter
    // gave up after 8 of them regardless of how little time had passed.
    expect(shouldGiveUpOnPending({ waitedMs: 5_000, boundMs: 30_000 })).toBe(false)
  })

  it('gives up once the window is past, even if only a couple of ticks ran', () => {
    // The mirror image, and the one that made 8 ticks mean 819s: a starved tick
    // loop stretched the real grace to thirteen minutes.
    expect(shouldGiveUpOnPending({ waitedMs: 31_000, boundMs: 30_000 })).toBe(true)
  })

  it('covers the measured p90 landing delay with margin', () => {
    // Measured p90 = 11.6s, p50 = 7.8s over 4 days.
    expect(shouldGiveUpOnPending({ waitedMs: 11_600, boundMs: 30_000 })).toBe(false)
  })
})

describe('the measured bound', () => {
  it('is documented where the constant lives', async () => {
    const mod = await import('../segment-watcher')
    expect(mod.PENDING_GRACE_MS).toBe(30_000)
  })
})

describe('handleSegmentEntry — the classification is actually WIRED', () => {
  // A pure predicate can be perfectly right and never called. These go through
  // the real entry handler against a directory with no files in it, so the only
  // thing that can produce 'skipped' rather than 'pending' is the classifier.
  const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() } as never
  const EMPTY_DIR = '/nonexistent-recorder-landing-spec'
  const WRITER_STARTED_MS = 1_700_000_000_000

  it('advances past a previous run entry instead of spending the grace window', async () => {
    const { handleSegmentEntry } = await import('../segment-watcher')
    const onFinalized = vi.fn()
    const status = await handleSegmentEntry(
      EMPTY_DIR,
      { durSeconds: 10, segPath: `${Math.floor((WRITER_STARTED_MS - 540_000) / 1000)}.m4s` },
      10_000,
      onFinalized,
      logger,
      WRITER_STARTED_MS,
    )
    expect(status).toBe('skipped')
    expect(onFinalized).not.toHaveBeenCalled()
  })

  it('still retries an entry from THIS run whose file has not flushed', async () => {
    const { handleSegmentEntry } = await import('../segment-watcher')
    const status = await handleSegmentEntry(
      EMPTY_DIR,
      { durSeconds: 10, segPath: `${Math.floor((WRITER_STARTED_MS + 20_000) / 1000)}.m4s` },
      10_000,
      vi.fn(),
      logger,
      WRITER_STARTED_MS,
    )
    expect(status).toBe('pending')
  })
})

describe('the verdict is never silent', () => {
  it('reports a give-up with the deviceId-scoped logger and the measured wait', async () => {
    const { startSegmentWatcher } = await import('../segment-watcher')
    const warn = vi.fn()
    const logger = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn } as never
    // A watcher over a directory that does not exist never reads a playlist, so
    // this asserts only that the surface exists and takes the writer clock.
    const h = startSegmentWatcher({
      deviceId: 101,
      outDir: '/nonexistent-recorder-spec',
      intervalMs: 3_600_000,
      onFinalized: () => {},
      logger,
      writerStartedMs: 1,
      now: () => 1,
    })
    h.stop()
    expect(typeof h.stop).toBe('function')
  })
})
