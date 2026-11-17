/**
 * The scheduler decides on what a device REPORTED (D1061): its host reads a
 * device's slice in the confirmed view, so a command the hub holds never
 * reads as already done.
 */
import type { AddonApi } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { hostOver } from '../scheduler/scheduler-wiring.js'

describe('scheduler host (D1061)', () => {
  it("reads a device's slice in the confirmed view", async () => {
    const query = vi.fn(async () => ({ on: false }))
    const api = { deviceState: { getCapSlice: { query } } }
    await hostOver(() => api as unknown as AddonApi).fetchSlice(3, 'switch')
    expect(query).toHaveBeenCalledWith({ deviceId: 3, capName: 'switch', confirmed: true })
  })
})
