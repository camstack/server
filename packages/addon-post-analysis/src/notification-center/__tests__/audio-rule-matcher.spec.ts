/**
 * AudioWatcher / audio-rule-matcher unit tests — the PURE matcher behind an
 * audio rule.
 *
 * Contract (operator decision 2026-08-14, D157 — TWO EXCLUSIVE MODES):
 *
 *  LABEL mode (`labels` present) — the rule fires when `confirmHits` labelled
 *  frames land inside `confirmWindowSec` (default 2 in 5 s). A percentage of
 *  frames is still the wrong question (YAMNet labels 1–3 frames per episode);
 *  a COUNT of those sparse frames is the brake that drops a single-frame
 *  false positive without asking 60% of a 10 s window. `confirmHits: 1` is
 *  the old first-frame behaviour, kept as an operator escape hatch.
 *
 *  LEVEL mode (`dbThreshold` present, no labels) — unchanged: a window
 *  CONFIRMS when, over `samplingSeconds`, at least `hitPercent`% of the
 *  samples it holds are at or above the floor; the window must be FULL first,
 *  it SLIDES, and confirming RE-ARMS it.
 *
 *  Fail-closed: a condition with NEITHER filter watches nothing, and a sample
 *  with no level cannot satisfy a dB threshold.
 *
 * The clock is injected as the `now` argument to `observe` — the module owns
 * no timers and does no I/O.
 */

import type { NcAudioCondition } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  AudioWatcher,
  type AudioWindowHit,
  type AudioWindowSpec,
  audioSpecFromCondition,
  normalizeAudioLabel,
} from '../audio-rule-matcher.js'

const DEVICE = 102
const SEC = 1_000

function condition(over: Partial<NcAudioCondition> = {}): NcAudioCondition {
  return { hitPercent: 60, samplingSeconds: 10, ...over }
}

/** A LEVEL-mode spec — the windowed one. */
function level(
  over: Partial<Omit<Extract<AudioWindowSpec, { mode: 'level' }>, 'mode'>> = {},
): AudioWindowSpec {
  return { mode: 'level', dbThreshold: -30, hitPercent: 60, samplingSeconds: 10, ...over }
}

/** A LABEL-mode spec — count-in-window, default 2 in 5 s (the Pianti default). */
function labelled(
  labels: readonly string[],
  over: { readonly confirmHits?: number; readonly confirmWindowSec?: number } = {},
): AudioWindowSpec {
  return {
    mode: 'label',
    labels,
    confirmHits: over.confirmHits ?? 2,
    confirmWindowSec: over.confirmWindowSec ?? 5,
  }
}

/** Feed `count` samples one second apart from `fromSec`, returning every hit. */
function feed(
  watcher: AudioWatcher,
  fromSec: number,
  count: number,
  sample: { readonly dbfs?: number; readonly labels?: readonly string[] },
): readonly AudioWindowHit[] {
  const hits: AudioWindowHit[] = []
  for (let i = 0; i < count; i += 1) {
    const at = (fromSec + i) * SEC
    hits.push(
      ...watcher.observe(
        DEVICE,
        {
          timestampMs: at,
          ...(sample.dbfs !== undefined ? { dbfs: sample.dbfs } : {}),
          labels: sample.labels ?? [],
        },
        at,
      ),
    )
  }
  return hits
}

describe('normalizeAudioLabel', () => {
  it('folds case and the taxonomy `audio-` prefix onto one spelling', () => {
    expect(normalizeAudioLabel('audio-dog')).toBe('dog')
    expect(normalizeAudioLabel('Dog')).toBe('dog')
    expect(normalizeAudioLabel('  AUDIO-Glass_Breaking ')).toBe('glass_breaking')
  })
})

