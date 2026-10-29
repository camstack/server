/**
 * Serializable Customize catalog (D936). No Zod objects: admin-ui and the
 * server read this projection, not the cap module.
 */
import type { DeviceType } from '../device/device-type.js'
import type {
  CameraSensorCustomizeMode,
  CustomizeApplyAuthority,
  CustomizeApplyMode,
  CustomizeCardinality,
  CustomizeCompanion,
  CustomizeEventEdge,
  CustomizeSourceReport,
  CustomizeValueKind,
} from './customize-spec.js'

export type CustomizeCatalogValueKind = 'boolean' | 'number' | 'string' | 'enum'

export type CustomizeCatalogTransform =
  | { readonly kind: 'identity' }
  | { readonly kind: 'invert' }
  | {
      readonly kind: 'threshold'
      readonly comparisons: readonly ('gte' | 'lte')[]
      readonly comparison: 'gte' | 'lte'
      readonly defaultThreshold: number
      readonly defaultStartDwellMs: number
      readonly defaultStopDwellMs: number
      readonly thresholdUnit?: string
    }
  | {
      readonly kind: 'linear'
      readonly defaultScale: number
      readonly defaultOffset: number
      readonly clampMin?: number
      readonly clampMax?: number
    }
  | {
      readonly kind: 'enum-map'
      readonly outputValues: readonly string[]
      readonly unmapped: string | null
    }

export interface CustomizeCatalogSource {
  readonly kind: string
  readonly valueKinds?: readonly CustomizeValueKind[]
  readonly transformKinds: readonly string[]
  /** Every declared parameter, including its default. The editor reads only this. */
  readonly transforms: readonly CustomizeCatalogTransform[]
  readonly requiredUnit?: string
}

export interface CustomizeCatalogLiteral {
  readonly path: string
  readonly values: readonly string[]
}

export interface CustomizeCatalogTrait {
  readonly path: string
  readonly values: readonly string[]
  readonly defaultValue: string
}

export interface CustomizeCatalogField {
  readonly path: string
  readonly valueKind: CustomizeCatalogValueKind
  readonly nullable: boolean
  readonly enumValues?: readonly string[]
  readonly sources: readonly CustomizeCatalogSource[]
  readonly literals?: readonly CustomizeCatalogLiteral[]
}

export interface CustomizeCatalogTarget {
  readonly id: string
  readonly cardinality: CustomizeCardinality
  readonly shape?: 'pulse' | 'span'
  readonly path?: string
  readonly valueKind?: CustomizeCatalogValueKind
  readonly nullable?: boolean
  readonly enumValues?: readonly string[]
  readonly keyField?: string
  readonly labelField?: string
  readonly fields?: readonly CustomizeCatalogField[]
  readonly traits?: readonly CustomizeCatalogTrait[]
  readonly nativeItems?: 'read-only'
  readonly deviceTypes: readonly DeviceType[]
  readonly apply: CustomizeApplyMode
  /** Absent on a scalar or keyed array: those compile to a composition claim. */
  readonly applyAuthority?: CustomizeApplyAuthority
  readonly eventName?: string
  readonly edges?: readonly CustomizeEventEdge[]
  readonly defaultEdge?: CustomizeEventEdge
  readonly timestampPath?: string
  readonly counterPath?: string
  readonly highWater?: 'composer-advance'
  readonly debounceMs?: number
  readonly combine?: 'any'
  readonly timeoutMs?: number
  readonly cooldownMs?: number
  readonly sourceModes?: readonly CameraSensorCustomizeMode[]
  readonly start?: 'rising-edge'
  readonly end?: 'falling-edge-or-timeout'
  /** A `config` target: the cap methods that read and write the stored configuration. */
  readonly readMethod?: string
  readonly writeMethod?: string
  readonly vocabularyCap: string
  readonly vocabularyStateField?: string
  readonly vocabularyEvent?: string
  readonly sources: readonly CustomizeCatalogSource[]
  readonly companions?: readonly CustomizeCompanion[]
  readonly sourceReport: CustomizeSourceReport
  readonly advancedExpression: boolean
}

export interface CustomizeCatalogEntry {
  readonly version: 1
  readonly targets: readonly CustomizeCatalogTarget[]
}

export type CustomizeCatalog = Readonly<Record<string, CustomizeCatalogEntry>>
