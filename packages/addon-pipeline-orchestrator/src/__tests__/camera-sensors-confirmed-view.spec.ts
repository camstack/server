/**
 * A camera sensor drives the camera's onboard motion (D672) from what the
 * sensor REPORTED, never from a command the hub holds for it (D1061): the
 * `DeviceStateChanged` event carries `confirmed` while a hold changes the
 * slice, and the hub's motion slice is read in its confirmed view.
 */
import type { AddonApi } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { hubMotionSliceStore } from '../camera-sensors/motion-slice-hub.js'
import { reportedSensorSlice } from '../camera-sensors/sensor-state-event.js'

describe('camera sensors read the confirmed view (D1061)', () => {
  it('takes the confirmed slice when a hold changed the effective one', () => {
    expect(
      reportedSensorSlice({
        deviceId: 4,
        capName: 'switch',
        slice: { on: true },
        confirmed: { on: false },
      }),
    ).toEqual({ on: false })
  })

  it('takes the slice when no hold changed it, and refuses a missing slice', () => {
    expect(reportedSensorSlice({ deviceId: 4, capName: 'switch', slice: { on: true } })).toEqual({
      on: true,
    })
    expect(reportedSensorSlice({ deviceId: 4, capName: 'switch' })).toBeNull()
    expect(reportedSensorSlice({ deviceId: 4, capName: 'switch', slice: [1] })).toBeNull()
  })

  it("reads the camera's motion slice in the confirmed view", async () => {
    const query = vi.fn(async () => ({ detected: false }))
    const api = { deviceState: { getCapSlice: { query } } }
    const store = hubMotionSliceStore(() => api as unknown as AddonApi)
    await store.readSlice(9)
    expect(query).toHaveBeenCalledWith({ deviceId: 9, capName: 'motion', confirmed: true })
  })
})
