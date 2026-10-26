import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { CapabilityDefinition } from '../../capabilities/capability-definition.js'
import {
  DoorbellPressEventSchema,
  DoorbellStatusSchema,
  doorbellCapability,
} from '../../capabilities/doorbell.cap.js'
import { DeviceType } from '../../device/device-type.js'
import { EventCategory } from '../../enums/event-category.js'
import { type Composition, CompositionSchema } from '../composition.js'
import {
  buildCapabilityLookup,
  type CompositionTargetDescription,
  type ValidateCompositionContext,
  validateComposition,
} from '../validate-composition.js'

const CAMERA = { addonId: 'provider-test', stableId: 'camera:event-target' }

const MISSING_FIELD_CAP = {
  ...doorbellCapability,
  events: {
    onPressed: {
      data: DoorbellPressEventSchema,
      fromState: { field: 'notThere', on: 'advance' },
    },
  },
} as const satisfies CapabilityDefinition

const NON_NUMERIC_FIELD_CAP = {
  ...doorbellCapability,
  runtimeState: DoorbellStatusSchema.extend({ label: z.string() }),
  events: {
    onPressed: {
      data: DoorbellPressEventSchema,
      fromState: { field: 'label', on: 'advance' },
    },
  },
} as const satisfies CapabilityDefinition

const UNMAPPED_EVENT_CAP = {
  ...doorbellCapability,
  events: {
    unmapped: {
      data: DoorbellPressEventSchema,
      fromState: { field: 'lastPressedAt', on: 'advance' },
    },
  },
} as const satisfies CapabilityDefinition

const WRONG_PAYLOAD_CAP = {
  ...doorbellCapability,
  events: {
    onPressed: {
      data: z.object({ deviceId: z.string(), timestamp: z.number() }),
      fromState: { field: 'lastPressedAt', on: 'advance' },
    },
  },
} as const satisfies CapabilityDefinition

function composition(
  extraFields: Readonly<Record<string, unknown>> = {},
  enabled?: boolean,
): Composition {
  return CompositionSchema.parse({
    target: { kind: 'existing', device: CAMERA },
    features: [
      {
        kind: 'fields',
        cap: 'doorbell',
        enabled,
        fields: {
          lastPressedAt: { kind: 'expression', expr: '1', bindings: {} },
          pressCountSinceStart: { kind: 'expression', expr: '0', bindings: {} },
          ...extraFields,
        },
      },
    ],
  })
}

function target(native = false): CompositionTargetDescription {
  return {
    kind: 'found',
    deviceId: 101,
    type: DeviceType.Camera,
    nativeCaps: new Map(native ? [['doorbell', 'provider-test']] : []),
  }
}

function context(cap: CapabilityDefinition, native = false): ValidateCompositionContext {
  return {
    lookupCap: buildCapabilityLookup([cap]),
    sources: new Map(),
    self: CAMERA,
    blockId: null,
    target: target(native),
    peers: [],
  }
}

describe('state-derived capability events', () => {
  it('plans doorbell.onPressed from a composed add field', () => {
    const verdict = validateComposition(composition(), context(doorbellCapability))

    expect(verdict.ok).toBe(true)
    expect(verdict.events).toEqual([
      {
        featureIndex: 0,
        cap: 'doorbell',
        eventName: 'onPressed',
        category: EventCategory.DoorbellOnPressed,
        stateField: 'lastPressedAt',
        fieldKey: 'doorbell.lastPressedAt',
      },
    ])
  })

  it('refuses a state-derived event that would replace a native doorbell (D944)', () => {
    const verdict = validateComposition(composition(), context(doorbellCapability, true))

    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.problems.map((item) => item.code)).toContain('native-capability-replace')
    expect(verdict.events).toEqual([])
  })

  it('does not plan fields or state-derived events for a disabled feature', () => {
    const verdict = validateComposition(composition({}, false), context(doorbellCapability))

    expect(verdict.ok).toBe(true)
    expect(verdict.fields).toEqual([])
    expect(verdict.events).toEqual([])
  })

  it.each([
    ['missing state field', MISSING_FIELD_CAP, {}, 'features[0].fields.notThere', 'notThere'],
    [
      'non-numeric state field',
      NON_NUMERIC_FIELD_CAP,
      { label: { kind: 'expression', expr: '"doorbell"', bindings: {} } },
      'features[0].fields.label',
      'numeric',
    ],
    ['unmapped event', UNMAPPED_EVENT_CAP, {}, 'features[0].cap', 'event-category'],
    ['wrong payload', WRONG_PAYLOAD_CAP, {}, 'features[0].cap', 'deviceId'],
  ])('refuses a %s declaration', (_name, cap, extraFields, path, reason) => {
    const verdict = validateComposition(composition(extraFields), context(cap))

    expect(verdict.ok).toBe(false)
    expect(verdict.problems).toContainEqual(
      expect.objectContaining({
        path,
        message: expect.stringContaining(reason),
      }),
    )
  })
})
