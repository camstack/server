/**
 * Drain progress on a location card.
 *
 * The row could say a location was draining and nothing more — there was no
 * backend method for "bytes remaining", so it read `Draining · Remaining not
 * reported yet · Estimated empty time not available yet`. Honest, and useless.
 *
 * The fixtures below are the LIVE hub's answer, read on 2026-09-08 from the
 * disk the operator actually put into drain, rather than a shape invented to
 * match the code:
 *
 *   { locationId: 'recordings:default', startedAtMs: 1788805596282,
 *     startBytes: 1676511875669, bytesRemaining: 1359839746343,
 *     drained: false, estimatedEmptyAtMs: 1789071138339 }
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DrainProgressLine } from '../DrainProgressLine'
import {
  type DrainProgressRow,
  describeDrain,
  drainedFraction,
  isLocationDraining,
  toDrainProgressById,
  toDrainProgressRow,
} from '../drain-progress'

afterEach(cleanup)

/** Verbatim from the hub. */
const LIVE = {
  locationId: 'recordings:default',
  startedAtMs: 1_788_805_596_282,
  startBytes: 1_676_511_875_669,
  bytesRemaining: 1_359_839_746_343,
  drained: false,
  estimatedEmptyAtMs: 1_789_071_138_339,
}

const row = (patch: Partial<DrainProgressRow> = {}): DrainProgressRow => ({
  ...LIVE,
  ...patch,
})

describe('reading the wire', () => {
  it('narrows the hub row exactly as it arrives', () => {
    expect(toDrainProgressRow(LIVE)).toEqual(LIVE)
  })

  it('accepts a null estimate — it is the documented "not observed yet"', () => {
    expect(toDrainProgressRow({ ...LIVE, estimatedEmptyAtMs: null })?.estimatedEmptyAtMs).toBeNull()
  })

  it('accepts an estimate key that is missing entirely', () => {
    // An older hub omitting the key means the same thing as sending null.
    const { estimatedEmptyAtMs: _dropped, ...withoutKey } = LIVE
    expect(toDrainProgressRow(withoutKey)?.estimatedEmptyAtMs).toBeNull()
  })

  it('REFUSES a row missing a load-bearing field rather than half-reporting', () => {
    // Putting a number beside a location it may not belong to is worse than
    // saying nothing.
    for (const key of ['locationId', 'startedAtMs', 'startBytes', 'bytesRemaining', 'drained']) {
      const partial: Record<string, unknown> = { ...LIVE }
      delete partial[key]
      expect(toDrainProgressRow(partial)).toBeNull()
    }
  })

  it('drops a malformed row without losing the others', () => {
    const byId = toDrainProgressById([LIVE, { nonsense: true }, null])
    expect(byId.size).toBe(1)
    expect(byId.get('recordings:default')?.bytesRemaining).toBe(LIVE.bytesRemaining)
  })

  it('answers an empty map for a hub too old to know the method', () => {
    // The caller catches "no such procedure" and hands the error through here;
    // every card then falls back to the sentence it draws today.
    expect(toDrainProgressById(undefined).size).toBe(0)
    expect(toDrainProgressById({ error: 'NOT_FOUND' }).size).toBe(0)
  })
})

describe('the fraction that goes up as the disk empties', () => {
  it('is what has LEFT, not what is left', () => {
    // 1 676 GB → 1 359 GB is 18.9% moved.
    expect(drainedFraction(row())).toBeCloseTo(0.189, 3)
  })

  it('is null when there was nothing to drain', () => {
    // And never a division by zero.
    expect(drainedFraction(row({ startBytes: 0, bytesRemaining: 0 }))).toBeNull()
  })

  it('is null when the location GREW after the drain began', () => {
    // Writes still landing elsewhere in the same tree. Progress is not
    // negative and not zero-because-nothing-happened; it is unknown.
    expect(drainedFraction(row({ bytesRemaining: LIVE.startBytes + 1 }))).toBeNull()
  })

  it('reaches exactly 1 when the last byte is gone', () => {
    expect(drainedFraction(row({ bytesRemaining: 0 }))).toBe(1)
  })
})

