import { describe, expect, it } from 'vitest'
import {
  type Baseline,
  findViolations,
  SOURCE_ROOTS,
  switchMethodsOf,
} from '../check-one-row-switch.js'

const EMPTY: Baseline = {
  capMethods: {},
  setInstanceEnabledImplementations: {},
}

const INSTANCES_CAP = `
    setInstanceEnabled: method(
      z.object({ id: IntegrationInstanceIdSchema, enabled: z.boolean() }),
      z.object({ ok: z.literal(true) }),
    ),
`
const TARGET_CAP = `
    setTargetEnabled: method(z.object({ targetId: z.string(), enabled: z.boolean() }), z.void(), {
`
const DEVICE_CAP = `
    setEnabled: method(z.object({ deviceId: z.number(), enabled: z.boolean() }), z.void(), {
`

describe('check-one-row-switch', () => {
  it('reads the switch methods of a cap file and tells a device switch apart', () => {
    expect(switchMethodsOf(TARGET_CAP + DEVICE_CAP)).toEqual([
      { name: 'setTargetEnabled', deviceScoped: false },
      { name: 'setEnabled', deviceScoped: true },
    ])
  })

  it('accepts the one switch, a device switch and a baselined row', () => {
    const found = findViolations(
      [
        {
          path: 'packages/types/src/capabilities/integration-instances.cap.ts',
          text: INSTANCES_CAP,
        },
        {
          path: 'packages/types/src/capabilities/pump-cycle.cap.ts',
          text: DEVICE_CAP,
        },
        {
          path: 'packages/types/src/capabilities/notification-output.cap.ts',
          text: TARGET_CAP,
        },
      ],
      [],
      {
        ...EMPTY,
        capMethods: {
          'notification-output.cap.ts:setTargetEnabled': 'own CRUD',
        },
      },
    )
    expect(found).toEqual([])
  })

  it('refuses a new set…Enabled cap method that is not the instance switch', () => {
    const found = findViolations(
      [
        {
          path: 'packages/types/src/capabilities/widget-things.cap.ts',
          text: TARGET_CAP,
        },
      ],
      [],
      EMPTY,
    )
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toMatch(/second way to switch an instance/)
  })

  it('refuses a provider that implements setInstanceEnabled outside the helper', () => {
    const own = {
      path: 'packages/addon-widgets/src/addon.ts',
      text: 'const provider = { setInstanceEnabled: async ({ id, enabled }) => ({ ok: true }) }',
    }
    expect(findViolations([], [own], EMPTY)).toHaveLength(1)
    const helper = {
      path: 'packages/types/src/addon/record-integration-instances.ts',
      text: own.text,
    }
    expect(findViolations([], [helper], EMPTY)).toEqual([])
  })

  it('refuses a baseline line that no longer matches anything (the list only shrinks)', () => {
    const found = findViolations([], [], {
      capMethods: { 'gone.cap.ts:setGoneEnabled': 'x' },
      setInstanceEnabledImplementations: { 'packages/gone/src/a.ts': 'x' },
    })
    expect(found).toHaveLength(2)
  })

  it('walks the hub backend too: a second switch implementation there is refused', () => {
    expect(SOURCE_ROOTS).toContain('server/backend/src')
    const hub = {
      path: 'server/backend/src/core/addon/second-switch.ts',
      text: 'const setInstanceEnabled: IIntegrationInstancesProvider["setInstanceEnabled"] = async (input) => ({ ok: true as const })',
    }
    const found = findViolations([], [hub], EMPTY)
    expect(found).toHaveLength(1)
    expect(found[0]?.where).toBe(hub.path)
  })

  it('reads a QUOTED custom action in a defineCustomActions file, keyed by its path', () => {
    const file = {
      path: 'packages/addon-x/src/x-actions.ts',
      text: "export const a = defineCustomActions({\n  'x.setThingEnabled': customAction(\n    z.object({ id: z.string() }),\n",
    }
    const found = findViolations([], [file], EMPTY)
    expect(found).toHaveLength(1)
    expect(found[0]?.message).toMatch(/second way to switch an instance/)
    const baselined = findViolations([], [file], {
      ...EMPTY,
      capMethods: { 'packages/addon-x/src/x-actions.ts:x.setThingEnabled': 'reason' },
    })
    expect(baselined).toEqual([])
  })
})
