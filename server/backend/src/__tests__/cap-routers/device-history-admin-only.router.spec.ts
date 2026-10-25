/**
 * `device-history` (D850): the producer door (`declareSeries`, `record`,
 * `recordBuckets`), the per-device switch and the operator status are ADMIN-only
 * — a signed-in viewer must not write another addon's series or silence a
 * device's history. The two reads (`listSeries`, `query`) and the switch's read
 * stay `protected`, pinned so a widening is a diff.
 *
 * Two layers, as in `device-state-claims-admin-only.router.spec.ts`: the tier
 * each method RESOLVES to, and the LIVE router refusing every access role with
 * the tier's message. An admin reaching the same inputs proves the refusal is the
 * tier's, not a parse failure.
 */
import type { CapabilityDefinition } from '@camstack/types'
import {
  ACCESS_ROLES,
  buildRoleScopes,
  type CapabilityMethodSchema,
  deviceHistoryCapability,
  resolveMethodAuth,
  type TokenScope,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

const def: CapabilityDefinition = deviceHistoryCapability

const ADMIN_METHODS = [
  'declareSeries',
  'record',
  'recordBuckets',
  'setDeviceEnabled',
  'getStatus',
  'listNodeSeries',
  'queryNode',
  'queryMany',
] as const
const PROTECTED_METHODS = ['listSeries', 'query', 'getDeviceEnabled'] as const

const INPUTS: Readonly<Record<(typeof ADMIN_METHODS)[number], Record<string, unknown>>> = {
  declareSeries: {
    name: 'load',
    subjectKind: 'node',
    kind: 'gauge',
    displayName: 'Load',
    ingest: 'buckets',
  },
  record: { points: [] },
  recordBuckets: { buckets: [] },
  setDeviceEnabled: { deviceId: 7, enabled: false },
  getStatus: {},
  listNodeSeries: { forNodeId: 'agent-a' },
  queryNode: { forNodeId: 'agent-a', key: 'k', from: 0, to: 1 },
  queryMany: { items: [{ forNodeId: 'agent-a', key: 'k' }], from: 0, to: 1 },
}

type AccessRoleId = (typeof ACCESS_ROLES)[number]['id']

function roleScopes(roleId: AccessRoleId): readonly TokenScope[] {
  return buildRoleScopes({ roleId, selector: { kind: 'all' }, includeLinked: true })
}

function anyProvider(): Readonly<Record<string, () => Promise<unknown>>> {
  return new Proxy({}, { get: () => async () => ({ ok: true, accepted: 0, refused: [] }) })
}

describe('device-history: tier', () => {
  const all: Readonly<Record<string, CapabilityMethodSchema>> = deviceHistoryCapability.methods

  it('the producer door, the switch and the status resolve to admin', () => {
    for (const name of ADMIN_METHODS) {
      const schema = all[name]
      if (schema === undefined) throw new Error(`device-history.${name} no longer exists`)
      expect(resolveMethodAuth(def, schema), name).toBe('admin')
    }
  })

  it('the reads stay protected', () => {
    for (const name of PROTECTED_METHODS) {
      const schema = all[name]
      if (schema === undefined) throw new Error(`device-history.${name} no longer exists`)
      expect(resolveMethodAuth(def, schema), name).toBe('protected')
    }
  })
})

describe('device-history: live router', () => {
  it('viewer, operator and manager are refused by the tier on every admin method', async () => {
    const router = buildCapRouterForTest('device-history', () => anyProvider())
    for (const roleId of ACCESS_ROLES.map((r) => r.id)) {
      const ctx = makeCtx('user', { scopes: roleScopes(roleId) })
      for (const method of ADMIN_METHODS) {
        const result = await invokeProcedure(router, method, ctx, INPUTS[method])
        expect(result.ok, `${roleId} reached device-history.${method}`).toBe(false)
        if (!result.ok) expect(result.message).toBe('Admin required')
      }
    }
  })

  it('an admin reaches every admin method with the same input', async () => {
    const router = buildCapRouterForTest('device-history', () => anyProvider())
    for (const method of ADMIN_METHODS) {
      const result = await invokeProcedure(router, method, makeCtx('admin'), INPUTS[method])
      expect(
        result.ok,
        `admin refused on device-history.${method}: ${JSON.stringify(result)}`,
      ).toBe(true)
    }
  })
})
