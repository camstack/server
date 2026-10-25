import { describe, expect, it } from 'vitest'
import type { NcAlarmOpening } from '../alarm-openings.js'
import { classifyCoveredOpening } from '../alarm-openings.js'
import { alarmSensorReadIds, alarmSensorStateOf, NcAlarmSensorsReadLog } from '../alarm-sensors.js'

describe("alarmSensorStateOf — the table, derived from the arm check's classifier", () => {
  it('a failed read is unknown, never closed', () => {
    expect(alarmSensorStateOf(7, undefined, true)).toEqual({
      deviceId: 7,
      reading: 'unknown',
      state: null,
      unknownWhy: 'read-failed',
      online: true,
      controllable: false,
    })
  })
  it('a placeholder or foreign word is unknown', () => {
    // The placeholder case: an HA cover's constructor `closed` with no change
    // yet. It must NEVER read as closed.
    expect(alarmSensorStateOf(7, { kind: 'unknown', cap: 'contact', raw: {} }, null)).toEqual({
      deviceId: 7,
      reading: 'unknown',
      state: null,
      unknownWhy: 'unknown-word',
      online: null,
      controllable: false,
    })
  })
  it('secure is closed with its word, open is open with its word', () => {
    expect(
      alarmSensorStateOf(
        7,
        { kind: 'reading', reading: 'secure', state: 'locked', cap: 'lock-control' },
        false,
      ),
    ).toEqual({
      deviceId: 7,
      reading: 'closed',
      state: 'locked',
      unknownWhy: null,
      online: false,
      controllable: true,
    })
    expect(
      alarmSensorStateOf(
        7,
        { kind: 'reading', reading: 'open', state: 'stopped', cap: 'cover' },
        null,
      ),
    ).toEqual({
      deviceId: 7,
      reading: 'open',
      state: 'stopped',
      unknownWhy: null,
      online: null,
      controllable: true,
    })
  })
  it('a contact is never controllable, open or closed', () => {
    for (const reading of ['open', 'secure'] as const) {
      const state = reading === 'open' ? 'open' : 'closed'
      expect(
        alarmSensorStateOf(7, { kind: 'reading', reading, state, cap: 'contact' }, true)
          .controllable,
      ).toBe(false)
    }
  })
  it('a device with no opening slice says so', () => {
    expect(alarmSensorStateOf(7, { kind: 'not-opening' }, true)).toEqual({
      deviceId: 7,
      reading: 'not-opening',
      state: null,
      unknownWhy: null,
      online: true,
      controllable: false,
    })
  })
  it('unknownWhy is present exactly when the reading is unknown', () => {
    const slices: ReadonlyArray<NcAlarmOpening | undefined> = [
      undefined,
      { kind: 'unknown', cap: 'contact', raw: {} },
      { kind: 'reading', reading: 'secure', state: 'locked', cap: 'lock-control' },
      { kind: 'reading', reading: 'open', state: 'open', cap: 'contact' },
      { kind: 'not-opening' },
    ]
    for (const slice of slices) {
      const out = alarmSensorStateOf(7, slice, null)
      expect(out.unknownWhy !== null).toBe(out.reading === 'unknown')
    }
  })
  it('agrees with the arm check classifier on every opening variant and on a failed read', () => {
    const variants: readonly (NcAlarmOpening | undefined)[] = [
      undefined,
      { kind: 'unknown', cap: 'cover', raw: 'ajar' },
      { kind: 'not-opening' },
      { kind: 'reading', reading: 'secure', state: 'closed', cap: 'cover' },
      { kind: 'reading', reading: 'open', state: 'open', cap: 'contact' },
    ]
    for (const opening of variants) {
      const verdict = classifyCoveredOpening(opening)
      const out = alarmSensorStateOf(7, opening, null)
      switch (verdict.kind) {
        case 'unknown':
          expect(out.reading).toBe('unknown')
          expect(out.unknownWhy).toBe(verdict.why)
          break
        case 'open':
          expect(out.reading).toBe('open')
          expect(out.state).toBe(verdict.state)
          break
        case 'skip':
          // Skipped by the arm check: closed or not an opening, never open/unknown.
          expect(['closed', 'not-opening']).toContain(out.reading)
          break
      }
    }
  })
  it('reads each id once, ascending', () => {
    expect(alarmSensorReadIds([9, 3, 9])).toEqual([3, 9])
  })
})

describe('NcAlarmSensorsReadLog — one line per change of read health', () => {
  it('WARNs when every asked id goes unanswered, once, then INFOs on recovery', () => {
    const log = new NcAlarmSensorsReadLog()
    expect(log.next(4, 4)).toBeNull()
    expect(log.next(4, 0)?.level).toBe('warn')
    expect(log.next(4, 0)).toBeNull()
    expect(log.next(4, 1)).toEqual({
      level: 'info',
      message: 'alarm sensors read: devices answer again',
      meta: { asked: 4, answered: 1 },
    })
    expect(log.next(4, 3)).toBeNull()
  })
  it('an empty ask is not a failure', () => {
    expect(new NcAlarmSensorsReadLog().next(0, 0)).toBeNull()
  })
})
