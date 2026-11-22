/**
 * A device fault is announced at every tier. Which episodes are announced, at
 * what rank, and as which system-event kind is one vocabulary shared by the
 * alert centre and Notification Center.
 */
import { describe, expect, it } from 'vitest'
import {
  alertEpisodeEdgeKind,
  alertEpisodeRank,
  deviceAttentionKind,
  deviceAttentionSeverity,
  isAnnouncedAlertEpisode,
} from '../alert-episode.js'
import { buildDeviceErrorAlert } from '../../device/device-error-episode.js'

const FAULT = { severity: 'warning', category: 'device.error' } as const
const OTHER_WARNING = { severity: 'warning', category: 'storage.low' } as const

describe('which alert episodes are announced', () => {
  it('announces a device fault at its warning tier, and no other warning', () => {
    expect(isAnnouncedAlertEpisode(FAULT)).toBe(true)
    expect(isAnnouncedAlertEpisode(OTHER_WARNING)).toBe(false)
    expect(isAnnouncedAlertEpisode({ severity: 'info', category: 'device.error' })).toBe(false)
  })

  it('ranks warning below error below critical', () => {
    expect(alertEpisodeRank(FAULT)).toBeLessThan(
      alertEpisodeRank({ severity: 'error', category: 'x' }),
    )
    expect(alertEpisodeRank({ severity: 'error', category: 'x' })).toBeLessThan(
      alertEpisodeRank({ severity: 'critical', category: 'x' }),
    )
    expect(alertEpisodeRank(OTHER_WARNING)).toBe(0)
  })
})

describe('the device-attention tier', () => {
  it('is warning for a warning fault and error for a critical device alert', () => {
    expect(deviceAttentionSeverity(FAULT)).toBe('warning')
    expect(
      deviceAttentionSeverity({
        severity: 'critical',
        category: 'device.error',
      }),
    ).toBe('error')
    expect(deviceAttentionSeverity({ severity: 'critical', category: 'device.pin' })).toBe('error')
    expect(deviceAttentionSeverity(OTHER_WARNING)).toBeNull()
    expect(deviceAttentionSeverity({ severity: 'error', category: 'device.error' })).toBeNull()
  })

  it('maps both edges of a warning fault to the device-attention pair', () => {
    expect(deviceAttentionKind(FAULT, 'raised')).toBe('device-attention-required')
    expect(deviceAttentionKind(FAULT, 'resolved')).toBe('device-attention-resolved')
    expect(deviceAttentionKind(OTHER_WARNING, 'raised')).toBeNull()
  })

  it('sends a device edge as device-attention and any other source as an alert kind', () => {
    expect(alertEpisodeEdgeKind({ ...FAULT, sourceType: 'device', phase: 'raised' })).toBe(
      'device-attention-required',
    )
    expect(alertEpisodeEdgeKind({ ...FAULT, sourceType: 'node', phase: 'raised' })).toBeNull()
    expect(
      alertEpisodeEdgeKind({
        severity: 'critical',
        category: 'x',
        sourceType: 'node',
        phase: 'resolved',
      }),
    ).toBe('alert-critical-resolved')
  })

  it('the alert a warning fault opens is one the centre announces', () => {
    const alert = buildDeviceErrorAlert(
      7,
      'Boiler',
      {
        active: true,
        code: 'LOW_BAT',
        label: 'Battery low',
        severity: 'warning',
        since: 1,
        lastFetchedAt: 1,
      },
      2,
    )
    expect(isAnnouncedAlertEpisode(alert)).toBe(true)
    expect(deviceAttentionSeverity(alert)).toBe('warning')
  })
})
