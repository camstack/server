/**
 * D660 — a window the analyzer never classified must reach the rule matcher
 * SAYING so. Until D660 it arrived with empty
 * detections and no marker, which is exactly the shape of a window that was
 * classified and heard nothing above the floor (D393).
 */
import { describe, expect, it } from 'vitest'
import type { AudioResult } from '@camstack/types'
import { ncAudioSampleFromFrame } from '../audio-classify-outcome.js'
import { AudioWatcher } from '../../notification-center/audio-rule-matcher.js'

const FLOOR = { classificationMinScore: 0.3, audioAllowedClasses: [] }

function frame(overrides: Partial<AudioResult>): AudioResult {
  return {
    kind: 'audio-window',
    windowId: '101-1000',
    deviceId: 101,
    timestamp: 1_000,
    startMs: 0,
    endMs: 0,
    level: { rms: 0.2, dbfs: -14 },
    detections: [],
    ...overrides,
  }
}

describe('audio classify outcome — carried past the analyzer (D660)', () => {
  it('hands the NC matcher a not-classified sample as not-classified, with its level', () => {
    const sample = ncAudioSampleFromFrame(
      frame({ classifyOutcome: { state: 'not-classified', reason: 'superseded' } }),
      1_000,
      FLOOR,
    )
    expect(sample.classifyOutcome).toEqual({ state: 'not-classified', reason: 'superseded' })
    expect(sample.labels).toEqual([])
    expect(sample.dbfs).toBe(-14)
  })

  it('keeps applying the per-device floor to the labels of a classified window', () => {
    const sample = ncAudioSampleFromFrame(
      frame({
        classifyOutcome: { state: 'classified' },
        detections: [
          {
            id: 'a1',
            kind: 'audio',
            macroClass: 'crying',
            score: 0.5,
            labels: [],
            startMs: 0,
            endMs: 0,
          },
          {
            id: 'a2',
            kind: 'audio',
            macroClass: 'dog',
            score: 0.1,
            labels: [],
            startMs: 0,
            endMs: 0,
          },
        ],
      }),
      1_000,
      FLOOR,
    )
    expect(sample.labels).toEqual(['crying'])
    expect(sample.classifyOutcome).toEqual({ state: 'classified' })
  })

  it('a label rule does not count a not-classified window — and does not reset on it', () => {
    const watcher = new AudioWatcher()
    watcher.setWatchedSpecs([
      { mode: 'label', labels: ['crying'], confirmHits: 2, confirmWindowSec: 5 },
    ])
    expect(watcher.observe(101, { timestampMs: 1_000, labels: ['crying'] }, 1_000)).toEqual([])
    expect(
      watcher.observe(
        101,
        {
          timestampMs: 2_000,
          labels: [],
          classifyOutcome: { state: 'not-classified', reason: 'superseded' },
        },
        2_000,
      ),
    ).toEqual([])
    expect(watcher.observe(101, { timestampMs: 3_000, labels: ['crying'] }, 3_000)).toHaveLength(1)
  })
})
