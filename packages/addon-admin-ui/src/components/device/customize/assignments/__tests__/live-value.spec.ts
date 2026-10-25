import { describe, expect, it } from 'vitest'
import { type LiveValueLabels, liveValueDisplay, liveValueOf } from '../live-value'

const LABELS: LiveValueLabels = {
  active: 'active',
  inactive: 'inactive',
  open: 'open',
  closed: 'closed',
}
const PIR = { deviceId: 3299, cap: 'motion', path: 'detected' }

describe('liveValueOf — four answered states (D315)', () => {
  it('pending while nothing answered, unknown on a failed read, absent on an answered null slice', () => {
    expect(liveValueOf({ status: 'pending' }, undefined, 'detected')).toEqual({ kind: 'pending' })
    expect(
      liveValueOf({ status: 'error', error: { message: 'boom' } }, undefined, 'detected'),
    ).toEqual({ kind: 'unknown', reason: 'boom' })
    expect(liveValueOf({ status: 'success', data: null }, undefined, 'detected')).toEqual({
      kind: 'absent',
    })
  })
  it('a slice that answers without the field is absent, never a value', () => {
    expect(
      liveValueOf({ status: 'success', data: { lastDetectedAt: 1 } }, undefined, 'detected'),
    ).toEqual({ kind: 'absent' })
  })
  it('a pushed slice wins over the first read — even over a failed one', () => {
    expect(
      liveValueOf({ status: 'success', data: { detected: false } }, { detected: true }, 'detected'),
    ).toEqual({ kind: 'value', value: true })
    expect(
      liveValueOf({ status: 'error', error: { message: 'x' } }, { detected: true }, 'detected'),
    ).toEqual({ kind: 'value', value: true })
  })
  it('reads a dotted path', () => {
    expect(
      liveValueOf(
        { status: 'success', data: { remaining: { value: 18 } } },
        undefined,
        'remaining.value',
      ),
    ).toEqual({ kind: 'value', value: 18 })
  })
})

describe('liveValueDisplay', () => {
  it('never renders an unanswered value as empty', () => {
    expect(liveValueDisplay({ kind: 'pending' }, PIR, LABELS).text).toBe('…')
    expect(liveValueDisplay({ kind: 'unknown', reason: 'boom' }, PIR, LABELS)).toEqual({
      text: '?',
      title: 'boom',
      tone: 'warning',
    })
    expect(liveValueDisplay({ kind: 'absent' }, PIR, LABELS).text).toBe('—')
  })
  it("a source cap's active field reads active / inactive, a contact open / closed", () => {
    expect(liveValueDisplay({ kind: 'value', value: true }, PIR, LABELS)).toEqual({
      text: 'active',
      tone: 'active',
    })
    expect(liveValueDisplay({ kind: 'value', value: false }, PIR, LABELS)).toEqual({
      text: 'inactive',
      tone: 'muted',
    })
    const gate = { deviceId: 3301, cap: 'contact', path: 'entryOpen' }
    expect(liveValueDisplay({ kind: 'value', value: false }, gate, LABELS).text).toBe('closed')
  })
  it('a battery percentage carries its unit; a null field is a dash', () => {
    const battery = { deviceId: 103, cap: 'battery', path: 'percentage' }
    expect(liveValueDisplay({ kind: 'value', value: 87.4 }, battery, LABELS).text).toBe('87 %')
    const press = { deviceId: 101, cap: 'doorbell', path: 'lastPressedAt' }
    expect(liveValueDisplay({ kind: 'value', value: null }, press, LABELS).text).toBe('—')
  })
})
