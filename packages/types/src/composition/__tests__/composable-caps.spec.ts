import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { CapabilityDefinition } from '../../capabilities/capability-definition.js'
import { DoorbellPressEventSchema, doorbellCapability } from '../../capabilities/doorbell.cap.js'
import { DeviceType } from '../../device/device-type.js'
import { ALL_CAPABILITY_DEFINITIONS } from '../../generated/capability-router-map.js'
import { builtCapabilityBlockers, describeComposableCaps } from '../composable-caps.js'
import type { Composition } from '../composition.js'
import { buildCapabilityLookup, planComposition } from '../validate-composition.js'

const lookup = buildCapabilityLookup(ALL_CAPABILITY_DEFINITIONS)
const BLOCKING = new Set([
  'unknown-capability',
  'not-composable',
  'wrong-device-type',
  'has-commands',
])

function validatorBlocks(cap: string, type: DeviceType): boolean {
  const def = lookup(cap)
  const composition: Composition = {
    target: { kind: 'new', type },
    features: [
      {
        kind: 'fields',
        cap,
        fields: {},
        ...(def?.status?.itemArray === undefined ? {} : { items: {} }),
      },
    ],
  }
  return planComposition(composition, lookup).problems.some((p) => BLOCKING.has(p.code))
}

describe('describeComposableCaps', () => {
  it('offers battery on a pet feeder and not on a light', () => {
    const feeder = describeComposableCaps(ALL_CAPABILITY_DEFINITIONS, DeviceType.PetFeeder)
    const light = describeComposableCaps(ALL_CAPABILITY_DEFINITIONS, DeviceType.Light)
    expect(feeder.map((c) => c.cap)).toContain('battery')
    expect(light.map((c) => c.cap)).not.toContain('battery')
  })

  it('offers doorbell on a camera, with its fields described', () => {
    const doorbell = describeComposableCaps(ALL_CAPABILITY_DEFINITIONS, DeviceType.Camera).find(
      (c) => c.cap === 'doorbell',
    )
    expect(doorbell?.fields.map((f) => f.path)).toEqual(
      expect.arrayContaining(['lastPressedAt', 'pressCountSinceStart']),
    )
  })

  it('never offers the caps every device registers itself', () => {
    const caps = describeComposableCaps(ALL_CAPABILITY_DEFINITIONS, DeviceType.Sensor).map(
      (c) => c.cap,
    )
    expect(caps).not.toContain('device-status')
    expect(caps).not.toContain('feature-probe')
  })

  it('describes the item array of consumables', () => {
    const consumables = describeComposableCaps(
      ALL_CAPABILITY_DEFINITIONS,
      DeviceType.PetFeeder,
    ).find((c) => c.cap === 'consumables')
    expect(consumables?.itemArray).toEqual({ path: 'items', keyField: 'key' })
  })

  // Every device type: on a few, each cap with a nested required key is ALSO
  // refused for another reason, which hid the nested-required blocker (M1).
  it.each(
    Object.values(DeviceType),
  )('agrees with the validator for every capability on %s', (type) => {
    for (const def of ALL_CAPABILITY_DEFINITIONS) {
      const listed = builtCapabilityBlockers(def, type).length === 0
      expect({ cap: def.name, listed }).toEqual({
        cap: def.name,
        listed: !validatorBlocks(def.name, type),
      })
    }
  })
})

// A state-derived event the composer cannot emit refuses the whole cap; no cap
// in today's catalogue triggers it, so a made-up definition pins the branch (L1).
const UNMAPPED_EVENT_CAP = {
  ...doorbellCapability,
  events: {
    unmapped: {
      data: DoorbellPressEventSchema,
      fromState: { field: 'lastPressedAt', on: 'advance' },
    },
  },
} as const satisfies CapabilityDefinition

const UNBUILDABLE_PAYLOAD_CAP = {
  ...doorbellCapability,
  events: {
    onPressed: {
      data: z.object({ deviceId: z.string(), timestamp: z.number() }),
      fromState: { field: 'lastPressedAt', on: 'advance' },
    },
  },
} as const satisfies CapabilityDefinition

function validatorCodes(def: CapabilityDefinition): readonly string[] {
  const composition: Composition = {
    target: { kind: 'new', type: DeviceType.Camera },
    features: [{ kind: 'fields', cap: def.name, fields: {} }],
  }
  return planComposition(composition, buildCapabilityLookup([def])).problems.map((p) => p.code)
}

describe('a cap whose state-derived event cannot be emitted', () => {
  it('is offered when its event maps (control)', () => {
    expect(builtCapabilityBlockers(doorbellCapability, DeviceType.Camera)).toEqual([])
  })

  it.each([
    ['no category mapping', UNMAPPED_EVENT_CAP],
    ['a payload not buildable from { deviceId, timestamp }', UNBUILDABLE_PAYLOAD_CAP],
  ])('is not offered with %s — and the validator refuses it the same way', (_why, def) => {
    expect(builtCapabilityBlockers(def, DeviceType.Camera)).toEqual(['not-composable'])
    expect(describeComposableCaps([def], DeviceType.Camera)).toEqual([])
    expect(validatorCodes(def)).toContain('not-composable')
  })
})
