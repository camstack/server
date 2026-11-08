/**
 * Stored rows an EARLIER compiler wrote for a TV behind a smart plug (the live
 * hub carries both): a dwell that spells its default `, 1` sample count, and a
 * constant companion with a value the catalog no longer uses. Both mean the
 * same thing as the current canonical text, so the Customize row must still
 * read them as the source link they are — not as "another formula".
 */
import { describe, expect, it } from 'vitest'
import type { CompositionFieldsFeature } from '../../composition.js'
import { decodeScalarOverride } from '../scalar-decode.js'

const TV = { addonId: 'composer', stableId: 'composed-tv' }
const PLUG = { addonId: 'provider-homeassistant', stableId: 'ha:plug' }

const legacyRunning: CompositionFieldsFeature = {
  kind: 'fields',
  cap: 'running-state',
  fields: {
    running: {
      kind: 'expression',
      expr: 'dwell(x >= 20, 10000, 10000, 1)',
      bindings: { x: { kind: 'from', source: PLUG, cap: 'power-meter', fieldPath: 'power' } },
    },
    source: { kind: 'expression', expr: '"assigned"', bindings: {} },
    phase: { kind: 'expression', expr: 'null', bindings: {} },
    lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
    since: {
      kind: 'expression',
      expr: 'latchedAt(running)',
      bindings: {
        running: { kind: 'from', source: TV, cap: 'running-state', fieldPath: 'running' },
      },
    },
  },
}

const legacyPowerSource: CompositionFieldsFeature = {
  kind: 'fields',
  cap: 'power-source',
  fields: {
    switchOn: { kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'on' },
    offSeconds: { kind: 'expression', expr: '0', bindings: {} },
    lastFetchedAt: { kind: 'expression', expr: 'now', bindings: {} },
  },
}

describe('decodeScalarOverride on rows an earlier compiler stored', () => {
  it('reads an explicit `, 1` dwell sample count as the threshold it is', () => {
    const decoded = decodeScalarOverride({
      feature: legacyRunning,
      device: TV,
      cap: 'running-state',
      targetId: 'running',
    })
    expect(decoded).not.toBeNull()
    expect(decoded?.apply).toBe('add')
    expect(decoded?.draft.transform).toEqual({
      kind: 'threshold',
      comparison: 'gte',
      threshold: 20,
      startDwellMs: 10000,
      stopDwellMs: 10000,
      minSamples: 1,
    })
    expect(decoded?.draft.source).toMatchObject({ cap: 'power-meter', fieldPath: 'power' })
  })

  it('reads a constant companion with an older literal as the link it is', () => {
    const decoded = decodeScalarOverride({
      feature: legacyPowerSource,
      device: TV,
      cap: 'power-source',
      targetId: 'switch',
    })
    expect(decoded).not.toBeNull()
    expect(decoded?.apply).toBe('add')
    expect(decoded?.draft.source).toMatchObject({ cap: 'switch', fieldPath: 'on' })
  })

  it('still refuses a constant companion that reads another device', () => {
    const feature: CompositionFieldsFeature = {
      ...legacyPowerSource,
      fields: {
        ...legacyPowerSource.fields,
        offSeconds: {
          kind: 'expression',
          expr: 'x',
          bindings: {
            x: { kind: 'from', source: PLUG, cap: 'numeric-sensor', fieldPath: 'value' },
          },
        },
      },
    }
    expect(
      decodeScalarOverride({ feature, device: TV, cap: 'power-source', targetId: 'switch' }),
    ).toBeNull()
  })
})