describe('audioSpecFromCondition — which MODE a stored rule is in', () => {
  it('labels ⇒ LABEL mode, normalized, with the confirm-count defaults', () => {
    expect(audioSpecFromCondition(condition({ labels: ['audio-Dog', 'speech'] }))).toEqual({
      mode: 'label',
      labels: ['dog', 'speech'],
      confirmHits: 2,
      confirmWindowSec: 5,
    })
  })

  it('a stored confirm pair rides through, clamped only by the spec', () => {
    expect(
      audioSpecFromCondition(
        condition({ labels: ['crying'], confirmHits: 3, confirmWindowSec: 8 }),
      ),
    ).toEqual({
      mode: 'label',
      labels: ['crying'],
      confirmHits: 3,
      confirmWindowSec: 8,
    })
  })

  it('a threshold ⇒ LEVEL mode, carrying the window', () => {
    expect(audioSpecFromCondition(condition({ dbThreshold: -55, hitPercent: 40 }))).toEqual({
      mode: 'level',
      dbThreshold: -55,
      hitPercent: 40,
      samplingSeconds: 10,
    })
  })

  it('a LEGACY rule carrying both is the LABEL rule — the mode that fires', () => {
    // The live rule 4d7dbe2a (crying+scream, hitPercent 60/10 s) is the reason
    // this exists: it could never reach 60% of frames, and the migration must
    // make it fire without the operator re-authoring anything.
    expect(
      audioSpecFromCondition(condition({ labels: ['crying', 'scream'], dbThreshold: -30 })),
    ).toEqual({
      mode: 'label',
      labels: ['crying', 'scream'],
      confirmHits: 2,
      confirmWindowSec: 5,
    })
  })

  it('FAILS CLOSED with neither filter — a window where every sample is a hit', () => {
    expect(audioSpecFromCondition(condition())).toBeNull()
    expect(audioSpecFromCondition(condition({ labels: [] }))).toBeNull()
  })
})

// ── LABEL MODE ──────────────────────────────────────────────────────

describe('AudioWatcher — LABEL mode waits for N labelled frames in M seconds', () => {
  it('does not confirm on a single labelled frame — the Pianti false-positive', () => {
    // 15 notifies in 12 h on 2026-08-23, nobody crying. Each was the first
    // YAMNet `crying` frame. One frame is not an episode.
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying', 'scream'])])
    expect(feed(w, 0, 1, { labels: ['crying'] })).toEqual([])
  })

  it('confirms on the second labelled frame inside the window', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying'])])
    expect(feed(w, 0, 1, { labels: ['crying'] })).toEqual([])
    const hits = feed(w, 2, 1, { labels: ['crying'] })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ deviceId: DEVICE, timestamp: 2 * SEC, labels: ['crying'] })
  })

  it('does not confirm when the two frames are farther apart than the window', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying'])])
    expect(feed(w, 0, 1, { labels: ['crying'] })).toEqual([])
    // 6 s later the first hit has aged out of the 5 s window.
    expect(feed(w, 6, 1, { labels: ['crying'] })).toEqual([])
  })

  it('confirmHits: 1 restores first-frame fire for an operator who wants it', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying'], { confirmHits: 1 })])
    const hits = feed(w, 0, 1, { labels: ['crying'] })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.window).toBeUndefined()
  })

  it('fires the sparse episode a percentage window could never answer: 2 labelled frames in 60', () => {
    // YAMNet labels one to three frames per episode. A 60%-of-10s window
    // never reached that; two frames two seconds apart still confirm here.
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying'])])

    expect(feed(w, 0, 30, { labels: [] })).toEqual([])
    expect(feed(w, 30, 1, { labels: ['crying'] })).toEqual([])
    const cry = feed(w, 31, 1, { labels: ['crying'] })
    expect(cry).toHaveLength(1)
    expect(feed(w, 32, 28, { labels: [] })).toEqual([])
  })

  it('re-arms after confirm — a later pair can fire again', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying'])])
    expect(feed(w, 0, 1, { labels: ['crying'] })).toEqual([])
    expect(feed(w, 1, 1, { labels: ['crying'] })).toHaveLength(1)
    expect(feed(w, 2, 1, { labels: ['crying'] })).toEqual([])
    expect(feed(w, 3, 1, { labels: ['crying'] })).toHaveLength(1)
  })

  it('ignores the LEVEL entirely — a quiet cry is still a cry', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying'])])
    expect(feed(w, 0, 1, { dbfs: -90, labels: ['crying'] })).toEqual([])
    expect(feed(w, 1, 1, { dbfs: -90, labels: ['crying'] })).toHaveLength(1)
  })

  it('never fires on an unwatched label, however long it goes on', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying'])])
    expect(feed(w, 0, 60, { labels: ['speech', 'music'] })).toEqual([])
  })

  it('matches a taxonomy id against a bare macro label, either way round', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['scream'])])
    expect(feed(w, 0, 1, { labels: ['audio-Scream'] })).toEqual([])
    expect(feed(w, 1, 1, { labels: ['audio-Scream'] })).toHaveLength(1)

    const w2 = new AudioWatcher()
    w2.setWatchedSpecs([labelled(['audio-scream'])])
    expect(feed(w2, 0, 1, { labels: ['scream'] })).toEqual([])
    expect(feed(w2, 1, 1, { labels: ['scream'] })).toHaveLength(1)
  })

  it('reports the MATCHED labels, not everything the frame carried', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying'])])
    expect(feed(w, 0, 1, { labels: ['speech', 'crying'] })).toEqual([])
    const hits = feed(w, 1, 1, { labels: ['speech', 'crying'] })
    expect(hits[0]?.labels).toEqual(['crying'])
  })

  it('carries the confirming-frame level when it has one, for the notification text', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying'])])
    expect(feed(w, 0, 1, { dbfs: -50, labels: ['crying'] })).toEqual([])
    const hits = feed(w, 1, 1, { dbfs: -41, labels: ['crying'] })
    expect(hits[0]?.peakDbfs).toBe(-41)
  })

  it('forgetDevice drops a pending first hit so it cannot confirm later', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying'])])
    expect(feed(w, 0, 1, { labels: ['crying'] })).toEqual([])
    w.forgetDevice(DEVICE)
    expect(feed(w, 1, 1, { labels: ['crying'] })).toEqual([])
  })
})

