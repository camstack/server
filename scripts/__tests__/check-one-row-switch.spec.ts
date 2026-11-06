import { describe, expect, it } from 'vitest'
import { type Baseline, findViolations, switchMethodsOf } from '../check-one-row-switch.js'

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
})
