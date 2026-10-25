import { describe, it, expect } from 'vitest'
import { AI_CLASS_MAP } from '../schema'
import {
  buildSupportedNativeClasses,
  isNativeObjectForwardingEnabled,
} from '../native-detection-mapping'
import {
  DeviceRuntimeState,
  NativeObjectClassEnum,
  NativeObjectDetectionRuntimeStateSchema,
} from '@camstack/types'

/**
 * The REAL builder, not a copy.
 *
 * The version of this test that shipped re-implemented `buildSupportedClasses`
 * locally and asserted that `dog_cat` "has no mapping" — encoding a live defect
 * as intent. Camera 108 probed `["people","vehicle","dog_cat"]` and reported
 * `supportedClasses: ["person","vehicle"]` while its own `lastByClass` held an
 * `animal` detection: the system said the camera could not detect a class it
 * was detecting, and the suite was green about it.
 */
function buildSupportedClassesFromAiDetectTypes(
  aiDetectTypes: string[] | undefined,
): readonly string[] {
  return buildSupportedNativeClasses(aiDetectTypes, (v) =>
    NativeObjectClassEnum.options.includes(v as never),
  )
}

describe('native-object-detection gate: isNativeObjectForwardingEnabled', () => {
  it('forwards when enabled is true', () => {
    expect(isNativeObjectForwardingEnabled({ enabled: true })).toBe(true)
  })

  it('suppresses when enabled is false', () => {
    expect(isNativeObjectForwardingEnabled({ enabled: false })).toBe(false)
  })

  it('defaults to suppress when capState is null (cap not yet written) — opt-in default', () => {
    expect(isNativeObjectForwardingEnabled(null)).toBe(false)
  })

  it('defaults to suppress when capState is undefined (slice absent) — opt-in default', () => {
    expect(isNativeObjectForwardingEnabled(undefined)).toBe(false)
  })
})

describe('native-object-detection: AI_CLASS_MAP mapping', () => {
  it('maps all known Baichuan lib names to valid NativeObjectClass values', () => {
    const libNames = Object.keys(AI_CLASS_MAP)
    for (const libName of libNames) {
      const mapped = AI_CLASS_MAP[libName]!
      expect(NativeObjectClassEnum.options).toContain(mapped)
    }
  })

  it('buildSupportedClasses maps probed aiDetectTypes to cap enum values', () => {
    const result = buildSupportedClassesFromAiDetectTypes([
      'people',
      'vehicle',
      'animal',
      'face',
      'package',
    ])
    expect(result).toEqual(
      expect.arrayContaining(['person', 'vehicle', 'animal', 'face', 'package']),
    )
    expect(result).toHaveLength(5)
  })

  // The live bug, as its own case: the cmd-299 probe says `dog_cat` where the
  // cmd-33 push says `animal`. Two vocabularies, one class.
  it('maps the PROBE vocabulary too — dog_cat is the same animal the push reports', () => {
    expect(buildSupportedClassesFromAiDetectTypes(['people', 'vehicle', 'dog_cat'])).toEqual([
      'person',
      'vehicle',
      'animal',
    ])
  })

  it('lists a class once even when both vocabularies name it', () => {
    expect(buildSupportedClassesFromAiDetectTypes(['animal', 'dog_cat'])).toEqual(['animal'])
  })

  it('still skips a name neither vocabulary knows', () => {
    expect(buildSupportedClassesFromAiDetectTypes(['people', 'unknown_future'])).toEqual(['person'])
  })

  it('buildSupportedClasses falls back to full AI_CLASS_MAP values when probe absent', () => {
    const result = buildSupportedClassesFromAiDetectTypes(undefined)
    const expected = [...new Set(Object.values(AI_CLASS_MAP))].filter((v) =>
      NativeObjectClassEnum.options.includes(v as never),
    )
    expect(result.toSorted()).toEqual(expected.toSorted())
  })

  it('buildSupportedClasses returns empty when aiDetectTypes is empty array', () => {
    const result = buildSupportedClassesFromAiDetectTypes([])
    // Empty array triggers the fallback (same as undefined)
    const expected = [...new Set(Object.values(AI_CLASS_MAP))].filter((v) =>
      NativeObjectClassEnum.options.includes(v as never),
    )
    expect(result.toSorted()).toEqual(expected.toSorted())
  })
})

