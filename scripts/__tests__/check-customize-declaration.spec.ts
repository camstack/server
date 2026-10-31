/**
 * D936 — a customize declaration names paths, types and vocabulary the cap
 * actually has. Each case removes one fact from a known-good fixture.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { CAP_CUSTOMIZE_CATALOG } from '../../packages/types/src/generated/customize-catalog.ts'
import type { CapabilityCustomizeSpec } from '../../packages/types/src/capabilities/customize-spec.ts'
import type {
  ConfigCustomizeTarget,
  KeyedArrayCustomizeTarget,
  PulseEventCustomizeTarget,
  ScalarCustomizeTarget,
  SpanEventCustomizeTarget,
} from '../../packages/types/src/capabilities/customize-spec.ts'
import { DeviceType } from '../../packages/types/src/device/device-type.ts'
import {
  judgeCustomize,
  loadCustomizeCaps,
  loadRuntimeFieldUnits,
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
  readonly methods?: CustomizeCapView['methods']
}

function view(
  runtime: z.ZodObject<z.core.$ZodLooseShape> | undefined,
  customize: CapabilityCustomizeSpec,
  options: ViewOptions = {},
): CustomizeCapView {
  return {
    capName: options.capName ?? 'demo',
    runtimeState: runtime,
    deviceTypes: options.deviceTypes ?? [DeviceType.Camera],
    events: options.events,
    itemArray: options.itemArray,
    methods: options.methods ?? {},
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
    apply: 'add',
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
    defaultEdge: 'rising',
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
    apply: 'add',
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
    const target = { ...percentageTarget(), apply: 'add' as const }
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

  it('rejects a customize declaration with no targets', () => {
    const bare = judgeCustomize(view(percentageState, { version: 1, targets: [] }))
    expect(rules(bare)).toContain('empty-targets')
  })

  it('accepts battery and running-state as add-only extensions', async () => {
    const caps = await loadCustomizeCaps()
    const battery = caps.find((cap) => cap.capName === 'battery')
    const running = caps.find((cap) => cap.capName === 'running-state')
    expect(battery).toBeDefined()
    expect(running).toBeDefined()
    if (battery !== undefined) expect(judgeCustomize(battery)).toEqual([])
    if (running !== undefined) expect(judgeCustomize(running)).toEqual([])
    expect(battery?.customize?.targets.every((target) => target.apply === 'add')).toBe(true)
    expect(running?.customize?.targets.every((target) => target.apply === 'add')).toBe(true)
  })

  it('publishes a labelled reading base unit, and leaves an unlabelled quantity out', async () => {
    const units = await loadRuntimeFieldUnits()
    // D944 §4: the stored base of a labelled reading is the convert-unit
    // source. There is no Advanced list for it to land in.
    expect(units.battery).toMatchObject({ level: '%', voltage: 'V' })
    expect(units['temperature-sensor']).toMatchObject({ temperature: '°C' })
    expect(units['power-meter']).toMatchObject({ power: 'W', voltage: 'V', current: 'A' })
    expect(units['power-meter']?.va).toBeUndefined()
  })

  it('declares the customize caps, and the catalog matches the projection', async () => {
    const caps = await loadCustomizeCaps()
    expect(caps.map((cap) => cap.capName).toSorted()).toEqual([
      'battery',
      'consumables',
      'doorbell',
      'lock-control',
      'motion',
      'power-meter',
      'remote',
      'running-state',
    ])
    expect(CAP_CUSTOMIZE_CATALOG['temperature-sensor']).toBeUndefined()
    expect(CAP_CUSTOMIZE_CATALOG.battery?.targets.every((target) => target.apply === 'add')).toBe(
      true,
    )
    expect(CAP_CUSTOMIZE_CATALOG.motion?.targets[0]?.apply).toBe('add')
    expect(CAP_CUSTOMIZE_CATALOG.motion?.targets[0]?.sourceModes).toEqual([
      'in-addition',
      'confirm',
      'replace',
    ])
    for (const cap of caps) {
      expect(judgeCustomize(cap)).toEqual([])
      expect(CAP_CUSTOMIZE_CATALOG[cap.capName]).toEqual(projectCustomize(cap))
    }
    expect(CAP_CUSTOMIZE_CATALOG.battery?.targets[0]?.valueKind).toBe('number')
    expect(CAP_CUSTOMIZE_CATALOG.battery?.targets[0]?.deviceTypes).toContain(DeviceType.Camera)
    const runningTypes = CAP_CUSTOMIZE_CATALOG['running-state']?.targets[0]?.deviceTypes
    expect(CAP_CUSTOMIZE_CATALOG['running-state']?.targets[0]?.valueKind).toBe('boolean')
    expect(runningTypes).toEqual([
      DeviceType.Washer,
      DeviceType.Dryer,
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

describe('a config target (D963)', () => {
  const config: ConfigCustomizeTarget = {
    id: 'remote',
    cardinality: 'config',
    vocabulary: { cap: 'demo' },
    apply: 'add',
    readMethod: 'getConfig',
    writeMethod: 'setConfig',
  }
  const spec: CapabilityCustomizeSpec = { version: 1, targets: [config] }
  const methods: CustomizeCapView['methods'] = {
    getConfig: { kind: 'query', takesDeviceId: true },
    setConfig: { kind: 'mutation', takesDeviceId: true },
  }

  it('needs no runtime state and judges clean when its two methods exist', () => {
    expect(judgeCustomize(view(undefined, spec, { methods }))).toEqual([])
  })

  it('names a read or write method the cap does not have', () => {
    const found = judgeCustomize(
      view(undefined, spec, { methods: { getConfig: methods.getConfig! } }),
    )
    expect(rules(found)).toEqual(['unknown-config-method'])
  })

  it('refuses a write that is not a mutation or a method that does not take deviceId', () => {
    const wrongKind = judgeCustomize(
      view(undefined, spec, {
        methods: { ...methods, setConfig: { kind: 'query', takesDeviceId: true } },
      }),
    )
    expect(rules(wrongKind)).toEqual(['bad-config-method'])
    const noDevice = judgeCustomize(
      view(undefined, spec, {
        methods: { ...methods, getConfig: { kind: 'query', takesDeviceId: false } },
      }),
    )
    expect(rules(noDevice)).toEqual(['bad-config-method'])
  })

  it('projects to the catalog with both methods and no sources', () => {
    const entry = projectCustomize(view(undefined, spec, { methods }))
    expect(entry.targets[0]).toMatchObject({
      id: 'remote',
      cardinality: 'config',
      readMethod: 'getConfig',
      writeMethod: 'setConfig',
      sources: [],
    })
  })
})
