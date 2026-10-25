/**
 * Notifier credentials are reachable by an ADMIN only (security review
 * 2026-09-25, D634).
 *
 * Two doors were open to every non-admin role, because every role carries a
 * `category:system` grant and both caps were `protected`:
 *
 *  - `settingsStore.*` — a `viewer` could `query({ collection:
 *    'notifiers:notification-targets' })` and read every bot token, API key and
 *    webhook header of every user in plaintext (and every other addon's
 *    collection with it); an `operator` could write any of them.
 *  - `notificationOutput` target CRUD / test / send — an `operator` could point
 *    ANY target (another user's included) at a host of their choosing and let
 *    `testTarget` deliver the stored secret there.
 *
 * Both are now `auth: 'admin'`. Non-admins keep the owner-checked `nc.*`
 * bridge; addons keep `ctx.api`, whose cap calls never enter this router.
 *
 * Asserted in three layers, because they fail differently:
 *  1. the TIER each method resolves to (what the codegen and the runtime
 *     builder both build from);
 *  2. the scope MATCHER — every role's grants really do reach these methods,
 *     so the tier is the only thing standing between them and the data;
 *  3. the LIVE router — a viewer, an operator and a manager are refused, an
 *     admin is served.
 */
import {
  ACCESS_ROLES,
  buildRoleScopes,
  type CapabilityDefinition,
  type CapabilityMethodSchema,
  DeviceType,
  type INotificationOutputProvider,
  type ISettingsStoreProvider,
  notificationOutputCapability,
  resolveMethodAuth,
  settingsStoreCapability,
  type Target,
  type TokenScope,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { checkScopeAccess, type DeviceScopeLookup } from '../../api/trpc/scope-access.js'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

/** Widened the way the router builder sees each cap — `resolveMethodAuth` reads only `internal`. */
const settingsStoreDef: CapabilityDefinition = settingsStoreCapability
const notificationOutputDef: CapabilityDefinition = notificationOutputCapability

/** The notification-output methods that stay open to a session: descriptors only. */
const NOTIFICATION_OUTPUT_OPEN = new Set(['listTargetKinds'])

/** Every method of both caps that must refuse a non-admin. */
const SETTINGS_STORE_METHODS: readonly string[] = Object.keys(settingsStoreCapability.methods)
const NOTIFICATION_OUTPUT_ADMIN: readonly string[] = Object.keys(
  notificationOutputCapability.methods,
).filter((m) => !NOTIFICATION_OUTPUT_OPEN.has(m))

const lookup: DeviceScopeLookup = {
  getAncestors: () => [],
  getType: () => DeviceType.Camera,
  getLocation: () => null,
}

/** The grants a real user of each non-admin role carries (all devices). */
function roleScopes(roleId: (typeof ACCESS_ROLES)[number]['id']): readonly TokenScope[] {
  return buildRoleScopes({ roleId, selector: { kind: 'all' }, includeLinked: true })
}

function methodsOf(def: CapabilityDefinition): Readonly<Record<string, CapabilityMethodSchema>> {
  return def.methods
}

const TARGET: Target = {
  id: 'household',
  name: 'Household',
  kind: 'ntfy',
  addonId: 'notifiers',
  enabled: true,
  config: { serverUrl: 'https://ntfy.example', token: '__redacted__' },
}

function settingsStoreProvider(): ISettingsStoreProvider {
  return {
    get: async () => null,
    set: async () => undefined,
    query: async () => [{ id: 'household', data: { config: { token: 'plaintext' } } }],
    upsert: async () => ({ id: 'x' }),
    insert: async () => ({ id: 'x' }),
    insertMany: async () => ({ inserted: 0 }),
    upsertMany: async () => ({ upserted: 0 }),
    transact: async () => ({ applied: true }),
    update: async () => undefined,
    delete: async () => undefined,
    deleteWhere: async () => ({ deleted: 0 }),
    updateWhere: async () => ({ updated: 0 }),
    count: async () => 1,
    aggregate: async () => ({ count: 0, values: {} }),
    histogram: async () => [],
    isEmpty: async () => false,
    declareCollection: async () => undefined,
  }
}

function notificationOutputProvider(): INotificationOutputProvider {
  return {
    listTargetKinds: async () => [],
    listTargets: async () => [TARGET],
    getTarget: async () => TARGET,
    discoverTargets: async () => [],
    probeTargetConfig: async () => ({ ok: true, resolvedUrl: '' }),
    send: async () => ({ success: true }),
    testTarget: async () => ({ success: true }),
    upsertTarget: async ({ target }) => target,
    deleteTarget: async () => undefined,
    setTargetEnabled: async () => undefined,
  }
}

describe('tier: every credential-bearing method resolves to admin', () => {
  it('settings-store — all of it', () => {
    for (const [name, schema] of Object.entries(methodsOf(settingsStoreCapability))) {
      expect(resolveMethodAuth(settingsStoreDef, schema), `settingsStore.${name}`).toBe('admin')
    }
  })

  it('notification-output — everything but the kind catalog', () => {
    for (const [name, schema] of Object.entries(methodsOf(notificationOutputCapability))) {
      const expected = NOTIFICATION_OUTPUT_OPEN.has(name) ? 'protected' : 'admin'
      expect(resolveMethodAuth(notificationOutputDef, schema), `notificationOutput.${name}`).toBe(
        expected,
      )
    }
  })
})

describe('scope matcher: the role grants DO reach these paths — the tier is the gate', () => {
  it('a manager grant passes the matcher on every tightened method', () => {
    const scopes = roleScopes('manager')
    const paths = [
      ...SETTINGS_STORE_METHODS.map((m) => `settingsStore.${m}`),
      ...NOTIFICATION_OUTPUT_ADMIN.map((m) => `notificationOutput.${m}`),
    ]
    for (const path of paths) {
      const result = checkScopeAccess(scopes, path, {}, lookup)
      expect(result.ok, `${path}: ${result.ok ? '' : result.reason}`).toBe(true)
    }
  })

  it('a viewer grant alone reaches the plaintext read', () => {
    const result = checkScopeAccess(
      roleScopes('viewer'),
      'settingsStore.query',
      { collection: 'notifiers:notification-targets' },
      lookup,
    )
    expect(result.ok).toBe(true)
  })
})

describe('router: every non-admin role is refused, an admin is served', () => {
  const NON_ADMIN_ROLES = ACCESS_ROLES.map((r) => r.id)

  it('settings-store refuses viewer, operator and manager on every method', async () => {
    const router = buildCapRouterForTest('settings-store', () => settingsStoreProvider())
    for (const roleId of NON_ADMIN_ROLES) {
      const ctx = makeCtx('user', { scopes: roleScopes(roleId) })
      for (const method of SETTINGS_STORE_METHODS) {
        const result = await invokeProcedure(router, method, ctx, {
          collection: 'notifiers:notification-targets',
          key: 'household',
        })
        expect(result.ok, `${roleId} reached settingsStore.${method}`).toBe(false)
        if (!result.ok) {
          expect(result.code, `${roleId} settingsStore.${method}`).toBe('FORBIDDEN')
          // The TIER refused, not the scope matcher (review L4).
          expect(result.message).toBe('Admin required')
        }
      }
    }
  })

  it('notification-output refuses viewer, operator and manager on every tightened method', async () => {
    const router = buildCapRouterForTest('notification-output', () => notificationOutputProvider())
    for (const roleId of NON_ADMIN_ROLES) {
      const ctx = makeCtx('user', { scopes: roleScopes(roleId) })
      for (const method of NOTIFICATION_OUTPUT_ADMIN) {
        const result = await invokeProcedure(router, method, ctx, {
          targetId: 'household',
          target: TARGET,
        })
        expect(result.ok, `${roleId} reached notificationOutput.${method}`).toBe(false)
        if (!result.ok) {
          expect(result.code, `${roleId} notificationOutput.${method}`).toBe('FORBIDDEN')
          expect(result.message).toBe('Admin required')
        }
      }
    }
  })

  it('a non-admin still reads the kind catalog (descriptors carry no secret)', async () => {
    const router = buildCapRouterForTest('notification-output', () => notificationOutputProvider())
    const ctx = makeCtx('user', { scopes: roleScopes('viewer') })
    const result = await invokeProcedure(router, 'listTargetKinds', ctx, {})
    expect(result.ok).toBe(true)
  })

  it('an admin is served on both caps', async () => {
    const store = buildCapRouterForTest('settings-store', () => settingsStoreProvider())
    const read = await invokeProcedure(store, 'query', makeCtx('admin'), {
      collection: 'notifiers:notification-targets',
    })
    expect(read.ok).toBe(true)

    const outputs = buildCapRouterForTest('notification-output', () => notificationOutputProvider())
    const list = await invokeProcedure(outputs, 'listTargets', makeCtx('admin'), {})
    expect(list.ok).toBe(true)
    const upsert = await invokeProcedure(outputs, 'upsertTarget', makeCtx('admin'), {
      target: TARGET,
    })
    expect(upsert.ok).toBe(true)
    const test = await invokeProcedure(outputs, 'testTarget', makeCtx('admin'), {
      targetId: 'household',
      addonId: 'notifiers',
    })
    expect(test.ok).toBe(true)
  })
})
