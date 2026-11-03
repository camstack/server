import { describe, expect, it } from 'vitest'
import { instanceOverlay, splitInstanceKeys } from '../instance-flags.js'
import { haMediaRoleOf } from '../media-url.js'

const ROWS = [
  {
    integrationId: 'int_a',
    brokerId: 'ha_a',
    settings: { exportTo: true, mediaRole: 'publicEndpoint' },
  },
  { integrationId: 'int_b', brokerId: 'ha_b', settings: {} },
  { integrationId: 'int_x', brokerId: null, settings: {} },
]

describe('export form keys and the integration', () => {
  it('sends a broker key to its integration and keeps the rest, incl. a broker without one', () => {
    const { toInstances, rest } = splitInstanceKeys(
      {
        'exportTo:ha_b': true,
        'mediaRole:ha_b': 'publicEndpoint',
        'exportTo:ha_gone': true,
        other: 1,
      },
      ROWS,
    )
    expect(toInstances.get('int_b')).toEqual({ exportTo: true, mediaRole: 'publicEndpoint' })
    expect(toInstances.has('int_a')).toBe(false)
    expect(rest).toEqual({ 'exportTo:ha_gone': true, other: 1 })
  })

  it('overlays each instance value on the form, only for what it has', () => {
    expect(instanceOverlay(ROWS)).toEqual({
      'exportTo:ha_a': true,
      'mediaRole:ha_a': 'publicEndpoint',
    })
  })

  it('media role: integration first, legacy key until moved', () => {
    const perBroker = new Map([['ha_a', { mediaRole: 'internal' }]])
    expect(haMediaRoleOf({ 'mediaRole:ha_a': 'publicEndpoint' }, 'ha_a', perBroker)).toBe(
      'internal',
    )
    expect(haMediaRoleOf({ 'mediaRole:ha_b': 'publicEndpoint' }, 'ha_b', perBroker)).toBe(
      'publicEndpoint',
    )
  })
})
