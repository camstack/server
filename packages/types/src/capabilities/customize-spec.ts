/**
 * Cap-declared Customize contract (D936).
 *
 * A declaration says what an operator may pick and how the result lands.
 * Codegen projects the serializable catalog; Zod stays in this module and
 * never in the catalog. Names follow the approved design.
 */
import type { z } from 'zod'
import type { DeviceType } from '../device/device-type.js'

export type CustomizeCardinality = 'scalar' | 'keyedArray' | 'event' | 'config'
export type CustomizeValueKind = 'boolean' | 'number' | 'string' | 'enum'
/** An extension is offered only when the device lacks the capability (D944). */
export type CustomizeApplyMode = 'add'

export interface CapabilityCustomizeSpec {
  readonly version: 1
  readonly targets: readonly CapabilityCustomizeTarget[]
}

export type CapabilityCustomizeTarget =
  | ScalarCustomizeTarget
  | KeyedArrayCustomizeTarget
  | EventCustomizeTarget
  | ConfigCustomizeTarget

export interface CustomizeVocabularyRef {
  readonly cap: string
  readonly stateField?: string
  readonly eventName?: string
}

export interface CustomizeTargetBase {
  readonly id: string
  readonly vocabulary: CustomizeVocabularyRef
  readonly deviceTypes?: readonly DeviceType[]
  readonly apply: CustomizeApplyMode
  readonly sourceReport: CustomizeSourceReport
  readonly advancedExpression?: boolean
}

export type CustomizeSourceSpec =
  | SwitchSourceSpec
  | BinarySourceSpec
  | NumericSourceSpec
  | EnumSourceSpec
  | FieldSourceSpec

export interface SwitchSourceSpec {
  readonly kind: 'switch'
  readonly transforms: readonly SwitchTransformSpec[]
}

export interface BinarySourceSpec {
  readonly kind: 'binary'
  readonly transforms: readonly BinaryTransformSpec[]
}

export interface NumericSourceSpec {
  readonly kind: 'numeric'
  readonly requiredUnit?: string
  readonly transforms: readonly NumericTransformSpec[]
}

export interface EnumSourceSpec {
  readonly kind: 'enum'
  readonly transforms: readonly EnumTransformSpec[]
}

export interface FieldSourceSpec {
  readonly kind: 'field'
  readonly valueKinds: readonly CustomizeValueKind[]
  readonly transforms: readonly CustomizeTransformSpec[]
}

export interface IdentityTransformSpec {
  readonly kind: 'identity'
}

export interface InvertTransformSpec {
  readonly kind: 'invert'
}

export type ThresholdComparison = 'gte' | 'lte'

export interface ThresholdTransformSpec {
  readonly kind: 'threshold'
  /** Comparisons the editor may offer. `comparison` is the default. */
  readonly comparisons: readonly ThresholdComparison[]
  readonly comparison: ThresholdComparison
  readonly defaultThreshold: number
  readonly defaultStartDwellMs: number
  readonly defaultStopDwellMs: number
  readonly thresholdUnit?: string
}

export interface LinearTransformSpec {
  readonly kind: 'linear'
  readonly defaultScale: number
  readonly defaultOffset: number
  readonly clampMin?: number
  readonly clampMax?: number
}

export interface EnumMapTransformSpec {
  readonly kind: 'enum-map'
  readonly outputValues: readonly string[]
  readonly unmapped: null | string
}

export interface RisingEdgeTransformSpec {
  readonly kind: 'rising-edge'
  readonly defaultDebounceMs: number
  readonly changedAtRequired: true
}

export type SwitchTransformSpec = IdentityTransformSpec
export type BinaryTransformSpec = IdentityTransformSpec | InvertTransformSpec

/** A pulse or span reads a level, or an event the source cap already emits. */
export interface EventSourceSpec {
  readonly kind: 'switch' | 'binary' | 'native-event'
}

export type CustomizeEventEdge = 'rising' | 'button' | 'native-event'

/**
 * Where the compiled target is written. Scalar and keyed-array targets use a
 * composition claim. A span may name an authority that already owns the event.
 */
export type CustomizeApplyAuthority =
  | { readonly kind: 'composition-claim' }
  | {
      readonly kind: 'camera-sensors'
      /** The span timeout is this existing pipeline-runner field. */
      readonly timeoutField: 'motionCooldownMs'
    }

export type NumericTransformSpec =
  | IdentityTransformSpec
  | ThresholdTransformSpec
  | LinearTransformSpec
export type EnumTransformSpec = IdentityTransformSpec | EnumMapTransformSpec
export type CustomizeTransformSpec =
  | IdentityTransformSpec
  | InvertTransformSpec
  | ThresholdTransformSpec
  | LinearTransformSpec
  | EnumMapTransformSpec

