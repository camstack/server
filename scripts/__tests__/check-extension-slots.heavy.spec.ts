/**
 * D648 — the extension-slot guard and codegen, on fixtures.
 *
 * Each rule of `extension-slots-guard.ts` goes red on the fixture that breaks
 * it (a duplicate id, an orphan slot, two owners, an owner outside the
 * contract, a store-shaped contract method), and the renderer refuses what would not
 * compile or would lie. The last block renders the REAL caps and compares
 * with the committed module — the codegen-drift rule, asked directly.
 */
import * as fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  checkExtensionSlotFacts,
  type ExtensionSlotFacts,
  type OwnerFact,
  type SlotFact,
} from '../extension-slots-guard.ts'
import { EXTENSION_SLOTS_OUTPUT, loadCapModules } from '../extension-slots-load.ts'
import {
  collectExtensionSlots,
  renderExtensionSlotsModule,
  type CapModule,
} from '../extension-slots-model.ts'

const LINKED: SlotFact = {
  id: 'linked-devices',
  declaringCap: 'device-manager',
  hasHostDeviceTypes: true,
  valueHasSlotKey: false,
}

const LINKED_OWNER: OwnerFact = {
  slotId: 'linked-devices',
  file: 'packages/system/src/builtins/device-manager/device-extension-linked-slot.ts',
  packageDir: 'packages/system',
  addonId: 'device-manager',
  addonDeclaresContract: true,
}

function facts(overrides: Partial<ExtensionSlotFacts> = {}): ExtensionSlotFacts {
  return {
    slots: [LINKED],
    owners: [LINKED_OWNER],
    contractMethods: ['listSources', 'listSlots', 'listCandidates', 'setSlot'],
    generatedDrift: null,
    ...overrides,
  }
}

describe('check-extension-slots rules', () => {
  it('passes the shipped shape', () => {
    expect(checkExtensionSlotFacts(facts())).toEqual([])
  })

  it('refuses a slot id declared by two caps', () => {
    const failures = checkExtensionSlotFacts(
      facts({ slots: [LINKED, { ...LINKED, declaringCap: 'doorbell' }] }),
    )
    expect(failures.join('\n')).toMatch(/"linked-devices" is declared by 2 caps/)
  })

  it('refuses an orphan slot — declared, served by nobody', () => {
    expect(checkExtensionSlotFacts(facts({ owners: [] })).join('\n')).toMatch(/has no owner/)
  })

  it('refuses two owners of one slot', () => {
    const second: OwnerFact = { ...LINKED_OWNER, file: 'packages/addon-x/src/linked.ts' }
    expect(checkExtensionSlotFacts(facts({ owners: [LINKED_OWNER, second] })).join('\n')).toMatch(
      /has 2 owners/,
    )
  })

  it('refuses an owner whose manifest does not declare device-extension', () => {
    const owner: OwnerFact = { ...LINKED_OWNER, addonDeclaresContract: false }
    expect(checkExtensionSlotFacts(facts({ owners: [owner] })).join('\n')).toMatch(
      /does not declare device-extension/,
    )
  })

  it('refuses an owner of a slot no cap declares', () => {
    const typo: OwnerFact = { ...LINKED_OWNER, slotId: 'linked-device' }
    expect(checkExtensionSlotFacts(facts({ owners: [LINKED_OWNER, typo] })).join('\n')).toMatch(
      /names a slot no cap declares/,
    )
  })

  it('refuses a store-shaped contract method', () => {
    const failures = checkExtensionSlotFacts(
      facts({ contractMethods: ['listSlots', 'getExtensionConfig', 'saveSlots'] }),
    )
    expect(failures).toHaveLength(2)
  })

  it('reports a stale generated module', () => {
    expect(checkExtensionSlotFacts(facts({ generatedDrift: 'stale' }))).toEqual(['stale'])
  })
})

describe('renderExtensionSlotsModule', () => {
  const value = z.object({ deviceIds: z.array(z.number()) })
  const descriptor = {
    id: 'linked-devices',
    label: 'Linked',
    description: 'x',
    shape: 'association',
    hostDeviceTypes: undefined,
    sourceCaps: 'any',
    cardinality: 'many',
    value,
  } as const
  const cap = { name: 'device-manager', scope: 'system', mode: 'singleton', methods: {} }

  function moduleWith(exports: Record<string, unknown>): CapModule {
    return { file: 'device-manager.cap.ts', exports }
  }

  it('refuses a slot whose value schema is not a named export', () => {
    const slots = collectExtensionSlots([
      moduleWith({
        SLOT: descriptor,
        deviceManagerCapability: {
          ...cap,
          deviceTypes: ['camera'],
          extensionSlots: [descriptor],
        },
      }),
    ])
    expect(() => renderExtensionSlotsModule(slots)).toThrow(/must both be named exports/)
  })

  it('refuses a slot with no host types on a cap without deviceTypes', () => {
    const slots = collectExtensionSlots([
      moduleWith({
        SLOT: descriptor,
        Value: value,
        deviceManagerCapability: { ...cap, extensionSlots: [descriptor] },
      }),
    ])
    expect(() => renderExtensionSlotsModule(slots)).toThrow(/no host device types/)
  })

  it('the committed module is exactly what the real caps render to', async () => {
    const rendered = renderExtensionSlotsModule(collectExtensionSlots(await loadCapModules()))
    expect(rendered).toBe(fs.readFileSync(EXTENSION_SLOTS_OUTPUT, 'utf-8'))
  })
})
