/**
 * The SHAPE of the cap vocabulary (D920): what an operator can make a device
 * DO, and what a device can be WATCHED for, phrased for humans — keyed by
 * capability name, typed against the capability definitions themselves.
 *
 * Every key type here is DERIVED from the cap registry
 * (`generated/capability-router-map.ts`, imported as a TYPE only — no runtime
 * cost, no Zod graph in a browser bundle): a method, status field or event
 * name that does not exist on the cap is a TypeScript error, and so is a
 * missing cap. `scripts/check-cap-vocabulary.ts` checks what a type cannot:
 * that every operate method is phrased or excused, that offered values agree
 * with the method's Zod input, that every placeholder has an arg, and that
 * every label carries both languages.
 *
 * Translations live INLINE (`{ en, it }`) next to the entry they translate —
 * one source, so a new action cannot ship in one language.
 */
import type { z } from 'zod'
import type * as CapRegistry from '../../generated/capability-router-map.js'
import type { EventCategory } from '../../enums/event-category.js'
import type { ICON_KEYS } from '../icon-catalog.generated.js'
import type { DeviceRole, DeviceType } from '../device-type.js'

/** One catalog icon key (lucide id) — the same vocabulary as `IconKey`. */
export type VocabIcon = (typeof ICON_KEYS)[number]

/** A human string in every language the map carries. */
export interface L10n {
  readonly en: string
  readonly it: string
}

/** A language the vocabulary is written in. */
export type VocabLocale = keyof L10n

// ── Key types derived from the cap registry ────────────────────────────

type CapRegistryModule = typeof CapRegistry

/** The minimal structural shape that tells a cap definition export apart. */
interface CapDefinitionLike {
  readonly name: string
  readonly scope: 'system' | 'device'
  readonly methods: object
}

/** Cap name → its definition TYPE, for every cap the registry exports. */
export type CapDefinitionsByName = {
  readonly [K in keyof CapRegistryModule as CapRegistryModule[K] extends CapDefinitionLike
    ? CapRegistryModule[K]['name']
    : never]: CapRegistryModule[K]
}

/** Every capability name. */
export type VocabCapName = keyof CapDefinitionsByName & string

type CapDef<C extends VocabCapName> = CapDefinitionsByName[C]

/** Device-scoped cap names (the ones a device's vocabulary is made of). */
export type DeviceVocabCapName = {
  [C in VocabCapName]: CapDef<C>['scope'] extends 'device' ? C : never
}[VocabCapName]

/** System-scoped cap names (never part of a device's vocabulary). */
export type SystemVocabCapName = Exclude<VocabCapName, DeviceVocabCapName>

/** A method name declared by cap `C`. */
export type CapMethodName<C extends VocabCapName> = keyof CapDef<C>['methods'] & string

type MethodSchemaOf<C extends VocabCapName, M extends CapMethodName<C>> = CapDef<C>['methods'][M]

type MethodInputOf<C extends VocabCapName, M extends CapMethodName<C>> =
  MethodSchemaOf<C, M> extends { readonly input: infer I extends z.ZodType } ? z.input<I> : never

/** The operator-supplied part of a method input (`deviceId` is the target). */
export type ActionArgs<C extends VocabCapName, M extends CapMethodName<C>> =
  MethodInputOf<C, M> extends object ? Omit<MethodInputOf<C, M>, 'deviceId'> : Record<never, never>

/** A key of {@link ActionArgs}. */
export type ActionArgKey<C extends VocabCapName, M extends CapMethodName<C>> = keyof ActionArgs<
  C,
  M
> &
  string

type StatusOf<C extends VocabCapName> =
  CapDef<C> extends {
    readonly status: { readonly schema: infer S extends z.ZodType }
  }
    ? z.output<S>
    : CapDef<C> extends { readonly runtimeState: infer R extends z.ZodType }
      ? z.output<R>
      : never

/** A top-level status field of cap `C`. */
export type CapStatusField<C extends VocabCapName> = [StatusOf<C>] extends [never]
  ? never
  : keyof StatusOf<C> & string

/** An event name declared by cap `C`. */
export type CapEventName<C extends VocabCapName> =
  CapDef<C> extends { readonly events: infer E } ? keyof E & string : never

// ── Offering values for an open arg ────────────────────────────────────

