/**
 * A grant on a camera operates the accessories attached to it (D918).
 *
 * Observed on the live hub, 2026-10-23: a non-admin user granted a Reolink
 * camera (3628) called `motionTrigger.setMotionTrigger` on its siren child
 * (3630) and its light child (3631) and got `FORBIDDEN: Admin required`.
 * `switch.setState` on the same children had been `protected` since D403;
 * `motion-trigger` had been left `admin`, so the tier refused the call before
 * the device grant — and its parent → child walk — was ever consulted.
 *
 * Three layers:
 *   - the tier each accessory-control method RESOLVES to;
 *   - the live router with a device lookup that knows the parentage, proving
 *     the camera grant reaches the child, and ONLY that camera's children;
 *   - configuration of the camera (`accessories.setChildHidden`) stays admin.
 */
import type { CapabilityDefinition, CapabilityMethodSchema, TokenScope } from '@camstack/types'
import {
  accessoriesCapability,
  buildRoleScopes,
  motionTriggerCapability,
  resolveMethodAuth,
  switchCapability,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { TrpcContext } from '../../api/trpc/trpc.context.js'
import type { DeviceScopeLookup } from '../../api/trpc/scope-access.js'
import { buildMountedCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

const CAMERA = 3628
const SIREN = 3630
const LIGHT = 3631
const OTHER_CAMERA = 5000
const OTHER_SIREN = 5001

/** The persisted parentage, as the hub's mirror answers it. */
const PARENT: ReadonlyMap<number, number> = new Map([
  [SIREN, CAMERA],
  [LIGHT, CAMERA],
  [OTHER_SIREN, OTHER_CAMERA],
])

const TYPE: ReadonlyMap<number, string> = new Map([
  [CAMERA, 'camera'],
  [SIREN, 'siren'],
  [LIGHT, 'light'],
  [OTHER_CAMERA, 'camera'],
  [OTHER_SIREN, 'siren'],
])

const lookup: DeviceScopeLookup = {
  getAncestors: (deviceId) => {
    const parent = PARENT.get(deviceId)
    return parent === undefined ? [] : [parent]
  },
  getType: (deviceId) => TYPE.get(deviceId) ?? null,
  getLocation: () => null,
}

function userCtx(scopes: readonly TokenScope[]): TrpcContext {
  return { ...makeCtx('user', { scopes }), deviceScopeLookup: lookup }
}

/** What the Access panel writes for "Operate" on the one camera. */
const OPERATOR_ON_CAMERA = buildRoleScopes({
  roleId: 'operator',
  selector: { kind: 'ids', ids: [CAMERA] },
  includeLinked: true,
})

const VIEWER_ON_CAMERA = buildRoleScopes({
  roleId: 'viewer',
  selector: { kind: 'ids', ids: [CAMERA] },
  includeLinked: true,
})

/** A user holding only the system row — no device grant at all. */
const NO_DEVICE_GRANT: readonly TokenScope[] = [
  { type: 'category', target: 'system', access: ['view', 'create'] },
]

function anyProvider(): Readonly<Record<string, () => Promise<unknown>>> {
  return new Proxy({}, { get: () => async () => undefined })
}

function tierOf(def: CapabilityDefinition, name: string): string {
  const methods: Readonly<Record<string, CapabilityMethodSchema>> = def.methods
  const schema = methods[name]
  if (schema === undefined) throw new Error(`${def.name}.${name} no longer exists`)
  return resolveMethodAuth(def, schema)
}

describe('accessory controls: tier', () => {
  it('motion-trigger.setMotionTrigger and switch.setState are operate (protected)', () => {
    expect(tierOf(motionTriggerCapability, 'setMotionTrigger')).toBe('protected')
    expect(tierOf(switchCapability, 'setState')).toBe('protected')
  })

  it('hiding a child from the camera stays configuration (admin)', () => {
    expect(tierOf(accessoriesCapability, 'setChildHidden')).toBe('admin')
  })
})

describe('accessory controls: a camera grant reaches its children', () => {
  const motion = buildMountedCapRouterForTest('motion-trigger', () => anyProvider())
  const sw = buildMountedCapRouterForTest('switch', () => anyProvider())

  it('an operator of the camera toggles the siren and light motion trigger', async () => {
    for (const deviceId of [SIREN, LIGHT]) {
      const result = await invokeProcedure(
        motion,
        'setMotionTrigger',
        userCtx(OPERATOR_ON_CAMERA),
        {
          deviceId,
          enabled: true,
        },
      )
      expect(result, `setMotionTrigger(${deviceId})`).toEqual({ ok: true, value: undefined })
    }
  })

  it('an operator of the camera switches the siren', async () => {
    const result = await invokeProcedure(sw, 'setState', userCtx(OPERATOR_ON_CAMERA), {
      deviceId: SIREN,
      on: true,
    })
    expect(result).toEqual({ ok: true, value: undefined })
  })

  it('a user with no device grant is refused', async () => {
    const result = await invokeProcedure(motion, 'setMotionTrigger', userCtx(NO_DEVICE_GRANT), {
      deviceId: SIREN,
      enabled: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('FORBIDDEN')
  })

  it('the child of ANOTHER camera is refused', async () => {
    for (const [router, method, input] of [
      [motion, 'setMotionTrigger', { deviceId: OTHER_SIREN, enabled: true }],
      [sw, 'setState', { deviceId: OTHER_SIREN, on: true }],
    ] as const) {
      const result = await invokeProcedure(router, method, userCtx(OPERATOR_ON_CAMERA), input)
      expect(result.ok, `${method}(${OTHER_SIREN})`).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('FORBIDDEN')
        expect(result.message).not.toBe('Admin required')
      }
    }
  })

  it('a viewer of the camera cannot operate the child (view does not carry create)', async () => {
    const result = await invokeProcedure(motion, 'setMotionTrigger', userCtx(VIEWER_ON_CAMERA), {
      deviceId: SIREN,
      enabled: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('FORBIDDEN')
  })

  it('an operator of the camera still cannot hide its children (admin)', async () => {
    const router = buildMountedCapRouterForTest('accessories', () => anyProvider())
    const result = await invokeProcedure(router, 'setChildHidden', userCtx(OPERATOR_ON_CAMERA), {
      deviceId: CAMERA,
      childDeviceId: SIREN,
      hidden: true,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toBe('Admin required')
  })
})
