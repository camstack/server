import { describe, expect, it } from 'vitest'
import {
  type AutomationRecipe,
  type CoreBlock,
  AutomationRecipeSchema,
  coreBlockComposition,
  generateAutomationBlock,
} from '../../packages/types/src/index.js'
import type { HubCall } from '../hub/hub-call.js'
import {
  BUTTONS_TEMPLATE_ID,
  migrateButtonsTemplate,
} from '../hub/migrate-buttons-template-to-group-triggers.js'

/** The shape the template expands to for two buttons of one remote that toggle one light. */
function buttonsRecipe(over: Partial<{ steps: object[]; when: object }> = {}): AutomationRecipe {
  const press = (id: string, source: string) => ({
    kind: 'device-fired',
    id,
    deviceId: 5656,
    eventIds: ['PRESS_SHORT'],
    sourceIds: [source],
  })
  const toggle = [
    { kind: 'command', target: { kind: 'devices', ids: [5767] }, actionId: 'switch.toggle' },
  ]
  return AutomationRecipeSchema.parse({
    when: over.when ?? { kind: 'any', children: [press('b1', '1'), press('b2', '2')] },
    actions: [
      {
        kind: 'choose',
        branches: [
          { if: { kind: 'triggered-by', leafIds: ['b1'] }, steps: over.steps ?? toggle },
          { if: { kind: 'triggered-by', leafIds: ['b2'] }, steps: over.steps ?? toggle },
        ],
      },
    ],
    runMode: { mode: 'queued', max: 5 },
    template: { templateId: BUTTONS_TEMPLATE_ID, values: {} },
  })
}

function block(id: string, name: string, recipe: AutomationRecipe, enabled = true): CoreBlock {
  return {
    id,
    name,
    code: generateAutomationBlock({ name, recipe }),
    enabled,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 1,
    createdBy: 'u',
    status: enabled ? 'running' : 'stopped',
    lastChangedAt: 1,
  }
}

const DEVICES = [
  { id: 5656, addonId: 'zigbee', stableId: 'remote-1', type: 'sensor' },
  { id: 5767, addonId: 'zigbee', stableId: 'lamp-1', type: 'light' },
]

/** An in-memory hub: the routes the script calls, and a group that starts its owned automation when created. */
function fakeHub(initial: CoreBlock[]): {
  call: HubCall
  blocks: () => CoreBlock[]
  writes: string[]
} {
  let blocks = initial
  const writes: string[] = []
  const call: HubCall = {
    query: async (route, input) => {
      if (route === 'coreBlocks.list') return { blocks }
      if (route === 'deviceManager.listAll') {
        const ids: number[] = (input as { deviceIds: number[] }).deviceIds
        return DEVICES.filter((d) => ids.includes(d.id))
      }
      throw new Error(`unexpected query ${route}`)
    },
    mutate: async (route, input) => {
      writes.push(route)
      if (route === 'coreBlocks.createComposition') {
        const body = (input as { block: { name: string; composition: object } }).block
        const group: CoreBlock = {
          ...block('grp1', body.name, buttonsRecipe(), true),
          code: '',
          source: { kind: 'composition', composition: body.composition },
        } as CoreBlock
        const owned = block(
          'own1',
          `${body.name} — triggers`,
          AutomationRecipeSchema.parse({
            when: { kind: 'device-fired', id: 't-ch1', deviceId: 5656 },
            actions: [
              {
                kind: 'command',
                target: { kind: 'devices', ids: [5767] },
                actionId: 'switch.toggle',
              },
            ],
            ownedBy: { kind: 'group', blockId: 'grp1' },
          }),
        )
        blocks = [...blocks, group, owned]
        return { block: group }
      }
      if (route === 'coreBlocks.setEnabled') {
        const { blockId, enabled } = input as { blockId: string; enabled: boolean }
        blocks = blocks.map((b) => (b.id === blockId ? { ...b, enabled, status: 'stopped' } : b))
        return {}
      }
      if (route === 'coreBlocks.delete') {
        const { blockId } = input as { blockId: string }
        blocks = blocks.filter((b) => b.id !== blockId)
        return { success: true }
      }
      throw new Error(`unexpected mutation ${route}`)
    },
  }
  return { call, blocks: () => blocks, writes }
}

