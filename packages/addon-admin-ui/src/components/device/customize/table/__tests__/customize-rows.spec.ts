import { CAP_CUSTOMIZE_CATALOG, DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import en from '../../../../../i18n/en.json'
import it_ from '../../../../../i18n/it.json'
import type { AssignmentFacts } from '../../assignment-availability'
import { activeSections, offeredRows, planRows, splitRows } from '../customize-rows'

function lookup(tree: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((node, part) => {
    if (typeof node !== 'object' || node === null) return undefined
    return Object.entries(node).find(([key]) => key === part)?.[1]
  }, tree)
}

function facts(over: Partial<AssignmentFacts> = {}): AssignmentFacts {
  return {
    deviceType: DeviceType.Washer,
    composable: {
      kind: 'known',
      value: new Set(['power-meter', 'running-state']),
    },
    nativeCaps: { kind: 'known', value: new Set() },
    cameraSensors: 'absent',
    ...over,
  }
}

function missingKeys(keyOf: (cap: string) => string, caps: readonly string[]): readonly string[] {
  return caps.flatMap((cap) =>
    (['en', 'it'] as const).flatMap((lang) =>
      typeof lookup(lang === 'en' ? en : it_, keyOf(cap)) === 'string'
        ? []
        : [`${lang}:${keyOf(cap)}`],
    ),
  )
}

describe('every catalog cap has a title', () => {
  const entries = Object.entries(CAP_CUSTOMIZE_CATALOG)
  it('a scalar cap has a dialog title key in English and Italian', () => {
    const scalarCaps = entries
      .filter(([, entry]) => entry.targets.some((target) => target.cardinality === 'scalar'))
      .map(([cap]) => cap)
    expect(missingKeys((cap) => `customize.scalar.caps.${cap}`, scalarCaps)).toEqual([])
  })
  it('every cap has a row title key in English and Italian', () => {
    expect(
      missingKeys(
        (cap) => `customize.table.caps.${cap}`,
        entries.map(([cap]) => cap),
      ),
    ).toEqual([])
  })
})

describe('offeredRows', () => {
  it('lists power targets for a washer, power section first', () => {
    const rows = offeredRows(DeviceType.Washer)
    expect(rows.map((row) => row.key)).toContain('power-meter.power')
    expect(rows[0]?.section).toBe('power')
  })
  it('offers a camera its events and not power', () => {
    const keys = offeredRows(DeviceType.Camera).map((row) => row.key)
    expect(keys).toContain('doorbell.pressed')
    expect(keys.some((key) => key.startsWith('power-meter.'))).toBe(false)
  })
})

describe('splitRows', () => {
  const specs = offeredRows(DeviceType.Washer)
  it('a linked row is active, an unlinked one is addable', () => {
    const plans = planRows(specs, facts(), (spec) => spec.key === 'power-meter.power')
    const split = splitRows(plans)
    expect(split.active.map((p) => p.spec.key)).toEqual(['power-meter.power'])
    expect(split.addable.map((p) => p.spec.key)).toContain('running-state.running')
    expect(activeSections(split.active)).toEqual(['power'])
  })
  it('an unread applicability is pending, never absent', () => {
    const split = splitRows(
      planRows(specs, facts({ composable: { kind: 'pending' } }), () => false),
    )
    expect(split.pending).toBe(true)
    expect(split.addable).toEqual([])
  })
  it('a cap the device already serves natively is not offered to add', () => {
    const plans = planRows(
      specs,
      facts({ nativeCaps: { kind: 'known', value: new Set(['power-meter']) } }),
      () => false,
    )
    const adds = splitRows(plans).addable.filter(
      (p) => p.spec.cap === 'power-meter' && p.availability.kind === 'present',
    )
    expect(
      adds.every((p) => p.availability.kind === 'present' && p.availability.mode === 'replace'),
    ).toBe(true)
  })
})