// ── LEVEL MODE — the window, unchanged ──────────────────────────────

describe('AudioWatcher — LEVEL mode: the window must be FULL', () => {
  it('does not confirm before samplingSeconds have elapsed, however loud', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level()])

    // 9 samples over 9 s of a 10 s window, every one of them a hit.
    expect(feed(w, 0, 9, { dbfs: -10 })).toEqual([])
  })

  it('confirms on the sample that completes the window', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level()])

    expect(feed(w, 0, 10, { dbfs: -10 })).toEqual([])
    const hits = feed(w, 10, 1, { dbfs: -10 })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ deviceId: DEVICE, timestamp: 10 * SEC, peakDbfs: -10 })
    expect(hits[0]?.window).toMatchObject({ hitPercent: 100, samplingSeconds: 10 })
  })
})

/**
 * The window is HALF-OPEN — `(now − samplingSeconds, now]` — so at the 1 Hz
 * cadence these tests feed, the first FULL 10 s window is judged at t=10 s and
 * holds the samples at t=1…10: ten of them, with the t=0 sample aged out. Every
 * percentage below is over those ten.
 */
describe('AudioWatcher — the hitPercent comparison', () => {
  it('confirms EXACTLY at hitPercent', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level({ hitPercent: 60 })])

    feed(w, 0, 1, { dbfs: -50 }) // t=0 — ages out of the judged window
    feed(w, 1, 6, { dbfs: -10 }) // t=1..6 loud
    const hits = feed(w, 7, 4, { dbfs: -50 }) // t=7..10 quiet; t=10 completes it
    expect(hits).toHaveLength(1)
    expect(hits[0]?.window?.hitPercent).toBe(60)
  })

  it('does NOT confirm one point below the threshold', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level({ hitPercent: 61 })])

    feed(w, 0, 1, { dbfs: -50 })
    feed(w, 1, 6, { dbfs: -10 })
    expect(feed(w, 7, 4, { dbfs: -50 })).toEqual([]) // the same 60% window
  })

  it('confirms at the threshold and not one point above it, at several ratios', () => {
    const at = (hitPercent: number, loud: number): readonly AudioWindowHit[] => {
      const w = new AudioWatcher()
      w.setWatchedSpecs([level({ hitPercent })])
      feed(w, 0, 1, { dbfs: -50 }) // aged-out filler
      return [
        // A 100%-loud case has no trailing quiet sample, so the confirmation
        // arrives on the loud feed itself — collect both.
        ...feed(w, 1, loud, { dbfs: -10 }),
        ...feed(w, 1 + loud, 10 - loud, { dbfs: -50 }),
      ]
    }
    expect(at(30, 3)).toHaveLength(1) // 30% ≥ 30
    expect(at(31, 3)).toEqual([])
    expect(at(90, 9)).toHaveLength(1)
    expect(at(91, 9)).toEqual([])
    expect(at(100, 10)).toHaveLength(1)
  })

  it('reports the measured percentage, the counts and the peak level', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level({ hitPercent: 50 })])
    feed(w, 0, 1, { dbfs: -70 })
    feed(w, 1, 6, { dbfs: -12 })
    const hits = feed(w, 7, 4, { dbfs: -70 })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.window?.hits).toBe(6)
    expect(hits[0]?.window?.samples).toBe(10)
    expect(hits[0]?.window?.hitPercent).toBe(60)
    // The peak is over the HITTING samples: the quiet ones are not the sound
    // the rule is about.
    expect(hits[0]?.peakDbfs).toBe(-12)
  })

  it('ignores the LABELS — a level rule needs no model to be right', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level({ hitPercent: 50 })])
    const hits = feed(w, 0, 11, { dbfs: -20, labels: ['music'] })
    expect(hits).toHaveLength(1)
    expect(hits[0]?.window?.hits).toBe(10)
  })

  it('FAILS CLOSED on a sample with no level', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level({ hitPercent: 50 })])
    expect(feed(w, 0, 11, {})).toEqual([])
  })
})

