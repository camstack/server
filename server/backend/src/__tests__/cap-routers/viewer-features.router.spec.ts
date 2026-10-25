/**
 * A viewer's named features reach admin-TIER methods (D921), through the live
 * router: `protectedProcedure` checks the feature and the devices, and
 * `adminProcedure` lets the viewer pass only on a feature it holds.
 *
 * Matrix: feature on/off × device admitted/blocked × a method the feature
 * never unlocks (corpus export) × a legacy non-admin principal beside it,
 * which must still meet "Admin required".
 */
import type { UserScope, ViewerTokenScope } from '@camstack/types'
import { buildRoleScopes } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { DeviceScopeLookup } from '../../api/trpc/scope-access.js'
import type { TrpcContext } from '../../api/trpc/trpc.context.js'
import { buildMountedCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

const CAMERA = 3628
const SIREN = 3630
const OTHER_CAMERA = 5000

const lookup: DeviceScopeLookup = {
  getAncestors: (id) => (id === SIREN ? [CAMERA] : []),
  getType: (id) => ([CAMERA, SIREN, OTHER_CAMERA].includes(id) ? 'camera' : null),
  getLocation: () => null,
}

function viewerCtx(over: Partial<ViewerTokenScope> = {}): TrpcContext {
  const scopes: readonly UserScope[] = [
    { type: 'viewer', allow: '*', block: [], features: [], ...over },
  ]
  return { ...makeCtx('user', { scopes: [...scopes] }), deviceScopeLookup: lookup }
}

/** Answers every method with what its output schema accepts. */
function provider(): Readonly<Record<string, () => Promise<unknown>>> {
  return new Proxy(
    {},
    {
      get: (_t, name) => async () =>
        name === 'deselectRetrainFrame' ? { removed: false, removedAnnotations: 0 } : undefined,
    },
  )
}

const faces = buildMountedCapRouterForTest('face-gallery', () => provider())
const plates = buildMountedCapRouterForTest('plate-gallery', () => provider())
const scenes = buildMountedCapRouterForTest('scene-monitor', () => provider())
const analytics = buildMountedCapRouterForTest('pipeline-analytics', () => provider())

const ASSIGN = { faceId: 'f1', identityId: 'i1' }

describe('viewer features through the admin tier', () => {
  it('face-assignment: refused without the feature, reached with it', async () => {
    const without = await invokeProcedure(faces, 'assignFace', viewerCtx(), ASSIGN)
    expect(without.ok).toBe(false)
    if (!without.ok) {
      expect(without.code).toBe('FORBIDDEN')
      expect(without.message).toContain("'face-assignment' feature")
    }
    const granted = viewerCtx({ features: ['face-assignment'] })
    expect(await invokeProcedure(faces, 'assignFace', granted, ASSIGN)).toEqual({
      ok: true,
      value: undefined,
    })
  })

  it("a feature never reaches another feature's methods", async () => {
    const r = await invokeProcedure(
      plates,
      'deletePlate',
      viewerCtx({ features: ['face-assignment'] }),
      { plateId: 'p1' },
    )
    expect(r.ok).toBe(false)
    expect(
      (
        await invokeProcedure(
          plates,
          'deletePlate',
          viewerCtx({ features: ['plate-assignment'] }),
          {
            plateId: 'p1',
          },
        )
      ).ok,
    ).toBe(true)
  })

  it('scenes: the feature is still limited to the viewer devices', async () => {
    const ctx = viewerCtx({ features: ['scenes'], block: [CAMERA] })
    expect(
      (await invokeProcedure(scenes, 'recheckNow', ctx, { deviceId: OTHER_CAMERA, monitorId: 'm' }))
        .ok,
    ).toBe(true)
    const blocked = await invokeProcedure(scenes, 'recheckNow', ctx, {
      deviceId: CAMERA,
      monitorId: 'm',
    })
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.message).toContain('outside')
  })

  it('retrain: staging is reached, the corpus export stays admin', async () => {
    const ctx = viewerCtx({ features: ['retrain'] })
    const staged = await invokeProcedure(analytics, 'deselectRetrainFrame', ctx, {
      deviceId: OTHER_CAMERA,
      frameId: 'x',
    })
    expect(staged.ok).toBe(true)
    const exported = await invokeProcedure(analytics, 'getRetrainExportUrl', ctx, {})
    expect(exported.ok).toBe(false)
    if (!exported.ok) expect(exported.code).toBe('FORBIDDEN')
  })

  it('a legacy non-admin grant still meets "Admin required" on the same methods', async () => {
    const legacy: TrpcContext = {
      ...makeCtx('user', {
        scopes: buildRoleScopes({
          roleId: 'manager',
          selector: { kind: 'all' },
          includeLinked: true,
        }),
      }),
      deviceScopeLookup: lookup,
    }
    const r = await invokeProcedure(faces, 'assignFace', legacy, ASSIGN)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toBe('Admin required')
  })
})