/** One choice of a closed set, with its label. */
export interface VocabChoice {
  readonly value: string | number
  readonly label: L10n
}

/** A closed set — every value MUST be one the method's Zod input accepts. */
export interface EnumOffer {
  readonly kind: 'enum'
  readonly values: readonly VocabChoice[]
}

/** A number, within the Zod input's bounds. `unit` is a display suffix. */
export interface NumberOffer {
  readonly kind: 'number'
  readonly min?: number
  readonly max?: number
  readonly step?: number
  readonly unit?: string
}

/** Free text. */
export interface TextOffer {
  readonly kind: 'text'
  /** True for a secret the UI should mask (a PIN code). */
  readonly secret?: boolean
}

/** A yes/no. */
export interface BooleanOffer {
  readonly kind: 'boolean'
}

/**
 * Values the DEVICE knows, read at authoring time from the same cap:
 * a status field holding a list, or a read method returning one.
 * `valueKey` / `labelKey` pick the fields of an object item (omit both for a
 * list of strings); `where` keeps only items whose field equals a value.
 */
export type DynamicOffer<C extends VocabCapName> =
  | {
      readonly kind: 'dynamic'
      readonly from: 'status'
      readonly field: CapStatusField<C>
      readonly valueKey?: string
      readonly labelKey?: string
      readonly where?: {
        readonly key: string
        readonly equals: string | number | boolean
      }
      /** The type of the value the method takes (default string). */
      readonly valueKind?: 'string' | 'number'
    }
  | {
      readonly kind: 'dynamic'
      readonly from: 'method'
      readonly method: CapMethodName<C>
      readonly valueKey?: string
      readonly labelKey?: string
      readonly where?: {
        readonly key: string
        readonly equals: string | number | boolean
      }
      readonly valueKind?: 'string' | 'number'
    }

/** How the authoring UI offers a value for an open arg. */
export type VocabOffer<C extends VocabCapName> =
  | EnumOffer
  | NumberOffer
  | TextOffer
  | BooleanOffer
  | DynamicOffer<C>

/** An arg the operator fills after picking the action. */
export interface VocabOpenArg<C extends VocabCapName, K extends string> {
  readonly key: K
  readonly label: L10n
  readonly offer: VocabOffer<C>
  /** The method accepts the call without it. */
  readonly optional?: boolean
}

// ── Actions ────────────────────────────────────────────────────────────

/** One operator-facing action: a cap method call with a phrase. */
export interface VocabActionFor<C extends VocabCapName, M extends CapMethodName<C>> {
  /** Stable id — persisted by pickers as a select value (`switch.on`). */
  readonly id: string
  readonly method: M
  /** Short label for a picker ("Turn on"). */
  readonly label: L10n
  /**
   * The sentence ("Turn on {device}", "Move {device} to {presetId}").
   * Placeholders: `{device}` and any open or fixed arg key.
   */
  readonly phrase: L10n
  readonly icon: VocabIcon
  /** Args baked into the action — never asked. */
  readonly args?: Partial<ActionArgs<C, M>>
  /** Args the operator fills. */
  readonly openArgs?: readonly VocabOpenArg<C, ActionArgKey<C, M>>[]
}

/** Any action of cap `C`, discriminated by `method`. */
export type VocabAction<C extends VocabCapName> = {
  [M in CapMethodName<C>]: VocabActionFor<C, M>
}[CapMethodName<C>]

// ── State triggers ─────────────────────────────────────────────────────

/** A true/false field: one phrase per edge. */
export interface BooleanStateTrigger<C extends VocabCapName> {
  readonly kind: 'boolean'
  readonly field: CapStatusField<C>
  /** What the field is ("Contact", "Motion") — a picker label. */
  readonly label: L10n
  readonly whenTrue: L10n
  readonly whenFalse: L10n
  readonly icon: VocabIcon
}

/** A number: rises above / falls below / changes by, with a unit. */
export interface NumericStateTrigger<C extends VocabCapName> {
  readonly kind: 'numeric'
  readonly field: CapStatusField<C>
  /** The quantity WITH its article, as it reads in a sentence ("the temperature" / "la temperatura"). */
  readonly quantity: L10n
  readonly label: L10n
  /** Display unit; omit when the device states it (see `unitField`). */
  readonly unit?: string
  /** A status field carrying the device's own unit (`numeric-sensor.unit`). */
  readonly unitField?: CapStatusField<C>
  readonly icon: VocabIcon
}

