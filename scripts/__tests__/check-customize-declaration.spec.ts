/**
 * D936 — a customize declaration names paths, types and vocabulary the cap
 * actually has. Each case removes one fact from a known-good fixture.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CAP_CUSTOMIZE_CATALOG } from '../../packages/types/src/generated/customize-catalog.ts'
import type { CapabilityCustomizeSpec } from '../../packages/types/src/capabilities/customize-spec.ts'
import type {
  KeyedArrayCustomizeTarget,
  PulseEventCustomizeTarget,
  ScalarCustomizeTarget,
  SpanEventCustomizeTarget,
} from '../../packages/types/src/capabilities/customize-spec.ts'
import { DeviceType } from '../../packages/types/src/device/device-type.ts'
import {
  judgeCustomize,
  loadCustomizeCaps,
  type CustomizeCapView,
  type CustomizeViolation,
} from '../lib/customize-declaration.ts'
import { projectCustomize } from '../lib/customize-project.ts'

const percentageState = z.object({ percentage: z.number().nullable() })
const pulseState = z.object({ lastPressedAt: z.number(), pressCount: z.number() })
const itemSchema = z.object({
  key: z.string(),
  label: z.string(),
  level: z.number().nullable(),
})
const itemsState = z.object({ items: z.array(itemSchema) })

interface ViewOptions {
  readonly capName?: string
  readonly deviceTypes?: readonly string[]
  readonly events?: CustomizeCapView['events']
  readonly itemArray?: CustomizeCapView['itemArray']
  readonly vocabularyHas?: CustomizeCapView['vocabularyHas']
}

function view(
  runtime: z.ZodObject<z.core.$ZodLooseShape>,
  customize: CapabilityCustomizeSpec,
  options: ViewOptions = {},
): CustomizeCapView {
  return {
    capName: options.capName ?? 'demo',
    runtimeState: runtime,
    deviceTypes: options.deviceTypes ?? [DeviceType.Camera],
    events: options.events,
    itemArray: options.itemArray,
    customize,
    vocabularyHas: options.vocabularyHas ?? (() => true),
  }
}

function rules(found: readonly CustomizeViolation[]): readonly string[] {
  return found.map((violation) => violation.rule)
}

function percentageTarget(): ScalarCustomizeTarget {
  return {
    id: 'percentage',
    cardinality: 'scalar',
    vocabulary: { cap: 'demo', stateField: 'percentage' },
    apply: 'replace',
    path: 'percentage',
    sources: [
      { kind: 'field', valueKinds: ['number', 'string'], transforms: [{ kind: 'identity' }] },
    ],
    sourceReport: { status: 'assignment-status' },
  }
}

function pulseTarget(): PulseEventCustomizeTarget {
  return {
    id: 'pressed',
    cardinality: 'event',
    shape: 'pulse',
    vocabulary: { cap: 'demo', eventName: 'onPressed' },
    apply: 'add',
    applyAuthority: { kind: 'composition-claim' },
    eventName: 'onPressed',
    edges: ['rising'],
    timestampPath: 'lastPressedAt',
    counterPath: 'pressCount',
    highWater: 'composer-advance',
    combine: 'any',
    debounce: { kind: 'rising-edge', defaultDebounceMs: 2000, changedAtRequired: true },
    sources: [{ kind: 'binary' }],
    sourceReport: { status: 'assignment-status' },
  }
}

function spanTarget(timeoutMs: number): SpanEventCustomizeTarget {
  return {
    id: 'detected',
    cardinality: 'event',
    shape: 'span',
    vocabulary: { cap: 'demo', eventName: 'onMotionChanged' },
    apply: 'replace',
    applyAuthority: { kind: 'camera-sensors', timeoutField: 'motionCooldownMs' },
    eventName: 'onMotionChanged',
    combine: 'any',
    sources: [{ kind: 'binary' }],
    sourceReport: { status: 'assignment-status' },
    start: 'rising-edge',
    end: 'falling-edge-or-timeout',
    timeoutMs,
  }
}

function keyedTarget(itemPath: string): KeyedArrayCustomizeTarget {
  return {
    id: 'items',
    cardinality: 'keyedArray',
    vocabulary: { cap: 'demo' },
    apply: 'add',
    path: itemPath,
    keyField: 'key',
    labelField: 'label',
    itemSchema,
    nativeItems: 'read-only',
    sourceReport: { status: 'assignment-status' },
    fields: [{ path: 'level', sources: [{ kind: 'numeric', transforms: [{ kind: 'identity' }] }] }],
  }
}

const pulseEvents: CustomizeCapView['events'] = {
  onPressed: { fromState: { field: 'lastPressedAt', on: 'advance' } },
}
const motionEvents: CustomizeCapView['events'] = { onMotionChanged: {} }
const itemsArray: CustomizeCapView['itemArray'] = {
  path: 'items',
  keyField: 'key',
  labelField: 'label',
}

describe('customize declaration guard', () => {
  it('accepts a scalar number leaf, including a numeric string', () => {
    const found = judgeCustomize(
      view(percentageState, { version: 1, targets: [percentageTarget()] }),
    )
    expect(found).toEqual([])
  })

  it('rejects a path the runtime state does not have', () => {
    const target = { ...percentageTarget(), path: 'missing' }
    const found = judgeCustomize(view(percentageState, { version: 1, targets: [target] }))
    expect(rules(found)).toContain('unknown-path')
  })

  it('rejects a scalar aimed at an object', () => {
    const runtime = z.object({ box: z.object({ n: z.number() }) })
    const target = { ...percentageTarget(), path: 'box' }
    const found = judgeCustomize(view(runtime, { version: 1, targets: [target] }))
    expect(rules(found)).toContain('non-leaf')
  })

  it('rejects a transform whose output cannot land in the target', () => {
    const target: ScalarCustomizeTarget = {
      ...percentageTarget(),
      sources: [{ kind: 'field', valueKinds: ['number'], transforms: [{ kind: 'invert' }] }],
    }
    const found = judgeCustomize(view(percentageState, { version: 1, targets: [target] }))
    expect(rules(found)).toContain('incompatible-transform')
  })

  it('rejects a device type the cap does not apply to', () => {
    const target = { ...percentageTarget(), deviceTypes: [DeviceType.Light] }
    const found = judgeCustomize(view(percentageState, { version: 1, targets: [target] }))
    expect(rules(found)).toContain('widened-device-type')
  })

  it('rejects a vocabulary reference the map does not have', () => {
    const found = judgeCustomize(
      view(
        percentageState,
        { version: 1, targets: [percentageTarget()] },
        { vocabularyHas: () => false },
      ),
    )
    expect(rules(found)).toContain('unknown-vocabulary')
  })

  it('rejects add mode that leaves a required companion unset', () => {
    const runtime = z.object({ percentage: z.number().nullable(), charging: z.string() })
    const target = { ...percentageTarget(), apply: 'add-or-replace' as const }
    const found = judgeCustomize(view(runtime, { version: 1, targets: [target] }))
    expect(rules(found)).toContain('missing-companion')
  })

  it('rejects camera-sensors on a pulse', () => {
    const target: PulseEventCustomizeTarget = {
      ...pulseTarget(),
      applyAuthority: { kind: 'camera-sensors', timeoutField: 'motionCooldownMs' },
    }
    const found = judgeCustomize(
      view(pulseState, { version: 1, targets: [target] }, { events: pulseEvents }),
    )
    expect(rules(found)).toContain('camera-sensors-authority')
  })

  it('rejects a pulse whose fromState advances a different path', () => {
    const target = { ...pulseTarget(), timestampPath: 'pressCount', counterPath: 'lastPressedAt' }
    const found = judgeCustomize(
      view(pulseState, { version: 1, targets: [target] }, { events: pulseEvents }),
    )
    expect(rules(found)).toContain('from-state-mismatch')
  })

  it('rejects a negative span timeout and source modes without the sensor authority', () => {
    const negative = judgeCustomize(
      view(pulseState, { version: 1, targets: [spanTarget(-1)] }, { events: motionEvents }),
    )
    expect(rules(negative)).toContain('bad-timeout')
    const modes: SpanEventCustomizeTarget = {
      ...spanTarget(30_000),
      applyAuthority: { kind: 'composition-claim' },
      sourceModes: ['in-addition'],
    }
    const found = judgeCustomize(
      view(pulseState, { version: 1, targets: [modes] }, { events: motionEvents }),
    )
    expect(rules(found)).toContain('source-modes')
  })

  it('rejects a keyed array that does not agree with status.itemArray', () => {
    const found = judgeCustomize(
      view(itemsState, { version: 1, targets: [keyedTarget('other')] }, { itemArray: itemsArray }),
    )
    expect(rules(found)).toContain('item-array-mismatch')
  })

  it('accepts a keyed array that agrees with the item schema', () => {
    const found = judgeCustomize(
      view(itemsState, { version: 1, targets: [keyedTarget('items')] }, { itemArray: itemsArray }),
    )
    expect(found).toEqual([])
  })

  it('projects field kinds and no Zod objects', () => {
    const projected = projectCustomize(
      view(percentageState, { version: 1, targets: [percentageTarget()] }),
    )
    expect(projected.targets[0]?.valueKind).toBe('number')
    expect(projected.targets[0]?.nullable).toBe(true)
    expect(JSON.stringify(projected).includes('Zod')).toBe(false)
  })

  it('rejects advanced wildcard, unknown, and excluded explicit paths', () => {
    const wildcard = judgeCustomize(
      view(percentageState, {
        version: 1,
        advanced: ['pct*'],
        targets: [percentageTarget()],
      }),
    )
    expect(rules(wildcard)).toContain('advanced-wildcard')

    const unknown = judgeCustomize(
      view(percentageState, {
        version: 1,
        advanced: ['missing'],
        targets: [percentageTarget()],
      }),
    )
    expect(rules(unknown)).toContain('advanced-unknown-path')

    const runtime = z.object({
      percentage: z.number().nullable(),
      lastFetchedAt: z.number(),
    })
    const excluded = judgeCustomize(
      view(runtime, {
        version: 1,
        advanced: ['lastFetchedAt'],
        targets: [percentageTarget()],
      }),
    )
    expect(rules(excluded)).toContain('advanced-excluded')

    const noUnit = judgeCustomize(
      view(z.object({ percentage: z.number().nullable(), watts: z.number() }), {
        version: 1,
        advanced: ['watts'],
        targets: [percentageTarget()],
      }),
    )
    expect(rules(noUnit)).toContain('advanced-excluded')
  })

  it("accepts advanced: 'derive' with no card targets", () => {
    const runtime = z.object({
      celsius: z.number().meta({ unit: '°C', label: 'Temperature' }),
      lastFetchedAt: z.number(),
    })
    const alone = judgeCustomize(view(runtime, { version: 1, advanced: 'derive', targets: [] }))
    expect(alone).toEqual([])

    const bare = judgeCustomize(view(runtime, { version: 1, targets: [] }))
    expect(rules(bare)).toContain('empty-targets')
  })

  it("accepts advanced: 'derive' on battery and running-state", async () => {
    const caps = await loadCustomizeCaps()
    const battery = caps.find((cap) => cap.capName === 'battery')
    const running = caps.find((cap) => cap.capName === 'running-state')
    expect(battery).toBeDefined()
    expect(running).toBeDefined()
    if (battery !== undefined) expect(judgeCustomize(battery)).toEqual([])
    if (running !== undefined) expect(judgeCustomize(running)).toEqual([])
  })

  it('projects derived advanced parameters for battery and running-state', async () => {
    const caps = await loadCustomizeCaps()
    const battery = projectCustomize(caps.find((cap) => cap.capName === 'battery')!)
    expect(battery.advancedParameters.map((row) => row.path)).toEqual([
      'binary',
      'charging',
      'sleeping',
    ])
    expect(battery.advancedParameters.find((row) => row.path === 'charging')).toMatchObject({
      kind: 'enum',
      label: 'Charging source',
    })

    const running = projectCustomize(caps.find((cap) => cap.capName === 'running-state')!)
    expect(running.advancedParameters).toEqual([])
  })

  it('declares the customize caps, and the catalog matches the projection', async () => {
    const caps = await loadCustomizeCaps()
    expect(caps.map((cap) => cap.capName).toSorted()).toEqual([
      'ambient-light-sensor',
      'battery',
      'binary',
      'consumables',
      'doorbell',
      'humidity-sensor',
      'motion',
      'power-meter',
      'running-state',
      'switch',
      'temperature-sensor',
    ])
    expect(CAP_CUSTOMIZE_CATALOG['temperature-sensor']?.targets).toEqual([])
    expect(CAP_CUSTOMIZE_CATALOG['temperature-sensor']?.advancedParameters).toEqual([
      { path: 'celsius', kind: 'number', label: 'Temperature', unit: '°C' },
    ])
    expect(CAP_CUSTOMIZE_CATALOG['humidity-sensor']?.advancedParameters).toEqual([
      { path: 'percent', kind: 'number', label: 'Humidity', unit: '%' },
    ])
    expect(CAP_CUSTOMIZE_CATALOG.switch?.targets).toEqual([])
    expect(CAP_CUSTOMIZE_CATALOG.binary?.targets).toEqual([])
    for (const cap of caps) {
      expect(judgeCustomize(cap)).toEqual([])
      expect(CAP_CUSTOMIZE_CATALOG[cap.capName]).toEqual(projectCustomize(cap))
    }
    expect(CAP_CUSTOMIZE_CATALOG.battery?.targets[0]?.valueKind).toBe('number')
    expect(CAP_CUSTOMIZE_CATALOG.battery?.targets[0]?.deviceTypes).toContain(DeviceType.Camera)
    const runningTypes = CAP_CUSTOMIZE_CATALOG['running-state']?.targets[0]?.deviceTypes
    expect(CAP_CUSTOMIZE_CATALOG['running-state']?.targets[0]?.valueKind).toBe('boolean')
    expect(runningTypes).toEqual([
      DeviceType.Dishwasher,
      DeviceType.Vacuum,
      DeviceType.LawnMower,
      DeviceType.MediaPlayer,
      DeviceType.WaterHeater,
      DeviceType.Humidifier,
      DeviceType.Fan,
      DeviceType.Climate,
      DeviceType.Thermostat,
      DeviceType.PetFeeder,
    ])
    expect(runningTypes).not.toContain(DeviceType.Camera)
  })
})
