/**
 * D648 — cards follow the generated slot table's order, whatever order the
 * owners answered in (`resolveExtensionsView`).
 *
 * The table holds ONE slot today (`linked-devices`, slice 6), so the
 * comparator is pinned against a two-id table with a synthetic second slot.
 * The synthetic row is built at an untyped boundary (JSON.parse) — the typed
 * union cannot spell a slot the table does not declare.
 */
import type { ExtensionSlotRow } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { resolveExtensionsView } from '../extensions-view-state.js'

const LINKED: ExtensionSlotRow = {
  state: 'ok',
  slotRef: 'device-manager:linked-devices',
  slot: 'linked-devices',
  authority: 'device-manager:_linkedDeviceIds',
  activation: null,
  value: { slot: 'linked-devices', deviceIds: [] },
  sources: [],
}

const PROBE: ExtensionSlotRow = JSON.parse(
  JSON.stringify({
    ...LINKED,
    slotRef: 'probe-owner:probe',
    slot: 'probe',
    authority: 'probe-owner:store',
    value: { slot: 'probe', deviceIds: [] },
  }),
)

const TABLE = ['probe', 'linked-devices'] as const

function slotIds(rows: readonly ExtensionSlotRow[]): readonly string[] {
  const view = resolveExtensionsView({ status: 'success', data: rows }, TABLE)
  return view.kind === 'rows' ? view.slots.map((s) => s.slot) : []
}

describe('resolveExtensionsView — table order (D648)', () => {
  it('sorts the cards by the table, not by the order the owners answered in', () => {
    expect(slotIds([LINKED, PROBE])).toEqual(['probe', 'linked-devices'])
    expect(slotIds([PROBE, LINKED])).toEqual(['probe', 'linked-devices'])
  })

  it('uses the generated table by default', () => {
    const view = resolveExtensionsView({ status: 'success', data: [LINKED] })
    expect(view.kind === 'rows' ? view.slots.map((s) => s.slot) : []).toEqual(['linked-devices'])
  })
})

describe('resolveExtensionsView — a slot this build does not declare (task 17 re-review R1, D315)', () => {
  it('is set apart by name, never handed to a card', () => {
    const view = resolveExtensionsView({ status: 'success', data: [LINKED, PROBE] })
    expect(view).toEqual({
      kind: 'rows',
      slots: [LINKED],
      unknownSlots: [{ slot: 'probe', slotRef: 'probe-owner:probe' }],
      unreachable: [],
    })
  })
})
