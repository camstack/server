/**
 * D911 — a CRITICAL alert whose source is a DEVICE is announced in the devices
 * family (`device-attention-required` / `-resolved`), carrying the device id,
 * and NOT as `alert-critical`: one alert never notifies twice through two
 * families.
 */
import {
  alertEpisodePayload,
  DeviceType,
  EventCategory,
  type Alert,
  type SystemEvent,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceLookup } from '../device-directory.js'
import { incomingFromSystemEvent } from '../event-intake.js'

const NOW = Date.UTC(2026, 9, 22, 6, 0)

const ROBOT: NcDeviceLookup = (deviceId: number) => ({
  deviceId,
  type: DeviceType.Camera,
  name: 'Dreame',
  isCamera: true,
})

const alertOf = (over: Partial<Alert> = {}): Alert => ({
  id: 'dreame.pin-required:42',
  category: 'device.credentials-required',
  severity: 'critical',
  title: 'PIN required',
  message: 'Dreame needs its PIN',
  status: 'active',
  read: false,
  createdAt: NOW,
  updatedAt: NOW,
  source: { type: 'device', id: '42' },
  action: { label: 'Enter PIN', href: '/devices/42' },
  metadata: { episodeId: 'dreame.pin-required:42@1' },
  ...over,
})

const episode = (alert: Alert, phase: 'raised' | 'resolved'): SystemEvent => ({
  id: 'ev-1',
  timestamp: new Date(NOW),
  source: { type: 'addon', id: 'alert-center', nodeId: 'hub' },
  category: EventCategory.AlertEpisode,
  data: { ...alertEpisodePayload(alert, phase, NOW) },
})

describe('D911 — a device-sourced critical alert is a device-attention edge', () => {
  it('raised maps to device-attention-required with the device id, not alert-critical', () => {
    const incoming = incomingFromSystemEvent(episode(alertOf(), 'raised'), ROBOT)
    expect(incoming?.subject.systemEvent).toMatchObject({
      kind: 'device-attention-required',
      subject: 'alert:dreame.pin-required:42@1',
      deviceId: 42,
      deviceType: DeviceType.Camera,
      titleKey: 'system.device-attention-required.title',
      textParams: expect.objectContaining({
        deviceName: 'Dreame',
        title: 'PIN required',
        message: 'Dreame needs its PIN',
        actionUrl: '/devices/42',
      }),
    })
    expect(incoming?.subject.deviceId).toBe(42)
  })

  it('the resolved edge maps to device-attention-resolved', () => {
    const incoming = incomingFromSystemEvent(
      episode(alertOf({ status: 'completed' }), 'resolved'),
      ROBOT,
    )
    expect(incoming?.subject.systemEvent?.kind).toBe('device-attention-resolved')
  })

  it('a non-device source stays alert-critical', () => {
    const incoming = incomingFromSystemEvent(
      episode(alertOf({ source: { type: 'addon', id: 'recorder' } }), 'raised'),
      ROBOT,
    )
    expect(incoming?.subject.systemEvent?.kind).toBe('alert-critical')
  })

  it('a device-sourced ERROR alert stays alert-error (only critical needs the operator)', () => {
    const incoming = incomingFromSystemEvent(
      episode(alertOf({ severity: 'error' }), 'raised'),
      ROBOT,
    )
    expect(incoming?.subject.systemEvent?.kind).toBe('alert-error')
  })

  it('a device source that is not a device id falls back to alert-critical', () => {
    const incoming = incomingFromSystemEvent(
      episode(alertOf({ source: { type: 'device', id: 'not-a-number' } }), 'raised'),
      ROBOT,
    )
    expect(incoming?.subject.systemEvent?.kind).toBe('alert-critical')
  })
})
