import { describe, it, expect, vi } from 'vitest'
import type { IDevice } from '@camstack/types'
import { markBrokerDevicesOffline } from '../ha-broker-offline.js'

/** Minimal IDevice stub: a mutable online flag (read through a getter, written
 *  via markOnline mirroring BaseDevice's no-op-when-unchanged semantics) + a
 *  config.get that returns the device's brokerId. */
function makeDevice(id: number, brokerId: string, online: boolean): IDevice {
  let isOnline = online
  const dev = {
    id,
    config: { get: (k: string) => (k === 'brokerId' ? brokerId : undefined) },
    markOnline: vi.fn((next: boolean) => {
      if (isOnline !== next) isOnline = next
    }),
  }
  Object.defineProperty(dev, 'online', { get: () => isOnline, configurable: true })
  return dev as unknown as IDevice
}

describe('markBrokerDevicesOffline (A2 — broker disconnect fans children offline)', () => {
  it('marks every online HA device of the broker offline', () => {
    const a = makeDevice(1, 'ha_001', true)
    const b = makeDevice(2, 'ha_001', true)

    const marked = markBrokerDevicesOffline([a, b], 'ha_001')

    expect(marked).toBe(2)
    expect(a.markOnline).toHaveBeenCalledWith(false)
    expect(b.markOnline).toHaveBeenCalledWith(false)
  })

  it('skips devices of a DIFFERENT broker', () => {
    const a = makeDevice(1, 'ha_001', true)
    const other = makeDevice(2, 'ha_002', true)

    const marked = markBrokerDevicesOffline([a, other], 'ha_001')

    expect(marked).toBe(1)
    expect(a.markOnline).toHaveBeenCalledWith(false)
    expect(other.markOnline).not.toHaveBeenCalled()
  })

  it('does not re-mark already-offline devices (churn-free)', () => {
    const alreadyOff = makeDevice(1, 'ha_001', false)

    const marked = markBrokerDevicesOffline([alreadyOff], 'ha_001')

    expect(marked).toBe(0)
    expect(alreadyOff.markOnline).not.toHaveBeenCalled()
  })
})
