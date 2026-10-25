/**
 * The device RESTORE surface and the export PUBLISH surface are admin-only
 * (D634 fix round 3, review R2-H2 + Low).
 *
 * - `deviceManager.loadConfig` returned the raw persisted device config — the
 *   camera `password` in plaintext — to any viewer; `persistConfig` let an
 *   operator overwrite any device's config; `loadRuntimeState` returns every
 *   cap's persisted slice. Their only callers are device providers over
 *   `ctx.api`, which never enters this router.
 * - `deviceExport.exposeDevice` / `unexposeDevice` let an operator publish any
 *   camera to HomeKit / Alexa / Google. The only UI caller is the admin export
 *   panel.
 */
import {
  ACCESS_ROLES,
  buildRoleScopes,
  type CapabilityDefinition,
  type CapabilityMethodSchema,
  brokerCapability,
  deviceExportCapability,
  deviceOpsCapability,
  deviceManagerCapability,
  mqttBrokerCapability,
  resolveMethodAuth,
  type TokenScope,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

const CASES: ReadonlyArray<{
  readonly cap: CapabilityDefinition
  readonly capName: string
  readonly methods: readonly string[]
  readonly input: Record<string, unknown>
}> = [
  {
    cap: deviceManagerCapability,
    capName: 'device-manager',
    methods: ['loadConfig', 'persistConfig', 'loadRuntimeState'],
    input: { deviceId: 101, config: { password: 'x' } },
  },
  {
    cap: deviceExportCapability,
    capName: 'device-export',
    methods: ['exposeDevice', 'unexposeDevice'],
    input: { deviceId: '101' },
  },
  // ── Round-3 sweep ──
  // deviceOps.setConfig rewrites a device's CONNECTION config (host,
  // password): an operator could point a camera's stored credentials at a
  // host of their own — the notifier exfiltration again. removeDevice is the
  // driver-cleanup half of a deletion, reachable only through the manager.
  {
    cap: deviceOpsCapability,
    capName: 'device-ops',
    methods: ['setConfig', 'removeDevice'],
    input: { deviceId: 101, values: { host: 'attacker.example' } },
  },
  // mqttBroker.getBrokerConfig returns the DECRYPTED broker password (by
  // design, for addons over ctx.api); the rest manage brokers. No UI caller.
  {
    cap: mqttBrokerCapability,
    capName: 'mqtt-broker',
    methods: [
      'getBrokerConfig',
      'addBroker',
      'removeBroker',
      'testConnection',
      'startEmbeddedBroker',
      'stopEmbeddedBroker',
    ],
    input: { id: 'b1', name: 'x', url: 'mqtt://h', port: 1883 },
  },
  // broker.getState is the raw upstream entity cache (Home Assistant camera
  // entities carry an `access_token`). Only addons read it.
  {
    cap: brokerCapability,
    capName: 'broker',
    methods: ['getState'],
    input: { brokerId: 'ha', key: 'camera.front door' },
  },
]

function roleScopes(roleId: (typeof ACCESS_ROLES)[number]['id']): readonly TokenScope[] {
  return buildRoleScopes({ roleId, selector: { kind: 'all' }, includeLinked: true })
}

/** A provider answering every method: the plaintext row a restore would read. */
function anyProvider(): Readonly<Record<string, () => Promise<unknown>>> {
  return new Proxy(
    {},
    {
      get: () => async () => ({ host: '192.168.10.139', password: 'hunter2-not-real' }),
    },
  )
}

describe('device restore + export publish: tier', () => {
  for (const { cap, methods } of CASES) {
    it(`${cap.name}: ${methods.join(', ')} resolve to admin`, () => {
      const all: Readonly<Record<string, CapabilityMethodSchema>> = cap.methods
      for (const name of methods) {
        const schema = all[name]
        if (schema === undefined) throw new Error(`${cap.name}.${name} no longer exists`)
        expect(resolveMethodAuth(cap, schema), `${cap.name}.${name}`).toBe('admin')
      }
    })
  }
})

describe('device restore + export publish: live router', () => {
  for (const { capName, methods, input } of CASES) {
    it(`${capName}: viewer, operator and manager are refused by the tier`, async () => {
      const router = buildCapRouterForTest(capName, () => anyProvider())
      for (const roleId of ACCESS_ROLES.map((r) => r.id)) {
        const ctx = makeCtx('user', { scopes: roleScopes(roleId) })
        for (const method of methods) {
          const result = await invokeProcedure(router, method, ctx, input)
          expect(result.ok, `${roleId} reached ${capName}.${method}`).toBe(false)
          if (!result.ok) expect(result.message).toBe('Admin required')
        }
      }
    })
  }

  it('an admin still reads a device config (the restore path is not broken for admins)', async () => {
    const router = buildCapRouterForTest('device-manager', () => anyProvider())
    const result = await invokeProcedure(router, 'loadConfig', makeCtx('admin'), { deviceId: 101 })
    expect(result.ok).toBe(true)
  })
})