/** One value of an enum field, with how "becomes" reads for it. */
export interface EnumStateValue {
  readonly value: string
  readonly label: L10n
  /** Override of the default "When {device} changes to {value}". */
  readonly phrase?: L10n
}

/** A closed set of states. */
export interface EnumStateTrigger<C extends VocabCapName> {
  readonly kind: 'enum'
  readonly field: CapStatusField<C>
  readonly label: L10n
  readonly values: readonly EnumStateValue[]
  readonly icon: VocabIcon
}

/** A free string the device reports (a presence zone, an enum sensor's state). */
export interface ValueStateTrigger<C extends VocabCapName> {
  readonly kind: 'value'
  readonly field: CapStatusField<C>
  readonly label: L10n
  /** Where known values come from, when the device lists them. */
  readonly offer?: DynamicOffer<C>
  /** Override of the default "When {device} changes to {value}". */
  readonly phrase?: L10n
  readonly icon: VocabIcon
}

/** A state field worth triggering on. */
export type VocabStateTrigger<C extends VocabCapName> =
  | BooleanStateTrigger<C>
  | NumericStateTrigger<C>
  | EnumStateTrigger<C>
  | ValueStateTrigger<C>

// ── Event triggers ─────────────────────────────────────────────────────

/** A bus event the device emits, phrased ("When {device} rings"). */
export interface VocabEventTrigger {
  readonly category: EventCategory
  readonly label: L10n
  readonly phrase: L10n
  readonly icon: VocabIcon
}

/** A declared cap event that is not an automation trigger, and why. */
export interface VocabEventExcused {
  readonly notOperatorFacing: string
}

// ── Overrides by device type / role ────────────────────────────────────

/** Re-wording of one action for a kind of device. */
export interface VocabActionWording {
  readonly label?: L10n
  readonly phrase?: L10n
  readonly icon?: VocabIcon
}

/** Re-wording of one state trigger for a kind of device. */
export interface VocabStateWording {
  readonly label?: L10n
  readonly whenTrue?: L10n
  readonly whenFalse?: L10n
  readonly quantity?: L10n
  readonly icon?: VocabIcon
}

/** Wording that differs for a device type or role (a switch that is a siren). */
export interface VocabWording<C extends VocabCapName> {
  /** Keyed by action id. */
  readonly actions?: Readonly<Record<string, VocabActionWording>>
  readonly state?: { readonly [F in CapStatusField<C>]?: VocabStateWording }
}

/** Overrides, keyed in the same map: a role beats a type. */
export interface VocabOverrides<C extends VocabCapName> {
  readonly byType?: { readonly [T in DeviceType]?: VocabWording<C> }
  readonly byRole?: { readonly [R in DeviceRole]?: VocabWording<C> }
}

// ── Entries ────────────────────────────────────────────────────────────

type DeviceEventsBlock<C extends VocabCapName> = [CapEventName<C>] extends [never]
  ? { readonly events?: undefined }
  : {
      /** EVERY declared cap event: a trigger, or an excuse. */
      readonly events: {
        readonly [E in CapEventName<C>]: VocabEventTrigger | VocabEventExcused
      }
    }

/** The vocabulary of a device-scoped cap. */
export type DeviceCapVocabulary<C extends VocabCapName> = {
  readonly scope: 'device'
  /** What the cap is, for grouping ("Switch" / "Interruttore"). */
  readonly noun: L10n
  readonly actions?: readonly VocabAction<C>[]
  /** Operate methods deliberately NOT offered, with the reason. */
  readonly notOperatorFacing?: { readonly [M in CapMethodName<C>]?: string }
  readonly state?: readonly VocabStateTrigger<C>[]
  /** Bus events the cap's devices emit with no declared cap event behind them. */
  readonly extraEvents?: readonly VocabEventTrigger[]
  readonly overrides?: VocabOverrides<C>
} & DeviceEventsBlock<C>

/** A system-scoped cap: never a device's vocabulary, and why. */
export interface SystemCapVocabulary {
  readonly scope: 'system'
  readonly notOperatorFacing: string
}

/** The entry a cap must have. */
export type CapVocabularyEntry<C extends VocabCapName> = CapDef<C>['scope'] extends 'device'
  ? DeviceCapVocabulary<C>
  : SystemCapVocabulary