/**
 * Regression guard for the partial-record root cause.
 *
 * The runtime-state slice is written sparsely: `empty()` seeds
 * `lastByClass: {}` and `handleSimpleEvent` patches in ONE class at a
 * time. In Zod 4 `z.record(enum, …)` is EXHAUSTIVE — it required every
 * enum key, so those partial writes threw a ZodError ("expected object,
 * received undefined") on every onboard AI push. The schema MUST use a
 * partial record so the shapes the provider actually writes validate.
 */
describe('native-object-detection: runtime-state schema accepts partial lastByClass', () => {
  it('accepts the cold-start empty() default (lastByClass: {})', () => {
    const result = NativeObjectDetectionRuntimeStateSchema.safeParse({
      enabled: true,
      lastByClass: {},
      supportedClasses: ['person', 'vehicle'],
      lastFetchedAt: 0,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a single-class push (what handleSimpleEvent writes)', () => {
    const result = NativeObjectDetectionRuntimeStateSchema.safeParse({
      enabled: true,
      lastByClass: { person: { class: 'person', timestamp: 1 } },
      supportedClasses: ['person'],
      lastFetchedAt: 0,
    })
    expect(result.success).toBe(true)
  })

  it('still rejects an unknown class key (enum-key narrowing preserved)', () => {
    const result = NativeObjectDetectionRuntimeStateSchema.safeParse({
      enabled: true,
      lastByClass: { notaclass: { class: 'person', timestamp: 1 } },
      supportedClasses: [],
      lastFetchedAt: 0,
    })
    expect(result.success).toBe(false)
  })
})

/**
 * Regression guard for the unseeded-slice ZodError (live symptom:
 * `[ReolinkBaichuanApi] onSimpleEvent handler error ZodError` — missing
 * supportedClasses / enabled / lastFetchedAt).
 *
 * Drives the REAL `DeviceRuntimeState` merge path — not just the schema —
 * because the root cause is `patchCapState` merging a partial push onto an
 * empty base. `registerNativeObjectDetectionCap` MUST eager-seed the full
 * slice after `registerNativeCap` so the push path's partial write merges
 * onto a complete base instead of `{}`.
 */
describe('native-object-detection: seed-then-patch merge path', () => {
  const CAP = 'native-object-detection'
  const buildRuntimeState = (): DeviceRuntimeState => {
    const rs = DeviceRuntimeState.fromInitial({}, async () => {})
    rs.installCapSchema(CAP, NativeObjectDetectionRuntimeStateSchema)
    return rs
  }

  it('RED: an unseeded partial push throws the 3-field ZodError', () => {
    const rs = buildRuntimeState()
    // This is exactly what handleSimpleEvent writes on the AI-class hot path.
    expect(() =>
      rs.patchCapState(CAP, {
        lastByClass: { person: { class: 'person', timestamp: 1 } },
      }),
    ).toThrow()
  })

  it('GREEN: seed the full slice first, then the partial push merges cleanly', () => {
    const rs = buildRuntimeState()
    // Eager seed (mirrors registerNativeObjectDetectionCap after registerNativeCap).
    rs.setCapState(CAP, {
      enabled: false,
      lastByClass: {},
      supportedClasses: ['person', 'vehicle'],
      lastFetchedAt: Date.now(),
    })
    expect(() =>
      rs.patchCapState(CAP, {
        lastByClass: { person: { class: 'person', timestamp: 1 } },
      }),
    ).not.toThrow()
    const slice = rs.getCapState(CAP)
    // Untouched fields survive the merge; the partial only overwrites lastByClass.
    expect(slice).toMatchObject({
      enabled: false,
      supportedClasses: ['person', 'vehicle'],
      lastByClass: { person: { class: 'person', timestamp: 1 } },
    })
  })
})