describe('the three states stay distinct', () => {
  it('a location that is not draining shows NOTHING', () => {
    expect(describeDrain(false, row())).toEqual({ kind: 'idle' })
    const { container } = render(<DrainProgressLine drain={{ kind: 'idle' }} />)
    expect(container.firstChild).toBeNull()
  })

  it('a draining location the hub has not reported on says so', () => {
    expect(describeDrain(true, undefined)).toEqual({ kind: 'unreported' })
    render(<DrainProgressLine drain={{ kind: 'unreported' }} />)
    expect(screen.getByTestId('drain-unreported')).toBeTruthy()
  })

  it('a draining location with a figure shows it, with the date', () => {
    const display = describeDrain(true, row())
    render(<DrainProgressLine drain={display} />)
    expect(screen.getByTestId('drain-progress').textContent).toContain('GB left')
    expect(screen.getByTestId('drain-progress').textContent).toContain('19% moved')
    expect(screen.getByTestId('drain-eta')).toBeTruthy()
    expect(screen.queryByTestId('drain-eta-absent')).toBeNull()
  })

  it('a draining location with NO estimate states the absence, never a date', () => {
    // The whole point of the nullable field. A placeholder that looks like data
    // is the failure this line of work exists to remove.
    const display = describeDrain(true, row({ estimatedEmptyAtMs: null }))
    render(<DrainProgressLine drain={display} />)
    expect(screen.getByTestId('drain-eta-absent').textContent).toContain('not known yet')
    expect(screen.queryByTestId('drain-eta')).toBeNull()
    // …and the bytes are still shown. The missing estimate withholds the date,
    // not the progress.
    expect(screen.getByTestId('drain-progress').textContent).toContain('GB left')
  })

  it('a finished drain is its own state, not "idle"', () => {
    // The location is STILL in drain mode and the operator may want to act on
    // that; collapsing it into idle would hide a disk that is ready to leave.
    expect(describeDrain(true, row({ drained: true })).kind).toBe('drained')
    expect(describeDrain(true, row({ bytesRemaining: 0 })).kind).toBe('drained')
    render(<DrainProgressLine drain={{ kind: 'drained' }} />)
    expect(screen.getByTestId('drain-done')).toBeTruthy()
  })
})

describe('the bar measures the drain, not the fill', () => {
  it('fills as the disk empties, and says so to a screen reader', () => {
    render(<DrainProgressLine drain={describeDrain(true, row())} />)
    const bar = screen.getByTestId('drain-bar')
    expect(bar.getAttribute('aria-valuenow')).toBe('19')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
  })

  it('is OMITTED when the fraction is not knowable — never a bar pinned at 0', () => {
    // A bar at zero reads as "nothing is happening"; absent reads as "not
    // known", which is what it is.
    const grew = describeDrain(true, row({ bytesRemaining: LIVE.startBytes + 1 }))
    render(<DrainProgressLine drain={grew} />)
    expect(screen.queryByTestId('drain-bar')).toBeNull()
    expect(screen.getByTestId('drain-progress').textContent).toContain('GB left')
  })
})

describe('which locations count as draining', () => {
  it('reads the four-state `mode` the hub reports today', () => {
    expect(isLocationDraining({ mode: 'drain', config: {} })).toBe(true)
    expect(isLocationDraining({ mode: 'active', config: {} })).toBe(false)
    expect(isLocationDraining({ mode: 'disabled', config: {} })).toBe(false)
  })

  it('and the older `config.readOnly`, which persisted rows still carry', () => {
    // A card that understood only one spelling would show nothing for half the
    // fleet — which is the failure this card exists to avoid.
    expect(isLocationDraining({ config: { readOnly: true } })).toBe(true)
    expect(isLocationDraining({ config: { readOnly: false } })).toBe(false)
    expect(isLocationDraining({ config: {} })).toBe(false)
  })
})
