import { describe, expect, it } from 'vitest'
import { CompositionFieldsFeatureSchema, type CompositionFieldsFeature } from '../../composition.js'
import { CAMERA_101, DOORBELL_SWITCH, GATE_SENSOR, PIR_SENSOR } from '../__fixtures__/refs.js'
import { compilePulseOverride, compileSpanOverride } from '../event-compile.js'
import { decodePulseOverride } from '../event-decode.js'
import { projectSpanAssignment } from '../event-status.js'

const SWITCH = {
  addonId: DOORBELL_SWITCH.addonId,
  stableId: DOORBELL_SWITCH.stableId,
  cap: 'switch',
  fieldPath: 'on',
}

describe('compilePulseOverride', () => {
  it('reproduces the operator doorbell: one switch rise, 2s debounce, count', () => {
    const compiled = compilePulseOverride({
      draft: {
        kind: 'pulse',
        cap: 'doorbell',
        targetId: 'pressed',
        enabled: true,
        debounceMs: 2_000,
        sources: [SWITCH],
      },
      device: CAMERA_101,
      changedAtFields: ['lastChangedAt'],
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    const feature: CompositionFieldsFeature = {
      kind: 'fields',
      cap: 'doorbell',
      enabled: true,
      fields: {
        lastPressedAt: {
          kind: 'expression',
          expr: 'latest(rose(active0, changed0, 2000))',
          bindings: {
            active0: { kind: 'from', source: DOORBELL_SWITCH, cap: 'switch', fieldPath: 'on' },
            changed0: {
              kind: 'from',
              source: DOORBELL_SWITCH,
              cap: 'switch',
              fieldPath: 'lastChangedAt',
            },
          },
        },
        pressCountSinceStart: {
          kind: 'expression',
          expr: 'count(lastPressedAt)',
          bindings: {
            lastPressedAt: {
              kind: 'from',
              source: CAMERA_101,
              cap: 'doorbell',
              fieldPath: 'lastPressedAt',
            },
          },
        },
      },
    }
    expect(compiled.value).toEqual(feature)
    const decoded = decodePulseOverride({
      feature: compiled.value,
      device: CAMERA_101,
      cap: 'doorbell',
      targetId: 'pressed',
      timestampPath: 'lastPressedAt',
      counterPath: 'pressCountSinceStart',
    })
    expect(decoded?.draft.sources).toEqual([SWITCH])
    expect(decoded?.changedAtFields).toEqual(['lastChangedAt'])
    expect(decoded?.draft.debounceMs).toBe(2_000)
  })

  it('decodes a stored pulse whose keys the hub wrote in another order', () => {
    const compiled = compilePulseOverride({
      draft: {
        kind: 'pulse',
        cap: 'doorbell',
        targetId: 'pressed',
        enabled: true,
        debounceMs: 2_000,
        sources: [SWITCH],
      },
      device: CAMERA_101,
      changedAtFields: ['lastChangedAt'],
    })
    if (!compiled.ok) throw new Error('compile failed')
    // What the hub stores: the composition schema's own key order, not the compiler's.
    const stored = CompositionFieldsFeatureSchema.parse(compiled.value)
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(compiled.value))
    const decoded = decodePulseOverride({
      feature: stored,
      device: CAMERA_101,
      cap: 'doorbell',
      targetId: 'pressed',
      timestampPath: 'lastPressedAt',
      counterPath: 'pressCountSinceStart',
    })
    expect(decoded?.draft.debounceMs).toBe(2_000)
  })

  it('does not decode a formula that is not the pulse', () => {
    const decoded = decodePulseOverride({
      feature: {
        kind: 'fields',
        cap: 'doorbell',
        enabled: true,
        fields: {
          lastPressedAt: { kind: 'expression', expr: 'now', bindings: {} },
          pressCountSinceStart: { kind: 'expression', expr: 'count(lastPressedAt)', bindings: {} },
        },
      },
      device: CAMERA_101,
      cap: 'doorbell',
      targetId: 'pressed',
      timestampPath: 'lastPressedAt',
      counterPath: 'pressCountSinceStart',
    })
    expect(decoded).toBeNull()
  })
})

describe('compileSpanOverride', () => {
  it('writes the sensor list through the camera-sensors shape and clears with null', () => {
    const compiled = compileSpanOverride({
      draft: {
        kind: 'span',
        cap: 'motion',
        targetId: 'detected',
        timeoutMs: 30_000,
        sources: [
          {
            addonId: PIR_SENSOR.addonId,
            stableId: PIR_SENSOR.stableId,
            cap: 'binary',
            fieldPath: 'on',
            mode: 'in-addition',
          },
          {
            addonId: GATE_SENSOR.addonId,
            stableId: GATE_SENSOR.stableId,
            cap: 'contact',
            fieldPath: 'entryOpen',
            mode: 'confirm',
          },
        ],
      },
      device: CAMERA_101,
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.value.timeoutMs).toBe(30_000)
    expect(compiled.value.cooldownMs).toBeUndefined()
    expect(compiled.value.config).toEqual({
      sensors: [
        { addonId: PIR_SENSOR.addonId, stableId: PIR_SENSOR.stableId, mode: 'in-addition' },
        { addonId: GATE_SENSOR.addonId, stableId: GATE_SENSOR.stableId, mode: 'confirm' },
      ],
    })

    const cleared = compileSpanOverride({
      draft: { kind: 'span', cap: 'motion', targetId: 'detected', timeoutMs: 30_000, sources: [] },
      device: CAMERA_101,
    })
    expect(cleared.ok && cleared.value.config).toBeNull()
  })

  it('refuses the camera as its own sensor and a cooldown the declaration does not have', () => {
    const self = compileSpanOverride({
      draft: {
        kind: 'span',
        cap: 'motion',
        targetId: 'detected',
        timeoutMs: 30_000,
        sources: [
          {
            addonId: CAMERA_101.addonId,
            stableId: CAMERA_101.stableId,
            cap: 'motion',
            fieldPath: 'detected',
            mode: 'replace',
          },
        ],
      },
      device: CAMERA_101,
    })
    expect(self.ok).toBe(false)
    const cool = compileSpanOverride({
      draft: {
        kind: 'span',
        cap: 'motion',
        targetId: 'detected',
        timeoutMs: 30_000,
        cooldownMs: 10_000,
        sources: [],
      },
      device: CAMERA_101,
    })
    expect(cool.ok).toBe(false)
  })
})

describe('projectSpanAssignment', () => {
  it('does not treat an unread list as empty, and keeps a missing sensor', () => {
    const pending = projectSpanAssignment('detected', { kind: 'pending' })
    expect(pending.writable).toBe(false)
    expect(pending.rows).toEqual([])
    expect(pending.status.configured).toBe(false)

    const missing = projectSpanAssignment('detected', {
      kind: 'known',
      value: {
        state: 'configured',
        sensors: [
          {
            state: 'missing',
            addonId: PIR_SENSOR.addonId,
            stableId: PIR_SENSOR.stableId,
            mode: 'in-addition',
            reason: 'gone',
          },
        ],
      },
    })
    expect(missing.writable).toBe(true)
    expect(missing.rows).toEqual([
      {
        key: `${PIR_SENSOR.addonId}/${PIR_SENSOR.stableId}`,
        addonId: PIR_SENSOR.addonId,
        stableId: PIR_SENSOR.stableId,
        name: PIR_SENSOR.stableId,
        mode: 'in-addition',
        state: 'missing',
        reason: 'gone',
      },
    ])
  })
})
