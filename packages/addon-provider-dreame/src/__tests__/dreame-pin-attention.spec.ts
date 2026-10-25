import { AlertSchema, type Alert } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildPinAlert,
  classifyPinRefusal,
  PinAttention,
  pinAlertId,
} from '../devices/dreame-pin-attention.js'

const MISSING = new Error('startMonitor refused (code -1); device likely requires an accessCode')
const REJECTED = new Error('startMonitor refused (code -1)')

function harness() {
  const emitted: Alert[] = []
  const resolved: string[] = []
  const attention = new PinAttention({
    deviceId: 42,
    deviceName: () => 'Dreame',
    emit: async (alert) => {
      emitted.push(alert)
    },
    resolve: async (id) => {
      resolved.push(id)
    },
  })
  return { attention, emitted, resolved }
}

describe('D911 — the camera PIN refusal', () => {
  it('tells a missing PIN from a rejected one, and ignores other failures', () => {
    expect(classifyPinRefusal(MISSING, false)).toBe('missing')
    expect(classifyPinRefusal(REJECTED, true)).toBe('rejected')
    expect(classifyPinRefusal(new Error('relay timeout'), false)).toBeNull()
  })

  it('the alert is a valid critical device alert with the deterministic id', () => {
    const alert = buildPinAlert(42, 'Dreame', 'missing')
    expect(AlertSchema.safeParse(alert).success).toBe(true)
    expect(alert).toMatchObject({
      id: 'dreame.pin-required:42',
      category: 'device.credentials-required',
      severity: 'critical',
      source: { type: 'device', id: '42' },
      action: { label: 'Enter PIN', href: '/devices/42', navigation: 'app' },
      metadata: { episodeKey: 'missing' },
    })
    expect(buildPinAlert(42, 'Dreame', 'rejected').title).not.toBe(alert.title)
    expect(pinAlertId(42)).toBe(alert.id)
  })

  it('two refused wakes raise ONE alert and block the wake; success resolves it', async () => {
    const { attention, emitted, resolved } = harness()
    expect(attention.blocked).toBe(false)
    expect(await attention.refused('missing')).toBe('raised')
    expect(await attention.refused('missing')).toBe('already-open')
    expect(emitted).toHaveLength(1)
    expect(attention.blocked).toBe(true)

    expect(await attention.succeeded()).toBe(true)
    expect(resolved).toEqual(['dreame.pin-required:42'])
    expect(attention.blocked).toBe(false)
  })

  it('a changed PIN lifts the block; a still-wrong PIN raises a fresh episode', async () => {
    const { attention, emitted, resolved } = harness()
    await attention.refused('missing')
    await attention.settingChanged()
    expect(attention.blocked).toBe(false)
    expect(resolved).toHaveLength(1)
    await attention.refused('rejected')
    expect(emitted).toHaveLength(2)
    expect(emitted[1]?.metadata?.['episodeKey']).toBe('rejected')
  })

  it('a success with no open episode resolves nothing', async () => {
    const { attention, resolved } = harness()
    expect(await attention.succeeded()).toBe(false)
    expect(resolved).toEqual([])
  })
})
