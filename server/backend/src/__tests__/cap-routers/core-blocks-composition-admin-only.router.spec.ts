/**
 * A composition reads and writes other devices' state — the composition API and
 * the composer are ADMIN-only (D659), like every other core-blocks method.
 *
 * Two layers, as in `device-restore-and-export-admin-only.router.spec.ts`: the
 * tier each method RESOLVES to, and the LIVE router refusing every access role
 * with the tier's message. The second is the one that matters — a tier the
 * router does not enforce is a comment (R9). An admin reaching every method
 * with the SAME input proves the refusal is the tier's, not a parse failure.
 */
import {
  ACCESS_ROLES,
  buildRoleScopes,
  type CapabilityDefinition,
  type CapabilityMethodSchema,
  composerCapability,
  coreBlocksCapability,
  METHOD_ACCESS_MAP,
  ROOM_EXAMPLE_MOTION_SOURCES,
  ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  ROOM_OCCUPANCY_WINDOW_MS,
  resolveMethodAuth,
  roomCompositionExample,
  type TokenScope,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { buildCapRouterForTest, invokeProcedure, makeCtx } from './harness.js'

interface TierCase {
  readonly cap: CapabilityDefinition
  readonly capName: string
  readonly methods: readonly string[]
  /** One input every method of the case parses (Zod strips the keys a method does not declare). */
  readonly input: Record<string, unknown>
}

const ROOM = roomCompositionExample({
  temperatureSources: ROOM_EXAMPLE_TEMPERATURE_SOURCES,
  motionSources: ROOM_EXAMPLE_MOTION_SOURCES,
  occupancyWindowMs: ROOM_OCCUPANCY_WINDOW_MS,
})

const CASES: readonly TierCase[] = [
  {
    cap: coreBlocksCapability,
    capName: 'core-blocks',
    methods: [
      'createComposition',
      'updateComposition',
      'getComposition',
      'listCompositions',
      'validateComposition',
      'getCustomization',
      'listComposableCaps',
    ],
    input: {
      blockId: 'b1',
      addonId: 'provider-homeassistant',
      stableId: 'ha:b:dev:8dec',
      expectedUpdatedAt: 1,
      block: { name: 'Room', enabled: true, composition: ROOM },
      composition: ROOM,
      deviceType: 'camera',
    },
  },
  {
    cap: composerCapability,
    capName: 'composer',
    methods: ['applyBlocks', 'getStates'],
    input: {
      integrationId: null,
      storeLoaded: true,
      blocks: [],
      restartBlockIds: [],
      unreadableBlocks: [],
      blockIds: [],
    },
  },
]

type AccessRoleId = (typeof ACCESS_ROLES)[number]['id']

function roleScopes(roleId: AccessRoleId): readonly TokenScope[] {
  return buildRoleScopes({ roleId, selector: { kind: 'all' }, includeLinked: true })
}

/** A provider answering every method: the router's tier must refuse BEFORE it is reached. */
function anyProvider(): Readonly<Record<string, () => Promise<unknown>>> {
  return new Proxy(
    {},
    {
      get: () => async () => ({ state: 'loaded', views: [], states: [], blocks: [], view: null }),
    },
  )
}

describe('composition API + composer: tier', () => {
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

  it('validate is a VIEW access though it is a mutation', () => {
    expect(METHOD_ACCESS_MAP['coreBlocks.validateComposition']?.access).toBe('view')
  })
})

describe('composition API + composer: live router', () => {
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

    it(`${capName}: an admin reaches every method with the same input`, async () => {
      const router = buildCapRouterForTest(capName, () => anyProvider())
      for (const method of methods) {
        const result = await invokeProcedure(router, method, makeCtx('admin'), input)
        expect(result.ok, `admin refused on ${capName}.${method}: ${JSON.stringify(result)}`).toBe(
          true,
        )
      }
    })
  }
})
