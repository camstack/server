/**
 * A claim rewrites what every consumer reads for a device's field — the claim
 * methods of `device-state` are ADMIN-only (D663), like the composition API.
 *
 * Two layers, as in `core-blocks-composition-admin-only.router.spec.ts`: the
 * tier each method RESOLVES to, and the LIVE router refusing every access role
 * with the tier's message. An admin reaching every method with the SAME input
 * proves the refusal is the tier's, not a parse failure. The four original
 * read/write methods keep their `protected` tier and are pinned here too, so a
 * widening is a diff; `getCapSlice` never answers the native shadow.
 */
import type { CapabilityDefinition } from '@camstack/types'
import {
  ACCESS_ROLES,
  buildRoleScopes,
  type CapabilityMethodSchema,
  deviceStateCapability,
  resolveMethodAuth,
  type TokenScope,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

/** Widened the way the router builder sees each cap — `resolveMethodAuth` reads only `internal`. */
const deviceStateDef: CapabilityDefinition = deviceStateCapability

/** The native shadow of a claimed cap is for the composer alone (D224): its read is admin-only too. */
const ADMIN_METHODS = [
  'claimFields',
  'patchOwnedFields',
  'releaseClaim',
  'listClaims',
  'getNativeCapSlice',
] as const
const PROTECTED_METHODS = ['getSnapshot', 'getCapSlice', 'getAllSnapshots', 'setCapSlice'] as const

/** One input every claim method parses (Zod strips the keys a method does not declare). */
const INPUT: Record<string, unknown> = {
  deviceId: 7,
  capName: 'battery',
  owner: 'blk-1',
  mode: 'replace',
  fields: ['percentage'],
  values: { level: 90 },
  ownerPrefix: 'blk-',
}

type AccessRoleId = (typeof ACCESS_ROLES)[number]['id']

function roleScopes(roleId: AccessRoleId): readonly TokenScope[] {
  return buildRoleScopes({ roleId, selector: { kind: 'all' }, includeLinked: true })
}

/** A provider answering every method: the router's tier must refuse BEFORE it is reached. */
function anyProvider(): Readonly<Record<string, () => Promise<unknown>>> {
  return new Proxy(
    {},
    { get: () => async () => ({ ok: true, changed: true, state: 'loaded', claims: [] }) },
  )
}

describe('device-state claims: tier', () => {
  const all: Readonly<Record<string, CapabilityMethodSchema>> = deviceStateCapability.methods

  it('claimFields, patchOwnedFields, releaseClaim, listClaims, getNativeCapSlice resolve to admin', () => {
    for (const name of ADMIN_METHODS) {
      const schema = all[name]
      if (schema === undefined) throw new Error(`device-state.${name} no longer exists`)
      expect(resolveMethodAuth(deviceStateDef, schema), name).toBe('admin')
    }
  })

  it('the read/write methods stay protected', () => {
    for (const name of PROTECTED_METHODS) {
      const schema = all[name]
      if (schema === undefined) throw new Error(`device-state.${name} no longer exists`)
      expect(resolveMethodAuth(deviceStateDef, schema), name).toBe('protected')
    }
  })
})

describe('device-state claims: live router', () => {
  it('viewer, operator and manager are refused by the tier on every claim method', async () => {
    const router = buildCapRouterForTest('device-state', () => anyProvider())
    for (const roleId of ACCESS_ROLES.map((r) => r.id)) {
      const ctx = makeCtx('user', { scopes: roleScopes(roleId) })
      for (const method of ADMIN_METHODS) {
        const result = await invokeProcedure(router, method, ctx, INPUT)
        expect(result.ok, `${roleId} reached device-state.${method}`).toBe(false)
        if (!result.ok) expect(result.message).toBe('Admin required')
      }
    }
  })

  it('a plain protected session is refused too', async () => {
    const router = buildCapRouterForTest('device-state', () => anyProvider())
    for (const method of ADMIN_METHODS) {
      const result = await invokeProcedure(router, method, makeCtx('user'), INPUT)
      expect(result.ok, `user reached device-state.${method}`).toBe(false)
      if (!result.ok) expect(result.message).toBe('Admin required')
    }
  })

  it('an admin reaches every claim method with the same input', async () => {
    const router = buildCapRouterForTest('device-state', () => anyProvider())
    for (const method of ADMIN_METHODS) {
      const result = await invokeProcedure(router, method, makeCtx('admin'), INPUT)
      expect(result.ok, `admin refused on device-state.${method}: ${JSON.stringify(result)}`).toBe(
        true,
      )
    }
  })
})