const run = (call: HubCall, mode: { apply?: boolean; finalize?: boolean } = {}) => {
  const lines: string[] = []
  return migrateButtonsTemplate(call, {
    apply: mode.apply === true,
    finalize: mode.finalize === true,
    log: (line) => lines.push(line),
  }).then((outcome) => ({ outcome, lines }))
}

describe('migrating the Buttons → devices automations to group triggers', () => {
  it('preview names the group it would create and writes NOTHING', async () => {
    const hub = fakeHub([block('old1', 'Bagno camerette — pulsanti → luce', buttonsRecipe())])
    const { outcome, lines } = await run(hub.call)
    expect(outcome).toEqual({ status: 'done', instances: 1, changed: 0 })
    expect(lines.join('\n')).toContain(
      'light, no device, member lamp-1; t-ch1→switch, t-ch2→switch',
    )
    expect(hub.writes).toEqual([])
  })

  it('apply creates the group with output none, then disables the old automation; a re-run creates nothing', async () => {
    const hub = fakeHub([block('old1', 'Bagno camerette — pulsanti → luce', buttonsRecipe())])
    await run(hub.call, { apply: true })
    const group = hub.blocks().find((b) => b.id === 'grp1')
    const helper = group === undefined ? undefined : coreBlockComposition(group)?.helper
    expect(helper?.kind === 'group' && helper.output).toBe('none')
    expect(helper?.kind === 'group' && helper.triggers?.map((t) => t.id)).toEqual([
      't-ch1',
      't-ch2',
    ])
    expect(hub.blocks().find((b) => b.id === 'old1')?.enabled).toBe(false)
    expect(hub.writes).toEqual(['coreBlocks.createComposition', 'coreBlocks.setEnabled'])
    await run(hub.call, { apply: true })
    expect(hub.writes).toEqual(['coreBlocks.createComposition', 'coreBlocks.setEnabled'])
  })

  it('finalize deletes the old automation only once the group runs its own', async () => {
    const hub = fakeHub([block('old1', 'Bagno camerette — pulsanti → luce', buttonsRecipe())])
    await run(hub.call, { finalize: true })
    expect(hub.blocks().map((b) => b.id)).toEqual(['old1'])
    await run(hub.call, { apply: true })
    await run(hub.call, { finalize: true })
    expect(hub.blocks().some((b) => b.id === 'old1')).toBe(false)
  })

  it('an automation that is more than one switch command per button is named, and nothing changes', async () => {
    const steps = [
      { kind: 'command', target: { kind: 'devices', ids: [5767] }, actionId: 'switch.on' },
      { kind: 'wait', seconds: 5 },
    ]
    const hub = fakeHub([block('old1', 'Complicated', buttonsRecipe({ steps }))])
    const { outcome, lines } = await run(hub.call, { apply: true })
    expect(outcome.status).toBe('blocked')
    expect(lines.join('\n')).toContain('NOT convertible')
    expect(hub.writes).toEqual([])
  })

  it('an automation with a time window is not converted', async () => {
    const leaf = (id: string) => ({ kind: 'device-fired', id, deviceId: 5656 })
    const window = { kind: 'all', children: [{ kind: 'any', children: [leaf('b1'), leaf('b2')] }] }
    const hub = fakeHub([block('old1', 'Windowed', buttonsRecipe({ when: window }))])
    const { outcome, lines } = await run(hub.call, { apply: true })
    expect(outcome.status).toBe('blocked')
    expect(lines.join('\n')).toContain('time window')
    expect(hub.writes).toEqual([])
  })
})
