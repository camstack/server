/**
 * `vehicle.requestRefresh` through the REAL router: waking a car spends the
 * maker's daily quota, so the method is ADMIN-tier, routes by `deviceId`, and
 * passes both arms of its typed result through untouched (an expected refusal
 * is an answer, not a throw). The router does not re-validate output, so the
 * shape is pinned here.
 */
import {
  type CapabilityMethodSchema,
  METHOD_ACCESS_MAP,
  resolveMethodAuth,
  type VehicleRefreshResult,
  vehicleCapability,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

const VEHICLE = 7

const REFUSAL: VehicleRefreshResult = { ok: false, reason: 'budget-exhausted', retryAt: 1234 }
const SUCCESS: VehicleRefreshResult = { ok: true, reportedAt: 99 }

function providerAnswering(result: VehicleRefreshResult, seen: number[]) {
  return {
    requestRefresh: async (input: { readonly deviceId: number }) => {
      seen.push(input.deviceId)
      return result
    },
  }
}

describe('vehicle.requestRefresh: tier', () => {
  it('resolves to admin', () => {
    const schema: CapabilityMethodSchema = vehicleCapability.methods.requestRefresh
    expect(resolveMethodAuth(vehicleCapability, schema)).toBe('admin')
    expect(METHOD_ACCESS_MAP['vehicle.requestRefresh']).toBeDefined()
  })
})

describe('vehicle.requestRefresh: live router', () => {
  it('refuses a non-admin before the provider is reached', async () => {
    const seen: number[] = []
    const router = buildCapRouterForTest('vehicle', () => providerAnswering(SUCCESS, seen))
    const result = await invokeProcedure(router, 'requestRefresh', makeCtx('user'), {
      deviceId: VEHICLE,
    })
    expect(result.ok).toBe(false)
    expect(seen).toEqual([])
  })

  it('routes an admin call by deviceId and passes a success through', async () => {
    const seen: number[] = []
    const router = buildCapRouterForTest('vehicle', () => providerAnswering(SUCCESS, seen))
    const result = await invokeProcedure(router, 'requestRefresh', makeCtx('admin'), {
      deviceId: VEHICLE,
    })
    expect(result).toEqual({ ok: true, value: SUCCESS })
    expect(seen).toEqual([VEHICLE])
  })

  it('passes a typed refusal through as an answer, not an error', async () => {
    const seen: number[] = []
    const router = buildCapRouterForTest('vehicle', () => providerAnswering(REFUSAL, seen))
    const result = await invokeProcedure(router, 'requestRefresh', makeCtx('admin'), {
      deviceId: VEHICLE,
    })
    expect(result).toEqual({ ok: true, value: REFUSAL })
  })
})