describe('AudioWatcher — the window SLIDES', () => {
  it('drops samples that have aged out, so an old burst cannot carry a later window', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level({ hitPercent: 50 })])

    // A loud burst at t=0..4 that never fills a window on its own.
    feed(w, 0, 5, { dbfs: -10 })
    // Then quiet for 20 s. By t=20 the burst is long out of the window.
    expect(feed(w, 5, 16, { dbfs: -80 })).toEqual([])
  })

  it('confirms on a burst that arrives INSIDE the window, after a quiet start', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level({ hitPercent: 50 })])

    feed(w, 0, 11, { dbfs: -80 }) // window fills, quiet — no confirmation
    const hits = feed(w, 11, 10, { dbfs: -10 }) // ten loud seconds slide in
    expect(hits.length).toBeGreaterThanOrEqual(1)
    expect(hits[0]?.window?.hits).toBeGreaterThan(0)
  })
})

describe('AudioWatcher — re-arm and lifecycle', () => {
  it('empties the window on a confirmation, so the next one needs a fresh one', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level({ hitPercent: 50 })])

    const first = feed(w, 0, 11, { dbfs: -10 })
    expect(first).toHaveLength(1)
    // The next nine loud seconds are a window that is not full again.
    expect(feed(w, 11, 9, { dbfs: -10 })).toEqual([])
    expect(feed(w, 20, 2, { dbfs: -10 })).toHaveLength(1)
  })

  it('keeps a window per DEVICE — one loud camera does not fire another', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level({ hitPercent: 50 })])
    const loud: AudioWindowHit[] = []
    for (let i = 0; i <= 10; i += 1) {
      const at = i * SEC
      // The quiet camera never confirms, however long it is observed.
      expect(w.observe(999, { timestampMs: at, dbfs: -80, labels: [] }, at)).toEqual([])
      loud.push(...w.observe(DEVICE, { timestampMs: at, dbfs: -10, labels: [] }, at))
    }
    expect(loud).toHaveLength(1)
    expect(loud[0]?.deviceId).toBe(DEVICE)
  })

  it('watches nothing until specs are set, and drops state for a spec removed', () => {
    const w = new AudioWatcher()
    expect(feed(w, 0, 11, { dbfs: -10 })).toEqual([])

    w.setWatchedSpecs([level({ hitPercent: 50 })])
    feed(w, 11, 6, { dbfs: -10 })
    // The rule is edited to a different threshold: the old key's samples go.
    w.setWatchedSpecs([level({ hitPercent: 50, dbThreshold: -20 })])
    expect(feed(w, 17, 5, { dbfs: -10 })).toEqual([])
  })

  it('serves TWO rules with different windows from one sample stream', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([
      level({ hitPercent: 50, samplingSeconds: 5 }),
      level({ hitPercent: 50, samplingSeconds: 20 }),
    ])
    const early = feed(w, 0, 6, { dbfs: -10 })
    expect(early).toHaveLength(1)
    expect(early[0]?.window?.samplingSeconds).toBe(5)

    // t=6..20: the 5 s window confirms and re-arms at t=10, 15 and 20; the 20 s
    // one becomes full for the first time at t=20.
    const later = feed(w, 6, 15, { dbfs: -10 })
    expect(later.map((h) => h.window?.samplingSeconds).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      [5, 5, 5, 20],
    )
  })

  it('serves a LABEL rule and a LEVEL rule from one sample stream', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([labelled(['crying']), level({ hitPercent: 50 })])
    // Quiet cry: the label rule confirms on the second frame, the level
    // window never does (the samples are −80, under −30).
    expect(feed(w, 0, 1, { dbfs: -80, labels: ['crying'] })).toEqual([])
    const cry = feed(w, 1, 1, { dbfs: -80, labels: ['crying'] })
    expect(cry).toHaveLength(1)
    expect(cry[0]?.spec.mode).toBe('label')
    expect(feed(w, 2, 10, { dbfs: -80 })).toEqual([])
  })

  it('forgets a device on demand (unbound / removed camera)', () => {
    const w = new AudioWatcher()
    w.setWatchedSpecs([level({ hitPercent: 50 })])
    feed(w, 0, 6, { dbfs: -10 })
    w.forgetDevice(DEVICE)
    expect(feed(w, 6, 5, { dbfs: -10 })).toEqual([])
  })
})
