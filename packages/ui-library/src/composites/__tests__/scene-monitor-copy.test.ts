import type { SceneMonitor } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  badgeFor,
  coverageLine,
  roiTooLarge,
  statusLine,
  suspensionLine,
} from '../cap-settings/scene-monitor-copy'

function monitor(overrides: Partial<SceneMonitor> = {}): SceneMonitor {
  return {
    id: 'm1',
    label: 'Immondizia prelevata',
    roi: { kind: 'rect', x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    enabled: true,
    triggerMode: 'both',
    check: { mode: 'similarity', threshold: 0.8, hysteresisCount: 3 },
    states: [
      { id: 's1', label: 'baseline', references: [], referenceCount: 1, currentlyMatched: true },
    ],
    currentStateId: 's1',
    lastCheckedAt: 1_000,
    lastConfidence: 0.95,
    currentCondition: 'day',
    availability: 'ok',
    unavailableReason: null,
    baselineStateId: 's1',
    emit: 'latched',
    verdict: 'matched',
    latched: false,
    armedAt: 0,
    divergedAt: null,
    restoredAt: null,
    quietSeconds: 60,
    minObservationSpacingSec: 120,
    anchorThreshold: 0.85,
    autoRestore: false,
    onUncoveredCondition: 'skip',
    suspendedCondition: null,
    unavailable: null,
    coveredConditions: ['day'],
    ...overrides,
  }
}

describe('coverageLine', () => {
  // The single line that converts a scene which silently stops answering after
  // sunset into a visible, fixable fact — WITHOUT reading as a fault. It used
  // to end "reports 'can’t tell' in night (ir)", which described a scene
  // configured exactly as the operator meant it as if it were broken.
  it('names the missing lighting as OPTIONAL, and says checks there are skipped', () => {
    const line = coverageLine(monitor({ coveredConditions: ['day'] }))
    expect(line).toContain('Night (IR) ✗')
    expect(line).toContain('optional')
    expect(line).toContain('skipped')
    expect(line).not.toContain('can’t tell')
  })

  it('says nothing alarming once both variants are covered', () => {
    const line = coverageLine(monitor({ coveredConditions: ['day', 'ir'] }))
    expect(line).toBe('Daylight ✓ · Night (IR) ✓')
  })

  it('shows a condition the operator captured beyond the two asked for', () => {
    expect(coverageLine(monitor({ coveredConditions: ['day', 'ir', 'dusk'] }))).toContain('Dusk ✓')
  })

  it('describes the judge-anyway policy instead of the skip one', () => {
    const line = coverageLine(
      monitor({ coveredConditions: ['day'], onUncoveredCondition: 'judge-anyway' }),
    )
    expect(line).toContain('judged against the references you do have')
    expect(line).not.toContain('skipped')
  })

  // Nothing captured at all IS unfinished work, and reassuring the operator
  // there would hide the only step still outstanding.
  it('does not call a never-captured scene optional', () => {
    const line = coverageLine(monitor({ coveredConditions: [] }))
    expect(line).toContain('nothing captured yet')
    expect(line).not.toContain('optional')
  })
})

/**
 * The operator's complaint, in one block: a scene with only a daylight
 * reference must not look broken at night. It reads as PAUSED, in the neutral
 * tone, and says so in a sentence that asks nothing of them.
 */
describe('an uncovered light is presented as optional, never as a fault', () => {
  it('suspensionLine is null while the scene is checking normally', () => {
    expect(suspensionLine(monitor())).toBeNull()
  })

  it('names the light being sat out and promises it resumes on its own', () => {
    const line = suspensionLine(monitor({ suspendedCondition: 'ir' }))
    expect(line).toContain('night (ir)')
    expect(line).toContain('until the light changes back')
  })

  it('the badge reads Paused in the NEUTRAL tone — never alarm', () => {
    expect(badgeFor(monitor({ suspendedCondition: 'ir' }))).toEqual({
      text: 'Paused',
      tone: 'unknown',
    })
  })

  it('a held flag still outranks a pause — a scene stays Changed through the night', () => {
    expect(badgeFor(monitor({ suspendedCondition: 'ir', latched: true }))).toEqual({
      text: 'Changed',
      tone: 'alarm',
    })
    expect(
      statusLine(monitor({ suspendedCondition: 'ir', latched: true, verdict: 'diverged' }), 5_000),
    ).toContain('CHANGED')
  })

  it('statusLine explains the pause rather than reporting a stale verdict', () => {
    expect(statusLine(monitor({ suspendedCondition: 'ir' }), 5_000)).toContain('Paused')
  })
})

describe('statusLine', () => {
  it('tells an unarmed scene apart from a working one', () => {
    expect(statusLine(monitor({ states: [] }), 0)).toContain('capture the initial state')
  })

  // `unknown` is a real value, not a null, and each cause needs different words
  // because each needs a different fix.
  it('names WHY it cannot judge, with the fix', () => {
    expect(
      statusLine(monitor({ verdict: 'unknown', unavailable: 'no-reference-for-condition' }), 0),
    ).toContain('Capture daylight')
    expect(statusLine(monitor({ verdict: 'unknown', unavailable: 'view-shifted' }), 0)).toContain(
      'camera view has moved',
    )
    expect(
      statusLine(monitor({ verdict: 'unknown', unavailable: 'encoder-model-changed' }), 0),
    ).toContain('Re-capture')
  })

  it('asks for a reset while the latch holds, even once the scene matches again', () => {
    const line = statusLine(
      monitor({ verdict: 'matched', latched: true, restoredAt: 5_000, armedAt: 0 }),
      10_000,
    )
    expect(line).toContain('still flagged as changed')
    expect(line).toContain('Reset')
  })
})

describe('badgeFor', () => {
  it('the latch outranks the live verdict — it is the thing the operator asked for', () => {
    expect(badgeFor(monitor({ verdict: 'matched', latched: true }))).toEqual({
      text: 'Changed',
      tone: 'alarm',
    })
  })

  it('an unarmed scene never reads as normal', () => {
    expect(badgeFor(monitor({ states: [] })).tone).toBe('unknown')
  })

  it('a scene that cannot judge never reads as normal either', () => {
    expect(badgeFor(monitor({ verdict: 'unknown' })).text).toBe('Can’t tell')
  })
})

describe('roiTooLarge', () => {
  // A full-frame scene is dominated by weather, sky and parked cars: the bin is
  // 2 % of the pixels and CLIP will not notice it leaving. The failure is
  // silent INSENSITIVITY, so it is warned about rather than refused.
  it('warns on a box covering most of the frame', () => {
    expect(roiTooLarge({ width: 1, height: 1 })).toBe(true)
    expect(roiTooLarge({ width: 0.7, height: 0.7 })).toBe(true)
  })
  it('accepts a tight box', () => {
    expect(roiTooLarge({ width: 0.25, height: 0.3 })).toBe(false)
  })
})
