/**
 * D1099 — a `device-status` slice marked `unknown` is a placeholder, not a
 * liveness claim: a restarting integration must not produce a device-offline.
 */
import type { SystemEvent } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceIdentity } from '../device-directory.js'
import { incomingFromSystemEvent } from '../event-intake.js'

const LOOKUP = (deviceId: number): NcDeviceIdentity => ({
  deviceId,
  type: DeviceType.Camera,
  name: 'Hall',
  isCamera: true,
  parentDeviceId: null,
})

function sliceEvent(slice: Record<string, unknown>): SystemEvent {
  return {
    id: 'slice-9',
    timestamp: new Date(3_000),
    source: { type: 'device', id: 9 },
    category: 'device.state-changed',
    data: { deviceId: 9, capName: 'device-status', slice },
  }
}

describe('an unknown device-status slice is not a liveness claim (D1099)', () => {
  it('says nothing while the integration has not answered', () => {
    const slice = { online: false, lastChangedAt: 3_000, unknown: true }
    expect(incomingFromSystemEvent(sliceEvent(slice), LOOKUP)).toBeNull()
  })

  it('still announces a real offline once the provider answered', () => {
    const incoming = incomingFromSystemEvent(
      sliceEvent({ online: false, lastChangedAt: 3_000 }),
      LOOKUP,
    )
    expect(incoming?.subject.systemEvent?.kind).toBe('device-offline')
  })
})
