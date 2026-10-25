/* eslint-disable @typescript-eslint/consistent-type-assertions -- test mocks cross typed service boundaries */
/**
 * F0.6 integration — the scope matcher's ancestor lookup resolves a FORKED
 * device's parent through the persisted mirror, NOT the (empty-for-forked) hub
 * DeviceRegistry. Exercised through the REAL `createTrpcContext` so the WIRING
 * is under test, not a hand-rolled tree (the pre-existing `scope-access-device`
 * spec already covers the matcher against a fake lookup — and passed green the
 * whole time production inheritance did nothing).
 *
 * The bug: `makeDeviceScopeLookup` (was `makeAncestorLookup`) walked
 * `addonRegistry.getDeviceRegistry()`, which only holds hub-local devices → a
 * grant on a forked camera never covered its accessory children (measured 0/6
 * providers inherited). Neutralisation: revert the lookup to the
 * `getDeviceRegistry` walk and the "child resolves its forked parent"
 * expectation flips to `[]` — the exact silent failure.
 */
import { describe, expect, it } from 'vitest'
import type { AddonRegistryService } from '../../../core/addon/addon-registry.service.js'
import type { AuthService } from '../../../core/auth/auth.service.js'
import { createTrpcContext } from '../trpc.context.js'
import type { TrpcRequest } from '../trpc.context.js'

// A forked provider camera (id 5, top-level) with an accessory child (id 42).
// The child is ABSENT from the hub DeviceRegistry (it lives in a forked runner);
// only the persisted mirror knows its parentage.
const PERSISTED_ANCESTORS: Record<number, readonly number[]> = { 42: [5], 5: [] }

function fakeRegistry(): AddonRegistryService {
  return {
    getPersistedAncestors: (id: number) => PERSISTED_ANCESTORS[id] ?? [],
    // What the OLD implementation walked. The forked child 42 is NOT here, so
    // the old path returns [] — the neutralisation target.
    getDeviceRegistry: () => ({
      getById: (id: number) => (id === 5 ? { id: 5, parentDeviceId: null } : null),
    }),
  } as unknown as AddonRegistryService
}

const emptyReq = { headers: {} } as unknown as TrpcRequest
const fakeAuth = {
  verifyToken: () => {
    throw new Error('this test drives a token-less request')
  },
} as unknown as AuthService

describe('makeAncestorLookup through the real TrpcContext (F0.6)', () => {
  it('resolves a FORKED device child to its persisted parent', async () => {
    const ctx = await createTrpcContext(emptyReq, fakeAuth, fakeRegistry())
    expect(ctx.deviceScopeLookup?.getAncestors(42)).toEqual([5])
  })

  it('a known child NEVER resolves to [] — guard against the silent 0/6 regression', async () => {
    const ctx = await createTrpcContext(emptyReq, fakeAuth, fakeRegistry())
    const ancestors = ctx.deviceScopeLookup?.getAncestors(42) ?? []
    expect(ancestors.length).toBeGreaterThan(0)
    expect(ancestors).toContain(5)
  })

  it('a top-level device has no ancestors', async () => {
    const ctx = await createTrpcContext(emptyReq, fakeAuth, fakeRegistry())
    expect(ctx.deviceScopeLookup?.getAncestors(5)).toEqual([])
  })
})
