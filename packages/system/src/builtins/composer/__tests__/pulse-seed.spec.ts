/**
 * What a pulse override holds for `lastPressedAt` (D938).
 *
 * Before the first observed edge the field does not borrow the camera's native
 * stamp. A plain restart keeps the stamp this block already claimed. A history
 * read that fails changes nothing (D49): no seed, and no "no ring".
 */
import { describe, expect, it } from 'vitest'
import {
  decidePulseSeed,
  lastOffToOn,
  mergePulseDecisions,
  type OwnedPulse,
  type PulseHistoryRead,
  type PulseSourceLevel,
} from '../pulse-seed.js'

const NATIVE = 1_727_600_000_000
const YESTERDAY = 1_761_300_000_000
const OLDER = NATIVE - 86_400_000

const ownedNone: OwnedPulse = { kind: 'none' }
const ownedStamp: OwnedPulse = { kind: 'stamp', at: YESTERDAY, count: 4 }

function series(
  points: readonly { readonly t: number; readonly on: boolean }[],
  beforeOn: boolean | null = false,
): PulseHistoryRead {
  return { kind: 'series', beforeOn, points }
}

const off = (changedAt: number | null): PulseSourceLevel => ({
  kind: 'off',
  changedAt,
})

describe('before the first observed edge', () => {
  it('seeds the last off→on from the source history, not the native stamp', () => {
    const decision = decidePulseSeed({
      owned: ownedNone,
      nativeStamp: NATIVE,
      history: series([
        { t: NATIVE, on: true },
        { t: NATIVE + 1_000, on: false },
        { t: YESTERDAY, on: true },
        { t: YESTERDAY + 2_000, on: false },
      ]),
      level: off(YESTERDAY + 2_000),
    })
    expect(decision).toEqual({
      kind: 'stamp',
      at: YESTERDAY,
      count: 0,
      via: 'history',
    })
  })

  it('with no recorded history, an off source bounds the ring from above only when that bound is newer than native', () => {
    const newer = decidePulseSeed({
      owned: ownedNone,
      nativeStamp: NATIVE,
      history: { kind: 'absent' },
      level: off(YESTERDAY),
    })
    expect(newer).toEqual({
      kind: 'stamp',
      at: YESTERDAY,
      count: 0,
      via: 'changed-at-bound',
    })

    const older = decidePulseSeed({
      owned: ownedNone,
      nativeStamp: NATIVE,
      history: { kind: 'absent' },
      level: off(OLDER),
    })
    expect(older).toEqual({ kind: 'none', count: 0 })
  })

  it('a source that is on, or a history series with no rise, contributes nothing — not the native stamp', () => {
    expect(
      decidePulseSeed({
        owned: ownedNone,
        nativeStamp: NATIVE,
        history: { kind: 'absent' },
        level: { kind: 'on', changedAt: YESTERDAY },
      }),
    ).toEqual({ kind: 'none', count: 0 })
    expect(
      decidePulseSeed({
        owned: ownedNone,
        nativeStamp: NATIVE,
        history: series([{ t: YESTERDAY, on: false }], false),
        level: off(YESTERDAY),
      }),
    ).toEqual({ kind: 'none', count: 0 })
  })
})

describe('a history read that fails (D49)', () => {
  it('does not seed and does not clear a stamp this block already claimed', () => {
    expect(
      decidePulseSeed({
        owned: ownedNone,
        nativeStamp: NATIVE,
        history: { kind: 'unread' },
        level: off(YESTERDAY),
      }),
    ).toEqual({ kind: 'hold', reason: 'history-unread' })
    expect(
      decidePulseSeed({
        owned: ownedStamp,
        nativeStamp: NATIVE,
        history: { kind: 'unread' },
        level: off(YESTERDAY),
      }),
    ).toEqual({ kind: 'keep' })
  })

  it('an unreadable level, when the source records no history, is not "no ring"', () => {
    expect(
      decidePulseSeed({
        owned: ownedNone,
        nativeStamp: NATIVE,
        history: { kind: 'absent' },
        level: { kind: 'unread' },
      }),
    ).toEqual({ kind: 'hold', reason: 'level-unread' })
  })
})

describe('after a restart the claimed stamp is kept', () => {
  it('keeps the claimed stamp when history is older or empty', () => {
    expect(
      decidePulseSeed({
        owned: ownedStamp,
        nativeStamp: NATIVE,
        history: series([
          { t: NATIVE, on: true },
          { t: NATIVE + 1_000, on: false },
        ]),
        level: off(NATIVE + 1_000),
      }),
    ).toEqual({ kind: 'keep' })
    expect(
      decidePulseSeed({
        owned: ownedStamp,
        nativeStamp: NATIVE,
        history: series([]),
        level: off(YESTERDAY),
      }),
    ).toEqual({ kind: 'keep' })
  })

  it('a rise newer than the claimed stamp replaces the time and keeps the count', () => {
    const later = YESTERDAY + 86_400_000
    expect(
      decidePulseSeed({
        owned: ownedStamp,
        nativeStamp: NATIVE,
        history: series([
          { t: YESTERDAY, on: false },
          { t: later, on: true },
        ]),
        level: { kind: 'on', changedAt: later },
      }),
    ).toEqual({ kind: 'stamp', at: later, count: 4, via: 'history' })
  })
})

describe('lastOffToOn', () => {
  it('is the last false→true, and a series that starts already on is not one', () => {
    expect(
      lastOffToOn(
        [
          { t: 1, on: false },
          { t: 2, on: true },
          { t: 3, on: false },
          { t: 4, on: true },
        ],
        null,
      ),
    ).toBe(4)
    expect(lastOffToOn([{ t: 9, on: true }], null)).toBeNull()
    expect(lastOffToOn([{ t: 9, on: true }], false)).toBe(9)
  })
})

describe('mergePulseDecisions', () => {
  it('a failed source does not veto another source rise, and does veto no-ring', () => {
    expect(
      mergePulseDecisions([
        { kind: 'hold', reason: 'history-unread' },
        { kind: 'stamp', at: YESTERDAY, count: 0, via: 'history' },
      ]),
    ).toEqual({ kind: 'stamp', at: YESTERDAY, count: 0, via: 'history' })
    expect(
      mergePulseDecisions([
        { kind: 'hold', reason: 'history-unread' },
        { kind: 'none', count: 0 },
      ]),
    ).toEqual({ kind: 'hold', reason: 'history-unread' })
  })
})