/** The complete map: one entry per cap, no more, no fewer. */
export type CapVocabularyMap = {
  readonly [C in VocabCapName]: CapVocabularyEntry<C>
}

/** A slice of the map, for files that hold a family of caps. */
export type CapVocabularySlice<K extends VocabCapName> = {
  readonly [C in K]: CapVocabularyEntry<C>
}

// ── The loose (string-keyed) view, for the resolver and the guard ──────

/** A dynamic offer with no cap-specific key type. */
export type LooseDynamicOffer =
  | {
      readonly kind: 'dynamic'
      readonly from: 'status'
      readonly field: string
      readonly valueKey?: string
      readonly labelKey?: string
      readonly where?: {
        readonly key: string
        readonly equals: string | number | boolean
      }
      readonly valueKind?: 'string' | 'number'
    }
  | {
      readonly kind: 'dynamic'
      readonly from: 'method'
      readonly method: string
      readonly valueKey?: string
      readonly labelKey?: string
      readonly where?: {
        readonly key: string
        readonly equals: string | number | boolean
      }
      readonly valueKind?: 'string' | 'number'
    }

/** An offer as a consumer reads it. */
export type LooseVocabOffer = EnumOffer | NumberOffer | TextOffer | BooleanOffer | LooseDynamicOffer

/** An open arg as a consumer reads it, with no cap-specific key type. */
export interface LooseVocabOpenArg {
  readonly key: string
  readonly label: L10n
  readonly offer: LooseVocabOffer
  readonly optional?: boolean
}

/** An action as a consumer reads it. */
export interface LooseVocabAction {
  readonly id: string
  readonly method: string
  readonly label: L10n
  readonly phrase: L10n
  readonly icon: VocabIcon
  readonly args?: Readonly<Record<string, unknown>>
  readonly openArgs?: readonly LooseVocabOpenArg[]
}

/** A boolean state trigger, string-keyed. */
export interface LooseBooleanStateTrigger {
  readonly kind: 'boolean'
  readonly field: string
  readonly label: L10n
  readonly whenTrue: L10n
  readonly whenFalse: L10n
  readonly icon: VocabIcon
}

/** A numeric state trigger, string-keyed. */
export interface LooseNumericStateTrigger {
  readonly kind: 'numeric'
  readonly field: string
  readonly quantity: L10n
  readonly label: L10n
  readonly unit?: string
  readonly unitField?: string
  readonly icon: VocabIcon
}

/** An enum state trigger, string-keyed. */
export interface LooseEnumStateTrigger {
  readonly kind: 'enum'
  readonly field: string
  readonly label: L10n
  readonly values: readonly EnumStateValue[]
  readonly icon: VocabIcon
}

/** A free-value state trigger, string-keyed. */
export interface LooseValueStateTrigger {
  readonly kind: 'value'
  readonly field: string
  readonly label: L10n
  readonly offer?: LooseDynamicOffer
  readonly phrase?: L10n
  readonly icon: VocabIcon
}

/** A state trigger as a consumer reads it. */
export type LooseVocabStateTrigger =
  | LooseBooleanStateTrigger
  | LooseNumericStateTrigger
  | LooseEnumStateTrigger
  | LooseValueStateTrigger

/** Wording overrides as a consumer reads them. */
export interface LooseVocabWording {
  readonly actions?: Readonly<Record<string, VocabActionWording>>
  readonly state?: Readonly<Record<string, VocabStateWording | undefined>>
}

/** Overrides as a consumer reads them. */
export interface LooseVocabOverrides {
  readonly byType?: Readonly<Record<string, LooseVocabWording | undefined>>
  readonly byRole?: Readonly<Record<string, LooseVocabWording | undefined>>
}

/** Any entry of the map, string-keyed. */
export interface LooseCapVocabularyEntry {
  readonly scope: 'device' | 'system'
  readonly noun?: L10n
  readonly actions?: readonly LooseVocabAction[]
  readonly notOperatorFacing?: string | Readonly<Record<string, string | undefined>>
  readonly state?: readonly LooseVocabStateTrigger[]
  readonly events?: Readonly<Record<string, VocabEventTrigger | VocabEventExcused>>
  readonly extraEvents?: readonly VocabEventTrigger[]
  readonly overrides?: LooseVocabOverrides
}
