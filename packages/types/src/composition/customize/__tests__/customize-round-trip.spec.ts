import { describe, expect, it } from 'vitest'
import { compileScalarOverride } from '../scalar-compile.js'
import { decodeScalarOverride } from '../scalar-decode.js'
import { normalizeStored } from '../normalize.js'
import type { CustomizeStoredCase } from '../__fixtures__/stored-cases.js'
import {
  CUSTOMIZE_STORED_CASES,
  NONCANONICAL_CUSTOMIZE_STORED,
} from '../__fixtures__/stored-cases.js'
import type { CustomizeStored } from '../stored.js'

function targetIdOf(stored: CustomizeStored): string {
  if (stored.family !== 'composition') return ''
  if (stored.feature.cap === 'battery') return 'level'
  if (stored.feature.cap === 'running-state') return 'running'
  return 'items'
}

describe('customize golden round trip', () => {
  it.each(
    CUSTOMIZE_STORED_CASES.map((entry) => [entry.id, entry] as const),
  )('%s compiles to the frozen stored value and decodes back to it', (_id, entry) => {
    const compiled = compileScalarOverride(entry.input)
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const stored = {
      family: 'composition' as const,
      target: entry.input.device,
      feature: compiled.value,
    }
    expect(normalizeStored(stored)).toEqual(normalizeStored(entry.stored))

    if (entry.stored.family !== 'composition') return
    const decoded = decodeScalarOverride({
      feature: entry.stored.feature,
      device: entry.input.device,
      cap: entry.input.draft.cap,
      targetId: entry.input.draft.targetId,
    })
    expect(decoded).not.toBeNull()
    if (decoded === null) return
    const again = compileScalarOverride({
      draft: decoded.draft,
      device: entry.input.device,
      apply: decoded.apply,
      sourceValueKind: decoded.sourceValueKind,
      changedAtField: decoded.changedAtField,
      sourceUnit: decoded.sourceUnit,
    })
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(
      normalizeStored({ family: 'composition', target: entry.input.device, feature: again.value }),
    ).toEqual(normalizeStored(entry.stored))
  })

  it.each(
    NONCANONICAL_CUSTOMIZE_STORED.map((entry) => [entry.id, entry] as const),
  )('%s is not rebuilt into the canonical shape', (_id, entry) => {
    if (entry.stored.family !== 'composition') return
    const decoded = decodeScalarOverride({
      feature: entry.stored.feature,
      device: entry.stored.target,
      cap: entry.stored.feature.cap,
      targetId: targetIdOf(entry.stored),
    })
    expect(decoded).toBeNull()
  })

  it('every frozen case is a generic scalar compile input', () => {
    const caps = new Set(
      CUSTOMIZE_STORED_CASES.map((entry: CustomizeStoredCase) => entry.input.draft.cap),
    )
    expect([...caps].toSorted()).toEqual(['battery', 'running-state'])
    expect(CUSTOMIZE_STORED_CASES.every((entry) => entry.input.draft.kind === 'scalar')).toBe(true)
  })
})