export interface CustomizeSourceReport {
  readonly status: 'assignment-status'
  readonly runtimeField?: string
  readonly nativeValue?: string
  readonly assignedValue?: string
}

export type CustomizeCompanion =
  | CustomizeConstantCompanion
  | CustomizeClockCompanion
  | CustomizeTransitionTimeCompanion

export interface CustomizeConstantCompanion {
  readonly kind: 'constant'
  readonly path: string
  readonly value: string | number | boolean | null
  readonly when: 'add' | 'always'
}

export interface CustomizeClockCompanion {
  readonly kind: 'clock'
  readonly path: string
  readonly when: 'add' | 'always'
}

export interface CustomizeTransitionTimeCompanion {
  readonly kind: 'transition-time'
  readonly path: string
  readonly sourceChangedAt: 'prefer' | 'ignore'
}

export interface ScalarCustomizeTarget extends CustomizeTargetBase {
  readonly cardinality: 'scalar'
  readonly path: string
  readonly sources: readonly CustomizeSourceSpec[]
  readonly companions?: readonly CustomizeCompanion[]
}

/** A closed enum the operator sets on the item. It is not read from a source. */
export interface KeyedArrayTraitSpec {
  readonly path: string
  readonly values: readonly string[]
  readonly defaultValue: string
}

/** A closed enum written beside one assigned field (the field's required sibling). */
export interface KeyedArrayLiteralSpec {
  readonly path: string
  readonly values: readonly string[]
}

export interface KeyedArrayFieldTarget {
  readonly path: string
  readonly sources: readonly CustomizeSourceSpec[]
  readonly literals?: readonly KeyedArrayLiteralSpec[]
}

export interface KeyedArrayCustomizeTarget extends CustomizeTargetBase {
  /**
   * Row schema. Zod stays on the declaration; the catalog projects paths
   * and leaf kinds instead of this object. Loose so a specific item schema
   * assigns (Zod 4 raw shapes do not).
   */
  readonly itemSchema: z.ZodObject<z.core.$ZodLooseShape>
  readonly cardinality: 'keyedArray'
  readonly path: string
  readonly keyField: string
  readonly labelField: string
  readonly fields: readonly KeyedArrayFieldTarget[]
  readonly traits?: readonly KeyedArrayTraitSpec[]
  readonly companions?: readonly CustomizeCompanion[]
  readonly nativeItems: 'read-only'
}

export interface EventCustomizeTargetBase extends CustomizeTargetBase {
  readonly cardinality: 'event'
  readonly eventName: string
  /** One source firing is enough. */
  readonly combine: 'any'
  readonly sources: readonly EventSourceSpec[]
  readonly applyAuthority: CustomizeApplyAuthority
}

/**
 * A pulse has no duration. A rising edge, a button press or a native event
 * advances a timestamp and a counter. Presses inside `debounce` are one pulse.
 */
export interface PulseEventCustomizeTarget extends EventCustomizeTargetBase {
  readonly shape: 'pulse'
  /** Edges the editor may offer. `defaultEdge` is the one a new pulse starts on. */
  readonly edges: readonly CustomizeEventEdge[]
  readonly defaultEdge: CustomizeEventEdge
  readonly timestampPath: string
  readonly counterPath: string
  /** The composer already tracks this path's advance (D670). */
  readonly highWater: 'composer-advance'
  readonly debounce: RisingEdgeTransformSpec
}

export type CameraSensorCustomizeMode = 'in-addition' | 'confirm' | 'replace'

/**
 * A span starts on a rising edge and ends on a falling edge or when
 * `timeoutMs` elapses. `cooldownMs` is present only when the authority has a
 * quiet period that is not the timeout.
 */
export interface SpanEventCustomizeTarget extends EventCustomizeTargetBase {
  readonly shape: 'span'
  readonly start: 'rising-edge'
  readonly end: 'falling-edge-or-timeout'
  readonly timeoutMs: number
  readonly cooldownMs?: number
  readonly sourceModes?: readonly CameraSensorCustomizeMode[]
}

export type EventCustomizeTarget = PulseEventCustomizeTarget | SpanEventCustomizeTarget

/**
 * An extension that is not a value composed from other devices but a
 * configuration the operator keeps for the device (D963: the remote). It has no
 * sources, no composition claim and no runtime-state path: the capability reads
 * and writes it through two of its own methods, both taking a top-level
 * `deviceId`, and the editor is derived from that pair.
 */
export interface ConfigCustomizeTarget {
  readonly id: string
  readonly cardinality: 'config'
  readonly vocabulary: CustomizeVocabularyRef
  readonly deviceTypes?: readonly DeviceType[]
  readonly apply: CustomizeApplyMode
  /** The query that returns the stored configuration of a device. */
  readonly readMethod: string
  /** The mutation that replaces it. */
  readonly writeMethod: string
}
