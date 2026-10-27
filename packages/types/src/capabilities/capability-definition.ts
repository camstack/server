/**
 * Generic types for capability definitions.
 *
 * A capability is defined with Zod schemas for methods, events, and settings.
 * TypeScript types are inferred via z.infer<> — zero duplication.
 *
 * Pattern:
 *   1. Define Zod schemas for data, methods, settings
 *   2. Export const capabilityDef = { ... } satisfies CapabilityDefinition
 *   3. Export type IProvider = InferProvider<typeof capabilityDef>
 *   4. Addon implements IProvider
 *   5. Registry auto-mounts tRPC router from definition.methods
 */

import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import type { ConfigUISchemaWithValues } from '../interfaces/config-ui.js'
import type { ExtensionSlotDescriptor } from '../device-extension/slot-descriptor.js'
import type { MethodRoleDecl } from '../auth/viewer-access.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'

// ── Method & Event Schemas ───────────────────────────────────────────

/**
 * tRPC procedure kind.
 * - 'query': read-only, no side effects
 * - 'mutation': write operation, side effects
 * - 'subscription': push-based real-time stream via WebSocket
 */
export type CapabilityMethodKind = 'query' | 'mutation' | 'subscription'

/**
 * Auth level required to call a capability method.
 * `superAdmin` was removed — every destructive op is gated by `admin`
 * (the unscoped role) which the middleware lets through unconditionally.
 */
export type CapabilityMethodAuth = 'public' | 'protected' | 'admin'

/**
 * Server-injected caller identity for methods declared with
 * `caller: 'required'` (D-1, notification-center P0).
 *
 * The hub cap-router builder derives this from the AUTHENTICATED tRPC
 * session (`ctx.user`) and injects it into the input object handed to
 * the provider — it is NOT part of the wire Zod schema, and any
 * client-supplied `caller` field is discarded before injection, so the
 * value is spoof-proof by construction. `isAdmin` is the single source
 * of authority for caps (the v2 role collapse).
 */
export interface CapCaller {
  readonly userId: string
  readonly isAdmin: boolean
}

/**
 * Caller-identity requirement for a capability method.
 * `'required'` — the router injects {@link CapCaller} from the
 * authenticated session and FAILS the call (UNAUTHORIZED) when no
 * authenticated user is on the context. Only valid on query/mutation
 * methods with an OBJECT input schema (the injected field needs an
 * object to live on); the runtime builder rejects other shapes at
 * router-build time.
 */
export type CapabilityMethodCaller = 'required'

/**
 * Optional semantic role used by the admin UI's unified "Integrations"
 * page to group caps by what kind of external system they integrate
 * with. Caps without `providerKind` are infra-internal (decoders,
 * device providers, pipeline steps, …) and never surface there.
 *
 *   - `broker`         — message brokers (MQTT, future Kafka)
 *   - `device-export`  — outbound exporters (HomeKit, Alexa, HA-MQTT)
 *   - `email`          — email delivery relays (SMTP, Gmail API, …)
 *   - `calendar`       — calendar sources (Google Calendar, waste, HA, …)
 *   - `mesh`           — mesh-VPN providers (Tailscale, Headscale, …)
 *   - `ingress`        — public-ingress tunnels (Cloudflare Tunnel, …)
 */
export type ProviderKind =
  | 'broker'
  | 'device-export'
  | 'email'
  | 'calendar'
  | 'mesh'
  | 'ingress'
  | 'ai'

/**
 * Access flavour for a capability method. Drives the scope-access check
 * in `protectedProcedure`. Default inferred at codegen time:
 *   - `kind: 'query'`    → `view`
 *   - `kind: 'mutation'` → `create`
 *   - name match `^(delete|remove|revoke|destroy|drop|purge|clear|reset|forget)` → `delete`
 * An explicit `access` on the method options overrides the heuristic.
 */
export type CapabilityMethodAccess = 'view' | 'create' | 'delete'

/** Schema pair for a single capability method: input + output + routing metadata. */
export interface CapabilityMethodSchema<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
  TKind extends CapabilityMethodKind = CapabilityMethodKind,
> {
  readonly input: TInput
  readonly output: TOutput
  /** tRPC procedure kind. Default: 'query'. */
  readonly kind: TKind
  /**
   * Auth level. OPTIONAL and left unset by `method()` when the caller
   * doesn't pass one — the DEFAULT is resolved later, per-cap, by
   * {@link resolveMethodAuth} (`cap-router-predicates.ts`), never baked in
   * here. That deferral is load-bearing: `resolveMethodAuth` floors an
   * un-set `auth` to `'admin'` on an `internal: true` cap and to
   * `'protected'` otherwise (Task 7.5c). Baking a `'protected'` default in
   * at THIS layer would erase the "did the author actually decide this"
   * bit before it ever reached that floor — which is exactly how 45
   * procedures across 13 internal caps (including
   * `ssoBridge.signBridgeToken`, a caller-suppliable-`isAdmin` privilege
   * escalation) ended up reachable by any authenticated session. An
   * EXPLICIT `auth` here — of any value — always wins over the floor.
   */
  readonly auth?: CapabilityMethodAuth
  /** Per-method access flavour. When unset, codegen derives it from `kind` + name heuristic. */
  readonly access?: CapabilityMethodAccess
  /**
   * What this method is for a VIEWER (D921): baseline `viewer`, `admin`, or a
   * named `{ feature }` an admin grants. Unset → the cap's `role`, else derived
   * from `auth` and the cap scope (`resolveMethodRole`).
   */
  readonly role?: MethodRoleDecl
  /** Moleculer action timeout override (ms). Overrides broker global requestTimeout for this action only. */
  readonly timeoutMs?: number
  /**
   * When true the method is served ONLY by the cap's system/wrapper provider —
   * it is required on `InferProvider` but OPTIONAL on `InferNativeProvider`, so
   * per-device driver natives (RtspCamera, OnvifCamera, …) don't stub out a
   * wrapper-only concern (e.g. a cross-device cache-overview batch). Same
   * rationale as the status-Partial on native providers.
   */
  readonly systemOnly?: boolean
  /**
   * When true the method is OPTIONAL on `InferProvider` — a source of a
   * COLLECTION cap may legitimately not serve it.
   *
   * Not the same thing as {@link systemOnly}, which is about the native/system
   * split of ONE addon. This is about peers: a `mode:'collection'` cap's
   * providers are sources listed beside each other, none privileged, and they
   * do genuinely different things. `videoclips.readClipBytes` is the case —
   * the recorder's `analytics` source is a time WINDOW over footage with no
   * file behind it at all, so demanding the method of it buys a throwing stub,
   * and a throwing stub reads exactly like a method somebody forgot.
   *
   * The RUNTIME already treated absence as a named case: `callSource`
   * (`device-collection-dispatch.ts`) answers a missing method with
   * `NOT_IMPLEMENTED` naming the cap, the source and the method, and
   * `isCollectionArrayMethod` lets a missing ARRAY method contribute `[]`
   * rather than emptying the fan-out. This flag stops the TYPE from demanding
   * what the framework never needed.
   *
   * Use it only where a source's ABSENCE of the method is a fact about that
   * source, never to soften a method somebody has not got round to writing.
   */
  readonly providerOptional?: boolean
  /**
   * Opt-in caller-identity injection (D-1). When `'required'`, the hub
   * cap-router injects a server-derived {@link CapCaller} into the input
   * object handed to the provider (never trusted from the client) and
   * fails the call with UNAUTHORIZED when the context carries no
   * authenticated user. `InferProvider` / `InferNativeProvider` type the
   * provider's input as `Input & { caller: CapCaller }` for such methods.
   * Declare via `method(in, out, { caller: 'required', ... })` so the
   * static type carries the literal (a plain optional field on a
   * `method()` call without the option would inject at runtime but leave
   * the provider input untyped).
   */
  readonly caller?: CapabilityMethodCaller
}

export const CapabilityEventFromStateSchema = z.object({
  field: z.string().min(1),
  on: z.literal('advance'),
})
export type CapabilityEventFromState = z.infer<typeof CapabilityEventFromStateSchema>

/** Schema for a capability event (emitted to EventBus). */
export interface CapabilityEventSchema<TData extends z.ZodType = z.ZodType> {
  readonly data: TData
  /** A strict numeric state advance derives this one-shot event (D670). */
  readonly fromState?: CapabilityEventFromState
}

// ── Status (live readable machine-state per device) ─────────────────
//
// A cap can declare a `status` block describing the MACHINE-READABLE
// snapshot of the device's current state for this capability (battery
// percentage, PTZ position, intercom talking flag, …). When present,
// the provider interface gains `getStatus({ deviceId })` auto-injected
// via `InferProvider`. Distinct from `getDeviceSettingsContribution`
// which is the UI-schema for human-editable settings.

export type CapabilityStatusKind = 'push' | 'poll' | 'command-driven'

/**
 * ⚠ NO LIVE CALLER since 2026-08-08 — see the note on
 * {@link CapabilityStatusSchema.empty}. Kept as the shape a future wiring
 * mechanism would need, not as something that runs today.
 *
 * Declares that a cap's status is an ITEM-ARRAY wiring target: the status
 * holds an array of keyed items (`consumables.items`) that device-links can
 * populate per item via `DeviceLink.target.itemKey`. Links sharing an
 * `itemKey` are grouped into ONE item: the merge seeds a new item from
 * `emptyItem` (with `keyField` — and `labelField` when declared — set to the
 * itemKey), overlays each link's per-item `fieldPath`, validates the item
 * against `itemSchema`, then upserts it into the array by `keyField`.
 */
export interface CapabilityStatusItemArray {
  /** Dot-path from the status root to the array field (e.g. 'items'). */
  readonly path: string
  /** Item field carrying the stable per-item key (e.g. 'key'). */
  readonly keyField: string
  /** Optional item field defaulted to the itemKey when a NEW item is seeded
   *  and no link overlays it (e.g. 'label' — schemas often require it
   *  non-empty). Existing items keep their value. */
  readonly labelField?: string
  /** Zod schema of ONE array item — the per-item validation gate (a bad
   *  item is skipped without discarding the other items). */
  readonly itemSchema: z.ZodType
  /** Seed for a NEW item created from links; `keyField`/`labelField` are
   *  overwritten with the itemKey, links overlay the rest. Must produce an
   *  `itemSchema`-valid item once seeded. */
  readonly emptyItem: Readonly<Record<string, unknown>>
}

export interface CapabilityStatusSchema<TStatus extends z.ZodType = z.ZodType> {
  readonly schema: TStatus
  /** Documentation hint on update cadence — used by the aggregator and UI. */
  readonly kind?: CapabilityStatusKind
  /**
   * Default status used as the merge BASE when a device-link *synthesizes*
   * this cap (no native provider). Required-but-unlinked fields (enums,
   * timestamps) come from here so the synthesized status validates against
   * `schema`. Omit for caps that are never synthesize targets.
   *
   * ⚠ NO LIVE CALLER since 2026-08-08. The device-link mechanism this seeds was
   * deleted that day — 302 devices, 0 links, a month after it shipped — and the
   * only code that still reads this field is the `includeSynthesizable` branch
   * of `getWireableFields`, which nothing passes `true` to. Four caps declare
   * it (`battery`, `consumables`, `network-link`, `recording-signal`).
   *
   * KEPT, not deleted, and deliberately: the operator has a live request that
   * needs exactly this shape (a Dreame's HA sensors presenting as
   * `consumables`/`battery` on the robot) and has queued the wiring design for
   * discussion. This marker exists so the field is not mistaken for working
   * machinery in the meantime — which is the one thing a leftover must never
   * be allowed to be.
   */
  readonly empty?: z.infer<TStatus>
  /**
   * Item-array wiring descriptor — set when the status holds an array of
   * keyed items that device-links populate per item (`itemKey` grouping).
   * See {@link CapabilityStatusItemArray}. Omit for scalar-only caps.
   */
  readonly itemArray?: CapabilityStatusItemArray
}

// ── Declarative UI contribution descriptor ──────────────────────────
//
// A pure-data descriptor for a Module-Federation-hosted UI surface. The
// widget descriptor (`addon-widgets-source`) builds on this shape — the
// React component is resolved via the ui-library registry at runtime,
// so the descriptor stays free of any React coupling.

/** How a contribution's component is resolved by the renderer. */
export type UiContributionKind = 'remote'

/** One declarative UI piece — a Module-Federation widget. Pure data: no React. */
export interface UiContribution {
  /** Top-level host tab id. */
  readonly tab: string
  /** Optional sub-tab within `tab`. */
  readonly subTab?: string
  /** Human-readable tab/section label. */
  readonly label: string
  /** Ordering within (tab, subTab), ascending. Default 100. */
  readonly order?: number
  /** Always `'remote'` — the component is a Module Federation remote. */
  readonly kind: UiContributionKind
  /** The Module Federation remote descriptor. */
  readonly remote?: UiContributionRemote
}

/**
 * Module Federation remote descriptor for a `kind:'remote'`
 * {@link UiContribution}.
 *
 * `exposedModule` names the module the remote exposes (widget remotes
 * always expose `'./widgets'`). Widget remotes export that module as a
 * `Record<componentKey, Component>` map rather than a single default
 * component, so `componentKey` selects which entry to mount. When
 * `componentKey` is omitted the loader uses the module's `default`
 * export directly (single-component remotes).
 */
export interface UiContributionRemote {
  /** MF remote name — matches the `name` in the addon's `federation()` config. */
  readonly remoteName: string
  /** Exposed module path inside the remote (e.g. `'./widgets'`). */
  readonly exposedModule: string
  /** Key inside the exposed module's default-record map (the widget `stableId`). */
  readonly componentKey?: string
}

// ── Declarative settings bindings ───────────────────────────────────
//
// A cap's `settings.bindings` spec lets the device-manager auto-derive
// both `getDeviceSettingsContribution` (UI schema with live values) and
// `applyDeviceSettingsPatch` (patch → cap method dispatch) without the
// provider implementing a single line of FormBuilder code. The provider
// only implements the imperative cap methods; the framework wires up
// the admin-UI form from these bindings.

/** Supported field kinds in settings bindings. Deliberately limited — mirror FormBuilder primitives. */
export type CapSettingsFieldKind = 'boolean' | 'text' | 'number' | 'select'

/** Scalar (single value) binding — target a single scalar path inside `status`. */
export interface CapSettingsScalarBinding {
  readonly kind: 'scalar'
  /** Dot-path into `status` where the current value lives. */
  readonly statusPath: string
  /** Cap method invoked when the field changes. Must exist in `methods`. */
  readonly method: string
  /** Name of the method's input arg that receives the new value. */
  readonly valueArg: string
  readonly field: {
    readonly label: string
    readonly kind: CapSettingsFieldKind
    readonly options?: readonly string[]
  }
  /** Optional section override (default: capability name). */
  readonly sectionId?: string
  readonly sectionTitle?: string
}

/** Array binding — target an array path in `status`, render one row per item. */
export interface CapSettingsArrayBinding {
  readonly kind: 'array'
  /** Dot-path into `status` pointing at an array. */
  readonly statusPath: string
  /** Field on each array item used as stable id (e.g. 'id'). */
  readonly idField: string
  /** Cap method invoked on any per-item field change. */
  readonly method: string
  /** Method input arg that receives the item id (e.g. 'overlayId'). */
  readonly idArg: string
  /** Method input arg that receives the patch object. */
  readonly patchArg: string
  readonly sectionId: string
  readonly sectionTitle: string
  readonly itemFields: Readonly<Record<string, CapSettingsItemField>>
}

export interface CapSettingsItemField {
  /** Static string or per-item resolver (runs server-side at contribution time). */
  readonly label: string | ((item: Record<string, unknown>) => string)
  readonly kind: CapSettingsFieldKind
  /** Select options — static array or per-item resolver. */
  readonly options?: readonly string[] | ((item: Record<string, unknown>) => readonly string[])
  /** Visibility predicate — hide the field for items returning false. */
  readonly when?: (item: Record<string, unknown>) => boolean
}

export type CapSettingsBinding = CapSettingsScalarBinding | CapSettingsArrayBinding

export interface CapabilitySettingsSpec {
  readonly bindings: readonly CapSettingsBinding[]
}

// ── Device-config archetype (D14) ───────────────────────────────────
//
// The camera-config caps (stream-params, motion-zones, ptz, …) share an
// archetype: scope:'device', native, multi-vendor, status + runtimeState
// + a `getOptions` availability descriptor + `set*` mutations. The
// device-detail UI for such a cap is FULLY DERIVABLE from what the cap
// declares — the framework derives the aggregate contribution and the
// save routing, so no per-vendor contribution code is written.

/**
 * `deviceConfig.ui` selects how the framework derives the device-detail
 * UI section for the cap:
 *
 *   - `kind: 'derived-form'` — the section is a generated form. The
 *     framework calls the cap's `getOptions` + `getStatus`, runs the
 *     declared pure `buildSchema` reducer, and routes the flat form
 *     patch back through the declared `applyPatch` reducer + `set*`
 *     method. Used by `stream-params`.
 *   - `kind: 'widget'` — the section is a single `type:'widget'`
 *     ConfigField embedding a live React component (resolved host-side
 *     by `widgetId`). The widget self-persists via the cap's own
 *     mutations; the framework emits only the structural section.
 *     Used by `motion-zones`, `ptz`, `ptz-autotrack`.
 */
export interface DeviceConfigDerivedFormUi {
  readonly kind: 'derived-form'
  /** Identifier of the registered pure derivation (see device-config-contribution.ts). */
  readonly builderId: string
  /** Tab id the generated section is placed under. */
  readonly tab: string
}
export interface DeviceConfigWidgetUi {
  readonly kind: 'widget'
  /** Host widget id resolved by the admin-ui WidgetSlot. */
  readonly widgetId: string
  /** Tab id; with `topTab:true` the section is hoisted to its own device tab. */
  readonly tab: string
  readonly topTab?: boolean
  /**
   * Where the section lands on the device page. `'tab'` (default) follows
   * `tab` / `topTab`; `'hero'` shows it ONCE directly under the device's
   * hero card, in the same block, on every tab of the device page, for every
   * device bound to the cap (D915). A hero section never also appears in a
   * tab.
   */
  readonly placement?: 'tab' | 'hero'
  /** Section title + field label shown in the UI. */
  readonly label: string
  /** Section ordering within the tab. Default 0. */
  readonly order?: number
}
export type DeviceConfigUiSpec = DeviceConfigDerivedFormUi | DeviceConfigWidgetUi

/**
 * Marks a cap as a `deviceConfig` archetype. Presence of this block
 * tells the device-manager aggregator the cap's contribution is
 * framework-derived — the provider implements only the imperative cap
 * methods (`getOptions`, `getStatus`, `set*`), never the three
 * `DeviceSettingsContribution` methods.
 */
export interface DeviceConfigSpec {
  readonly ui: DeviceConfigUiSpec
}

// ── Runtime-state durability (D4) ────────────────────────────────────

/**
 * Does this cap's runtime-state slice survive a restart?
 *
 *   - `'session'` — mirrored in RAM, NEVER written to disk. Correct when the
 *     value is re-published on its own within a poll or a frame, and a restored
 *     one would be a lie the UI renders as current: a 1 Hz `avgDbfs`, a
 *     `zone-analytics` frame counter, a `camera-streams.slotStatuses` saying
 *     `streaming` for a camera that has been dark for two hours. These two hot
 *     caps alone are ~90 % of the fleet's runtime-state write rate (measured:
 *     1.0–1.6 M writes/day offered, of which `audio-metrics` + `zone-analytics`
 *     are 3,897 of 5,765 sampled changes) and their restored value is worth
 *     nothing.
 *
 *   - `'restored'` — persisted, and seeded back into the mirror at boot. Pick
 *     it when EITHER nothing else holds the value (`native-object-detection
 *     .enabled` on a camera whose refresh is a no-op; `doorbell
 *     .pressCountSinceStart`), OR the restored value is what turns the first
 *     real observation after a restart into a COMPARISON instead of a phantom
 *     transition (`device-status.online` — D130's rule stated in runtime-state
 *     vocabulary). A restored value is not a claim about now; it is the
 *     previous observation.
 *
 * The default is `'session'`, and the guard makes it explicit anyway: a value
 * reaches disk only because its own capability asked for it.
 */
export type RuntimeStateDurability = 'session' | 'restored'

/** The default applied to a `runtimeState` cap that declares no `durability`. */
export const DEFAULT_RUNTIME_STATE_DURABILITY: RuntimeStateDurability = 'session'

// ── Runtime-state history (D850) ─────────────────────────────────────

/**
 * Unit of a recorded history series. A closed set: the History tab formats by
 * it. The symbol is the quantity's stored base (D944), including `µg/m³` and
 * `m/s`. A per-device quantity (`numeric-sensor`) has no fixed unit.
 */
export type HistoryUnit =
  | '%'
  | 'dBFS'
  | 'dBm'
  | '°C'
  | 'W'
  | 'kWh'
  | 'V'
  | 'A'
  | 'VA'
  | 'lx'
  | 'ppm'
  | 'ppb'
  | 'µg/m³'
  | 'hPa'
  | 'count'
  | 'ratio'
  | 'ms'
  | 's'
  | 'days'
  | 'bytes'
  | 'kbps'
  | 'fps'
  | 'm/s'

/** Display label per {@link HistoryUnit}. */
export const HISTORY_UNIT_LABELS: Readonly<Record<HistoryUnit, string>> = {
  '%': '%',
  dBFS: 'dBFS',
  dBm: 'dBm',
  '°C': '°C',
  W: 'W',
  kWh: 'kWh',
  V: 'V',
  A: 'A',
  VA: 'VA',
  lx: 'lx',
  ppm: 'ppm',
  ppb: 'ppb',
  'µg/m³': 'µg/m³',
  hPa: 'hPa',
  count: 'count',
  ratio: 'ratio',
  ms: 'ms',
  s: 's',
  days: 'days',
  bytes: 'bytes',
  kbps: 'kbps',
  fps: 'fps',
  'm/s': 'm/s',
}

/** One `runtimeState` field recorded as a history series. */
export interface CapabilityHistoryField {
  /**
   * `gauge` — a level, averaged in a rollup. `counter` — a MONOTONIC hardware
   * meter only (`energy`); a drop is a reset, never a negative reading. A
   * counter that restarts with the addon (`pressCountSinceStart`) is not one.
   * `boolean` — stored 0/1; a rollup gives the fraction of time true.
   * `enum` — a STATE (a `z.enum`, or a `z.string` whose values are learned):
   * stored as the ordinal of its value in the series' append-only value list,
   * change-only; a rollup keeps the time spent in each state.
   */
  readonly kind: 'gauge' | 'counter' | 'boolean' | 'enum'
  /**
   * `enum` over a `z.enum` field: its values, in declaration order. WRITTEN BY
   * CODEGEN from the field's schema (`scripts/generate-history-catalog.ts`) —
   * never by hand, so the list cannot drift from the schema. Absent for a
   * `z.string` enum field, whose values are learned as they are first seen.
   * Ordinals are append-only in the store: reordering the `z.enum` later never
   * changes what a stored ordinal means.
   */
  readonly values?: readonly string[]
  /**
   * Path of a SIBLING field: while it is set (not `undefined`, not `null`), the
   * slice is not a reading of this field and nothing is captured. An
   * `enum-sensor` with a `format` carries a timestamp, not a state.
   */
  readonly skipWhenSet?: string
  /** Fixed unit of the series. Mutually exclusive with {@link unitFrom}. */
  readonly unit?: HistoryUnit
  /**
   * Path of a SIBLING `runtimeState` field (a string or enum) that carries this
   * device's quantity. A series stores the quantity base, so `unit` is that
   * symbol (`°C`, `hPa`, `m/s`). `unitFrom` is not allowed. The
   * catalog records the path; the reader resolves it per device. Mutually
   * exclusive with {@link unit}.
   */
  readonly unitFrom?: string
  readonly displayName?: string
  /** Drop a change smaller than this (ABSOLUTE) — anti-jitter for noisy gauges. */
  readonly deadband?: number
  /**
   * Drop a change smaller than this percentage of the last recorded value
   * (RELATIVE) — for a wide-range gauge such as illuminance. Applied together with
   * {@link deadband} when both are set: a change must clear both.
   */
  readonly deadbandPct?: number
  /**
   * At most one raw point per this many ms per series. Absent means the capture
   * floor of the kind: 10 000 for `gauge` and `counter`, none for `boolean` and `enum`
   * (change-only). Set it ABOVE the floor to be sparser; the floor is not
   * lowered by a smaller value except `0`, which a field may state to opt out
   * of the floor (a flapping state that must not lose an edge).
   */
  readonly minIntervalMs?: number
  /**
   * Device types for which this field is NOT captured. `motion.detected` is a
   * series for a PIR sensor and not for a camera, whose motion is already an
   * addon series and a ledger.
   */
  readonly excludeDeviceTypes?: readonly DeviceType[]
}

/**
 * Series recorded from a KEYED ARRAY of `runtimeState` (D917): one series per
 * (item field, item key). The item key is the series SCOPE — the same
 * dimension a producer's per-zone or per-location series uses — so the store,
 * rollups, retention and queries need nothing new. The series key is
 * `cap:<capName>.<path>[].<field>` ({@link historyItemFieldPath}).
 *
 * An item that appears later gets its series on its first reading; an item
 * that disappears keeps its history until retention ages it out. The display
 * name of an item's series is read at query time from the item's `label`
 * field in the device's current slice (the key when the item is gone).
 */
export interface CapabilityHistoryItems {
  /** Path of the array: a top-level or fixed-object (`a.b`) `runtimeState` path. */
  readonly path: string
  /** Field of an item that identifies it across readings: a non-empty string. */
  readonly key: string
  /** Field of an item that names it for display (a string). */
  readonly label?: string
  /**
   * ITEM-relative paths (top-level or fixed-object `a.b`) to a series spec.
   * `unitFrom` and `skipWhenSet` are item-relative as well.
   */
  readonly fields: Readonly<Record<string, CapabilityHistoryField>>
}

/** The catalog field path of an item field: `<itemsPath>[].<field>` (`items[].level`). */
export function historyItemFieldPath(itemsPath: string, field: string): string {
  return `${itemsPath}[].${field}`
}

/**
 * The `history` block of a cap with `runtimeState`: `'none'` is an explicit
 * answer; otherwise `fields` maps TOP-LEVEL or fixed-object (`a.b`) paths of
 * `runtimeState` to a series. A path never goes into an array or a record keyed
 * by runtime ids — a keyed array is declared through `items`
 * ({@link CapabilityHistoryItems}), whose item key becomes the series scope.
 * `fields` may be empty only when `items` is declared. Enforced by
 * `scripts/check-cap-history-declared.ts`.
 */
export type CapabilityHistory =
  | 'none'
  | {
      readonly fields: Readonly<Record<string, CapabilityHistoryField>>
      readonly items?: CapabilityHistoryItems
    }

/** Capture floor (ms) applied to `gauge` / `counter` series when a field states none. */
export const HISTORY_DEFAULT_MIN_INTERVAL_MS = 10_000

// ── Composed-provider method answers (D663) ──────────────────────────

/**
 * How a COMPOSED provider answers a method it cannot forward yet (D663). A
 * composition that ADDS a cap to a device serves this cap's methods from here
 * until `forward` arrives (slice 3). A cap with a served method that is NOT
 * listed stays uncomposable (`has-commands`). Only an answer the cap's own
 * contract already defines as "not available" belongs here.
 */
export type ComposedMethodAnswer =
  | { readonly kind: 'refuse'; readonly reason: string }
  | { readonly kind: 'answer'; readonly value: unknown }
  /** Read one field of the composed slice. Unknown is a throw, never false (D393). */
  | { readonly kind: 'slice'; readonly field: string }

// ── Capability Definition ────────────────────────────────────────────

/**
 * Full definition of a capability — the single source of truth for the
 * functional contract (methods + events).
 *
 * Settings are NOT part of the capability definition — they belong to
 * the addon implementation. Each addon defines its own settings schema
 * via ICamstackAddon.getConfigSchema(), stored per-addon with optional
 * per-device overrides.
 */
export interface CapabilityDefinition<
  TName extends string = string,
  TMethods extends Record<string, CapabilityMethodSchema> = Record<string, CapabilityMethodSchema>,
  TEvents extends Record<string, CapabilityEventSchema> | undefined =
    | Record<string, CapabilityEventSchema>
    | undefined,
> {
  /** Unique capability name (kebab-case) */
  readonly name: TName
  /** system = global singleton/collection. device = per-device resolution. */
  readonly scope: 'system' | 'device'
  /**
   * Cardinality of active providers:
   *   - `singleton` — exactly one active provider cluster-wide
   *     (e.g. admin-ui, device-manager). User config can pick which addon
   *     is active when multiple are registered.
   *   - `collection` — every registered provider stays active
   *     (e.g. decoder, notification-output).
   *   - `per-node` — one active provider per node/agent. Every node that
   *     hosts an addon for this cap runs its own independent provider;
   *     consumers query `getProviderForNode(capName, nodeId)` instead of
   *     `getSingleton(capName)`. Used for node-local probes
   *     (platform-probe, metrics-provider, hwaccel-probe).
   */
  readonly mode: 'singleton' | 'collection' | 'per-node'
  /**
   * Provider registration kind — the single source of truth for whether
   * this capability's providers register as wrappers.
   *
   *   - `'native'` / omitted — a plain provider; no wrapper registration.
   *   - `'wrapper'` — the hub calls `registerWrapper(capName, addonId,
   *     {defaultActive})` so the cap appears in
   *     `device-manager.getBindings` / `listBindableCapsForDeviceType`
   *     and can be auto-bound to devices.
   *
   * D4 (base-layer rework): moved here from the addon `package.json`
   * manifest and the runtime `ProviderRegistration`. The manifest now
   * declares only WHICH caps an addon provides. `ProviderRegistration
   * .kind` survives only as a deprecated, cross-checked hint.
   */
  readonly kind?: 'native' | 'wrapper'
  /**
   * Wrapper-only — when `true`, the wrapper is auto-bound for every
   * compatible device (claims the binding ahead of native providers).
   * Ignored unless `kind === 'wrapper'`. Default: `false`.
   */
  readonly defaultActive?: boolean
  /** True when this cap is registered PER-DEVICE via `ctx.registerNativeCap`
   *  (the provider IS the device), so the tRPC layer must resolve it with
   *  `requireDeviceScoped` → `getNativeProvider(capName, deviceId)`. Distinct
   *  from `scope:'device'` SYSTEM caps (zones/recording/motion/events) whose
   *  single provider dispatches on deviceId internally. Default: undefined/false. */
  readonly deviceNative?: boolean
  /**
   * How a COMPOSED provider answers a method it cannot forward yet (D663). A
   * composition that ADDS a cap to a device serves this cap's methods from
   * here until `forward` arrives (slice 3). A cap with a served method that
   * is NOT listed stays uncomposable (`has-commands`). Only an answer the
   * cap's own contract already defines as "not available" belongs here.
   */
  readonly composedMethods?: Readonly<Record<string, ComposedMethodAnswer>>
  /** Method definitions: name → { input, output } Zod schemas */
  readonly methods: TMethods
  /** Event definitions: name → { data } Zod schema (optional) */
  readonly events?: TEvents
  /**
   * Typed machine-readable status snapshot. When present, the provider
   * interface gains `getStatus({ deviceId })` auto-injected via
   * `InferProvider`. Consumers poll via this method or subscribe via
   * `device-manager.subscribeDeviceStatusAggregate`. Distinct from
   * `getDeviceSettingsContribution` — that serves the UI editable-form
   * schema; `status` is the live readable state.
   */
  readonly status?: CapabilityStatusSchema

  /**
   * Per-device runtime-state slice owned by THIS cap. Persisted across
   * restarts under `device.state[capName]`. Every provider that
   * implements the cap inherits the same shape — drivers don't
   * redeclare it, they just write through `this.runtimeState
   * .setCapState('<capName>', value)`. Examples:
   *
   *   - `batteryCapability.runtimeState`: `{ level, charging,
   *     sleeping, lastUpdated }`. A Reolink Argus, a sensor proxy,
   *     an ONVIF battery cam — every provider stores the
   *     same shape under `state.battery`.
   *   - `ptzCapability.runtimeState`: `{ pan, tilt, zoom }`.
   *
   * Caps without runtime state (pure-RPC like `reboot`) leave this
   * undefined; setCapState refuses to write to those slices.
   */
  readonly runtimeState?: import('zod').ZodObject<import('zod').core.$ZodLooseShape>

  /**
   * Whether this cap's runtime-state slice SURVIVES A RESTART. Mandatory for
   * every cap declaring `runtimeState` — `scripts/check-runtime-state-
   * durability.ts` fails the build otherwise, so the choice is made in the diff
   * rather than inherited by accident.
   *
   * See {@link RuntimeStateDurability} for what each value costs and buys.
   * Behavioural cap metadata lives ONLY here (D4): the kernel has no whitelist
   * to disagree with.
   */
  readonly durability?: RuntimeStateDurability

  /**
   * Fields of `runtimeState` that are CLOCKS, not content — `lastFetchedAt`,
   * `lastUpdated`, `ts`. They are persisted like any other field; they are
   * simply excluded from the equality test that decides whether persisting is
   * worth a SQLite commit.
   *
   * The cap names them because the cap knows which of its fields carry meaning.
   * Measured on the live hub over 25 minutes: `battery` wrote its blob **526
   * times while not one percentage moved** — every one of those writes was
   * `lastUpdated` advancing. `privacy-mask` 22 of 22, `humidity-sensor` 67 of
   * 75, `numeric-sensor` 251 of 669. Roughly half of all non-hot runtime-state
   * writes on this installation are a device recording that it re-read a value
   * that had not changed.
   *
   * Only meaningful on `durability: 'restored'` caps (a `'session'` slice never
   * reaches disk, so nothing compares it). `SliceThrottler` already plays this
   * trick with `ts` for the two hot caps; this is the same idea, declared.
   */
  readonly volatileStateFields?: readonly string[]

  /**
   * Which `runtimeState` fields are recorded as long-term history series
   * (D850), or `'none'`. Mandatory for every cap declaring `runtimeState` —
   * `scripts/check-cap-history-declared.ts` fails the build otherwise. See
   * {@link CapabilityHistory}; `npm run codegen` projects it into
   * `generated/history-catalog.ts`.
   */
  readonly history?: CapabilityHistory
  /**
   * Generic Customize override (D936). When present, admin-ui offers the
   * declared targets instead of a cap-specific card. Codegen projects it
   * into `generated/customize-catalog.ts`. `scripts/check-customize-declaration.ts`
   * rejects a path, type or vocabulary the cap does not have.
   */
  readonly customize?: CapabilityCustomizeSpec
  /**
   * Declarative settings spec. When present, the device-manager's
   * settings aggregator auto-derives the ConfigUISchema and routes
   * patches back to the referenced imperative methods. The provider
   * implements ONLY the imperative methods — no manual FormBuilder
   * contribution code. Colocated with the cap for single-source-of-
   * truth ergonomics.
   */
  readonly settings?: CapabilitySettingsSpec
  /**
   * D14 device-config archetype. Mutually exclusive with
   * `exposesDeviceSettings` — a cap declares one or the other. When set,
   * the framework derives the device-detail contribution + save routing;
   * vendor providers carry NO contribution methods.
   */
  readonly deviceConfig?: DeviceConfigSpec
  /** For `scope: 'device'` caps — allowed device types. Omit → applies to every type. */
  readonly deviceTypes?: readonly DeviceType[]
  /**
   * Extension slots this capability OWNS (D648): the ways a device of this
   * kind can be extended by other devices, served by this cap's owner over
   * the store it already has. Folded by `npm run codegen` into
   * `generated/extension-slots.ts` and listed by `device-extension`.
   * Behavioural metadata, so it lives here and only here (D4).
   */
  readonly extensionSlots?: readonly ExtensionSlotDescriptor[]
  /**
   * When `true`, every provider of this capability MUST implement the
   * device-settings contribution surface — three extra methods appearing
   * automatically on the provider interface via `InferProvider`:
   *
   *   - `getDeviceSettingsContribution({ deviceId })` → schema + values
   *     for the device-details page (cached, slow cadence). Returns null
   *     when the provider has nothing to contribute for the given device.
   *   - `getDeviceLiveContribution({ deviceId })` → readonly live data
   *     (status, counters). Returns null when not applicable. Polled ~2-3s.
   *   - `applyDeviceSettingsPatch({ deviceId, patch })` → single-entry
   *     mutation for field values returned by `getDeviceSettingsContribution`.
   *     The provider owns the storage.
   *
   * The naming is intentionally distinct from the three-level addon API
   * (`getGlobalSettings` / `getDeviceSettings` / `getAddonSettings`) to
   * avoid collisions when an addon implements both surfaces on the same
   * class. The words "Contribution" and "Patch" signal these are aggregator
   * hooks, not persistent settings accessors.
   *
   * The `device-manager` aggregator enumerates bindings for the target
   * device, picks providers whose cap has this flag, and concatenates
   * the per-provider contributions into the single aggregate consumed
   * by `deviceManager.getDeviceSettingsAggregate`.
   */
  readonly exposesDeviceSettings?: boolean

  /**
   * Server-internal cap — registered for in-process consumption only.
   * NOT exposed via the SDK `System` proxy and NOT exposed via the
   * generated React hooks. Use this for collection caps whose
   * contributions are aggregated by another singleton cap (for example
   * `addon-pages-source` walked by the `addon-pages` aggregator) or for
   * declarative slots (`addon-routes`, `admin-ui`, `log-destination`,
   * `restreamer`, `streaming-engine`, `webrtc`) consumed by hub
   * builtins/addons via `capabilities.getCollection()` /
   * `getSingleton()`.
   *
   * Behaviour:
   *   - cap-router codegen still emits a `createCapRouter_<Cap>` so the
   *     router stays available for opt-in mounting (e.g. test harnesses);
   *     `trpc.router.ts` simply does not reference it.
   *   - system-proxy codegen skips it — `system.<cap>` is not minted.
   *   - system-hooks codegen skips it — no `use<Cap><Method>` exports.
   *   - The cap is still consumable internally via
   *     `ctx.capabilities.getCollection()` / `getSingleton()` from
   *     inside an addon.
   *
   * Default: `false` (cap is publicly mounted and exposed on the SDK
   * surface).
   */
  readonly internal?: boolean
  /**
   * Default viewer label for every method of this cap (D921); a method's own
   * `role` wins. Used when a whole cap is one named feature (`faceGallery`).
   */
  readonly role?: MethodRoleDecl

  /**
   * Optional semantic role used by the admin UI's unified
   * "Integrations" page to group caps by what kind of external system
   * they integrate with. Omit for caps that are infra-internal
   * (decoders, providers, pipeline steps, …).
   *
   * See `ProviderKind` for the closed set of recognised values.
   */
  readonly providerKind?: ProviderKind

  /**
   * How the generated tRPC cap-router treats an input field named
   * `nodeId`:
   *
   *   - `'routing'` (default): extract `nodeId` from the input and
   *     route to that node via `createRemoteProxy`. Use when the cap
   *     has a provider registered on every target node.
   *
   *   - `'data'`: forward `nodeId` untouched to the local provider
   *     as part of the method's input. Use when the cap has a
   *     hub-centric provider that dispatches internally
   *     (`broker.call('<addonId>.settings.<method>', ..., {nodeID})`).
   *     `addon-settings` is the canonical example — one singleton on
   *     the hub resolves `addonId` → worker nodeId by consulting the
   *     cluster roster.
   */
  readonly nodeIdMode?: 'routing' | 'data'

  /**
   * For `mode: 'singleton'` caps with multiple possible provider addons —
   * the addon id that should be the DEFAULT active provider when no operator
   * preference (`setActiveSingleton`) is set. Makes active-provider selection
   * deterministic instead of registration-order-dependent. Ignored when an
   * operator preference exists (operator choice always wins) and for
   * non-singleton caps.
   */
  readonly preferredProvider?: string

  /**
   * Declarative mount hint read by the runtime cap-router builder
   * (`@camstack/system` `buildCapRouters`). It encodes HOW the hub
   * resolves the provider object the cap's tRPC router calls — the same
   * decision that the codegen `generate-cap-mounts.ts` baked into
   * `generated-cap-mounts.ts` at build time, lifted onto the cap def so a
   * cap change ships via the framework plugin (`@camstack/types` +
   * `@camstack/system`) without a `@camstack/server` rebuild (BIG PLAN 2).
   *
   * When omitted, the builder derives the mount from the cap's
   * `scope` / `mode` / `deviceNative` exactly as the codegen did
   * (see {@link resolveCapMount}):
   *   - `deviceNative: true`     → `{ kind: 'device-native' }`
   *   - `mode: 'collection'`     → `{ kind: 'collection' }` (array-output
   *                                 methods auto-detected → concat fan-out)
   *   - otherwise (singleton / per-node) → `{ kind: 'singleton' }`
   *
   * Set it EXPLICITLY only for caps whose resolution is NOT derivable from
   * scope/mode — the handful that today live as hand-written overrides in
   * `trpc.router.ts`:
   *   - `{ kind: 'server-provided' }` — the builder mounts the route
   *     generically (from the cap def's live method schemas) but does NOT
   *     resolve the provider; the server supplies a provider factory by cap
   *     name to `buildCapRouters` via its `serverProviders` map. The factory
   *     may compose backend services (`system`, `nodes`, `integrations`,
   *     `addons`, `network-quality`, `toast`) and/or transform a registry
   *     provider (`webrtc-session` wraps the broker to inject the request
   *     User-Agent). Keeps backend composition out of `@camstack/system`
   *     (the self-sufficiency invariant) while the schema stays def-driven.
   *   - `{ kind: 'hub-only' }` — single-node cap; the remote-proxy leg is
   *     short-circuited to `null` (agents are not addressable). Used by
   *     `local-network`.
   *   - `{ kind: 'skip' }` — never mounted (legacy provider shapes that
   *     predate the `InferProvider` contract — `addon-routes`,
   *     `auth-provider`, `log-destination`, `restreamer`,
   *     `streaming-engine`, `webrtc`). Mirrors the old `LEGACY_SHAPE_SKIP`
   *     set.
   */
  readonly mount?: CapabilityMountHint
}

/**
 * Mount-resolution kinds for {@link CapabilityDefinition.mount}. See the
 * field doc for when to use each. `singleton` / `collection` /
 * `device-native` are the auto-derivable defaults; the rest are explicit
 * opt-ins for caps that today need a hand-written override.
 */
export type CapabilityMountKind =
  | 'singleton'
  | 'collection'
  | 'device-native'
  /**
   * `scope: 'device'` + `kind: 'wrapper'` — ONE active provider PER DEVICE,
   * substitutable through `deviceManager.setWrapperActive`. NOT
   * `device-native`: there is no native provider (the provider is an addon,
   * not the device), so resolution goes through the D13 resolver
   * `CapabilityRegistry.getProviderForDevice(cap, deviceId)`, which falls back
   * to the global active singleton for a device with no binding.
   *
   * Only a method that NAMES a device can be dispatched per device — the
   * per-device dispatcher demands a numeric `deviceId` on every call. A method
   * whose input carries no required numeric `deviceId` (a batch over
   * `deviceIds`, a fleet-wide count, a job id) resolves through the cap's
   * SYSTEM provider instead, exactly as `systemOnly` does; the builder makes
   * that call per method (`cap-router-builder.ts`).
   */
  | 'device-scoped'
  | 'server-provided'
  | 'hub-only'
  | 'skip'
  /**
   * @deprecated Legacy alias for `server-provided` (renamed in SP1). Retained
   * ONLY so the runtime tolerates version skew across the framework-live-update
   * boundary — an old `@camstack/types` build (shipped via framework-swap onto a
   * newer server image, or vice versa) still emits `service-backed`. No cap def
   * should use it; the server switch treats it identically to `server-provided`.
   */
  | 'service-backed'

export interface CapabilityMountHint {
  readonly kind: CapabilityMountKind
}

/**
 * Resolve the EFFECTIVE mount hint for a cap — the explicit `mount` when
 * present, else the scope/mode/deviceNative-derived default. Single source
 * of truth shared by the runtime builder and any codegen that needs the
 * same classification, so the two can never disagree.
 */
export function resolveCapMount(def: CapabilityDefinition): CapabilityMountHint {
  if (def.mount) return def.mount
  if (def.deviceNative === true) return { kind: 'device-native' }
  // A device-scoped WRAPPER is one provider SET per device. Deriving
  // `singleton` here is what made `setWrapperActive` a knob that wrote a store
  // nobody read (D62 shape) — the binding persisted and the router served the
  // global provider anyway. Derived, never a per-cap `mount:` hint: a hint on
  // one cap would leave every other device-scoped wrapper broken, and the next
  // one broken by default.
  //
  // Checked BEFORE `mode: 'collection'`, and that order is the decision
  // (D554): a device-scoped wrapper that holds SEVERAL providers per device
  // (`videoclips`, D549 decision 2) is still resolved per DEVICE — the
  // cardinality says how many sources a camera has, never that the cap left
  // the per-device mount. The global `collection` mount fans every registered
  // provider for every caller and never reads a per-device filter; deriving it
  // here would have put `videoclips` straight back into the defect D552
  // closed, on the commit that made it a collection.
  if (def.scope === 'device' && def.kind === 'wrapper') return { kind: 'device-scoped' }
  if (def.mode === 'collection') return { kind: 'collection' }
  return { kind: 'singleton' }
}

/**
 * The input field that NAMES one provider of a collection cap — ONE spelling,
 * because three separate layers dispatch such a call and each one of them has
 * to agree about what a pin looks like:
 *
 *   1. the hub's tRPC mount            (`device-collection-dispatch.ts`)
 *   2. the Moleculer transport link    (`@camstack/system` trpc-links.ts)
 *   3. the parent's UDS route          (`cap-router-runtime.ts`)
 *
 * Each of the three has, at some point, answered a pinned call from the wrong
 * provider — and each was fixed on its own, in its own spelling, which is why
 * the bug kept coming back wearing a different addon's name. A pin that only
 * one layer honours is a pin that is honoured never (D552, D593, D594).
 */
export const PROVIDER_PIN_FIELD = 'provider'

/** Contract for the three methods added by `exposesDeviceSettings: true`. */
export interface DeviceSettingsContribution {
  readonly getDeviceSettingsContribution: (input: {
    readonly deviceId: number
  }) => Promise<ConfigUISchemaWithValues | null>
  readonly getDeviceLiveContribution: (input: {
    readonly deviceId: number
  }) => Promise<ConfigUISchemaWithValues | null>
  readonly applyDeviceSettingsPatch: (input: {
    readonly deviceId: number
    readonly patch: Record<string, unknown>
  }) => Promise<{ readonly success: true }>
}

// ── DeviceSettingsContribution Zod schemas ──────────────────────────
//
// Zod-level counterparts to the TS interface above. Exposed so every
// layer that walks a cap def's methods (Moleculer service factory,
// tRPC cap-router codegen, remote-provider proxy builder) can treat
// `exposesDeviceSettings: true` the same way it treats any other
// method — just auto-spread these three into the methods map. The
// interface stops being an implicit "invisible surface": every
// provider of an `exposesDeviceSettings` cap exposes these three
// actions as regular cap methods, reachable through Moleculer and
// tRPC like everything else. No hidden in-process-only shortcuts.

/**
 * Output schema shared by the contribution + live methods.
 *
 * Mirrors the `ConfigUISchemaWithValues` shape (sections[] + optional
 * tabs[]) without importing from `../interfaces/config-ui.js` — a
 * concrete-but-lenient Zod object keeps tRPC output inference happy
 * (using `z.unknown()` here collapses unrelated router branches to
 * `unknown` when the generator re-inlines the huge AppRouter type).
 *
 * `.passthrough()` on sections/fields accepts whatever FormBuilder
 * extensions the caller adds (showWhen, displayScale, …) without
 * rebuilding every time a new field kind is introduced.
 */
const ContributionSectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  style: z.enum(['card', 'accordion']).optional(),
  defaultCollapsed: z.boolean().optional(),
  columns: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  tab: z.string().optional(),
  // Hoist the section into a top-level device tab (DeviceDetail
  // discovers these and renders one tab per unique `tab` id). Default
  // 'settings' keeps the section under the Config tab.
  location: z.enum(['settings', 'top-tab', 'hero']).optional(),
  order: z.number().optional(),
  fields: z.array(z.any()),
})

const ContributionTabSchema = z.object({
  id: z.string(),
  label: z.string(),
  icon: z.string(),
  order: z.number().optional(),
})

const ContributionSchema = z.object({
  tabs: z.array(ContributionTabSchema).optional(),
  sections: z.array(ContributionSectionSchema),
})

const ContributionOutputSchema = ContributionSchema.nullable()

export const DEVICE_SETTINGS_CONTRIBUTION_METHODS = {
  getDeviceSettingsContribution: {
    input: z.object({ deviceId: z.number() }),
    output: ContributionOutputSchema,
    kind: 'query',
    auth: 'protected',
  },
  getDeviceLiveContribution: {
    input: z.object({ deviceId: z.number() }),
    output: ContributionOutputSchema,
    kind: 'query',
    auth: 'protected',
  },
  applyDeviceSettingsPatch: {
    input: z.object({ deviceId: z.number(), patch: z.record(z.string(), z.unknown()) }),
    output: z.object({ success: z.literal(true) }),
    kind: 'mutation',
    auth: 'admin',
  },
} as const satisfies Record<string, CapabilityMethodSchema>

/**
 * Schema for the `getStatus` method auto-injected when a cap declares
 * `status`. The runtime shape of the output is the cap's own
 * `status.schema` — but at codegen time we need a concrete Zod to emit
 * a typed tRPC route, so we keep the output as `z.unknown().nullable()`
 * here and tighten it on the client side via the generated
 * `CapStatusTypeMap` (see `scripts/generate-cap-status-types.ts`).
 */
export const DEVICE_STATUS_METHOD = {
  getStatus: {
    input: z.object({ deviceId: z.number() }),
    output: z.unknown().nullable(),
    kind: 'query',
    auth: 'protected',
  },
} as const satisfies Record<string, CapabilityMethodSchema>

/**
 * Expand a cap def's methods map with every auto-injected method:
 *   - `exposesDeviceSettings: true`      → 3 contribution methods
 *   - `status: {...}`                    → `getStatus`
 *
 * Callers walk `expandCapMethods(def)` instead of `def.methods` when
 * they need the effective runtime method surface (Moleculer actions,
 * proxy shape, tRPC router entries). The cap def stays the single
 * source of truth. Providers still declare their concrete `methods`
 * block; the expansion happens at every consumption point, so there's
 * no accidental divergence between the declared surface and what's
 * actually mounted.
 */
export function expandCapMethods(
  def: CapabilityDefinition,
): Record<string, CapabilityMethodSchema> {
  let out: Record<string, CapabilityMethodSchema> = def.methods
  if (def.exposesDeviceSettings) {
    out = { ...DEVICE_SETTINGS_CONTRIBUTION_METHODS, ...out }
  }
  if (def.status) {
    out = { ...DEVICE_STATUS_METHOD, ...out }
  }
  return out
}

// ── Type Inference Helpers ───────────────────────────────────────────

/**
 * Infer the provider interface from a capability definition.
 *
 * All query/mutation methods return Promise<T> — this ensures consumers
 * can transparently call local or Moleculer-remote providers.
 * Providers may still implement methods as sync (return T); the Moleculer
 * action handler and tRPC router await the result either way.
 */
/** Extract the status output type — or `never` when the cap has no status block. */
export type InferStatus<T extends CapabilityDefinition> = T extends {
  status: CapabilityStatusSchema<infer S>
}
  ? z.infer<S>
  : never

/** Contract for the `getStatus` method auto-injected when `status: {...}` is set. */
export interface DeviceStatusContribution<TStatus> {
  readonly getStatus: (input: { readonly deviceId: number }) => Promise<TStatus | null>
}

/**
 * Provider-side input for a method: the wire input, plus the
 * server-injected {@link CapCaller} when the method declares
 * `caller: 'required'`. The `caller` field is NOT part of the wire Zod
 * schema — the hub router injects it after validation, so only the
 * PROVIDER type carries it (clients never send it; if they do, the
 * router discards it).
 */
type ProviderMethodInput<M, TIn extends z.ZodType> = M extends { readonly caller: 'required' }
  ? z.infer<TIn> & { readonly caller: CapCaller }
  : z.infer<TIn>

/** One provider method's callable shape, subscription arm included. */
type ProviderMethodFn<M> =
  M extends CapabilityMethodSchema<infer TIn, infer TOut>
    ? M['kind'] extends 'subscription'
      ? (input: z.infer<TIn>, push: (value: z.infer<TOut>) => void) => (() => void) | void
      : (input: ProviderMethodInput<M, TIn>) => Promise<z.infer<TOut>>
    : never

export type InferProvider<T extends CapabilityDefinition> = {
  // Required: everything a provider of this cap must serve.
  readonly [K in keyof T['methods'] as T['methods'][K] extends { providerOptional: true }
    ? never
    : K]: ProviderMethodFn<T['methods'][K]>
} & {
  // Optional: methods a SOURCE may legitimately not have — see
  // `CapabilityMethodSchema.providerOptional`.
  readonly [K in keyof T['methods'] as T['methods'][K] extends { providerOptional: true }
    ? K
    : never]?: ProviderMethodFn<T['methods'][K]>
} & (T['exposesDeviceSettings'] extends true ? DeviceSettingsContribution : Record<never, never>) &
  (T extends { status: CapabilityStatusSchema }
    ? DeviceStatusContribution<InferStatus<T>>
    : Record<never, never>)

/**
 * Interface for native (per-device) providers — strips the
 * `DeviceSettingsContribution` surface that `exposesDeviceSettings: true`
 * bolts onto the system-level `InferProvider`.
 *
 * Native providers are registered via `DeviceContext.registerNativeCap`
 * and only serve the cap's device-scoped runtime methods for that single
 * device. They do NOT own per-device settings — those flow through the
 * addon's system-level provider's `applyDeviceSettingsPatch`, not
 * through the camera driver's native hook. Keeping the two surfaces
 * separate stops every device class (RtspCamera, OnvifCamera, …) from
 * having to stub out three unused methods.
 */
type NativeMethodFn<M> =
  M extends CapabilityMethodSchema<infer TIn, infer TOut>
    ? M['kind'] extends 'subscription'
      ? (input: z.infer<TIn>, push: (value: z.infer<TOut>) => void) => (() => void) | void
      : (input: ProviderMethodInput<M, TIn>) => Promise<z.infer<TOut>>
    : never

export type InferNativeProvider<T extends CapabilityDefinition> = {
  // Required: ordinary device-scoped methods every driver native serves.
  readonly [K in keyof T['methods'] as T['methods'][K] extends { systemOnly: true }
    ? never
    : K]: NativeMethodFn<T['methods'][K]>
} & {
  // Optional: `systemOnly` methods are served by the system/wrapper provider,
  // so a per-device native may omit them entirely.
  readonly [K in keyof T['methods'] as T['methods'][K] extends { systemOnly: true }
    ? K
    : never]?: NativeMethodFn<T['methods'][K]>
} & (T extends { status: CapabilityStatusSchema }
    ? // Optional on native providers: not every driver can report status
      // (e.g. snapshot providers that only expose the fetch call). When
      // present the server-side aggregator uses it; when absent the cap's
      // status entry is reported as `null` in `getDeviceStatusAggregate`.
      Partial<DeviceStatusContribution<InferStatus<T>>>
    : Record<never, never>)

/**
 * Infer event data types from a capability definition.
 * Returns a map of event name → data type.
 */
export type InferEvents<T extends CapabilityDefinition> =
  T['events'] extends Record<string, CapabilityEventSchema>
    ? {
        readonly [K in keyof T['events']]: T['events'][K] extends CapabilityEventSchema<infer TData>
          ? z.infer<TData>
          : never
      }
    : never

/**
 * Infer the device-proxy facade interface for a device-scoped capability.
 *
 * Strips `deviceId` from every method's input so consumers of the client-side
 * proxy (bound to a specific device) don't have to pass it. The proxy layer
 * injects `deviceId` before forwarding to the tRPC/Moleculer action.
 *
 * Query/Mutation methods always return Promise<T>. Subscription methods keep
 * the push-based shape, without `deviceId` in the input payload.
 */
export type InferDeviceProxyCap<T extends CapabilityDefinition> = {
  readonly [K in keyof T['methods']]: T['methods'][K] extends CapabilityMethodSchema<
    infer TIn,
    infer TOut
  >
    ? T['methods'][K]['kind'] extends 'subscription'
      ? (
          input: Omit<z.infer<TIn>, 'deviceId'>,
          push: (value: z.infer<TOut>) => void,
        ) => (() => void) | void
      : (input: Omit<z.infer<TIn>, 'deviceId'>) => Promise<z.infer<TOut>>
    : never
} & (T['status'] extends { schema: infer S }
  ? // Auto-injected `getStatus` mirrors the runtime emitted by the proxy
    // generator (see `scripts/generate-device-proxy.ts`). The schema is
    // tightened to the cap's status shape — `S` is the Zod schema, so
    // we resolve `z.infer<S>` here so consumers don't have to cast.
    {
      readonly getStatus: (input?: {
        deviceId?: number
      }) => Promise<S extends z.ZodType ? z.infer<S> | null : unknown>
    }
  : Record<never, never>) &
  // When `exposesDeviceSettings: true`, mirror the three contribution
  // methods that `expandCapMethods()` injects at runtime + the cap-router
  // codegen surfaces. Without these here, the device-proxy codegen
  // (which textually parses the cap and includes those methods in its
  // `Pick<>` over `InferDeviceProxyCap`) hits a constraint mismatch.
  (T['exposesDeviceSettings'] extends true
    ? {
        readonly getDeviceSettingsContribution: (input?: { deviceId?: number }) => Promise<unknown>
        readonly getDeviceLiveContribution: (input?: { deviceId?: number }) => Promise<unknown>
        readonly applyDeviceSettingsPatch: (input: {
          deviceId?: number
          patch: Record<string, unknown>
        }) => Promise<{ readonly success: true }>
      }
    : Record<never, never>)

/** Extract the capability name as a string literal type. */
export type InferName<T extends CapabilityDefinition> = T['name']

/**
 * Infer the runtime-state slice TS shape from a cap definition.
 *
 * Lives inside the types package on purpose: `z.infer<>` is resolved
 * against THIS package's Zod version (built with Zod 4), so consumers
 * that resolve a different Zod major (e.g. core resolving Zod 3 from
 * the workspace root) still see the correct concrete shape — they
 * never need to call `z.infer` themselves.
 *
 * Falls back to `unknown` for caps without `runtimeState:` so call sites
 * can't accidentally narrow to `never` and lose property-access type
 * checking.
 */
export type InferRuntimeState<T extends CapabilityDefinition> = T extends {
  readonly runtimeState: infer R
}
  ? R extends z.ZodType<infer Out>
    ? Out
    : R extends { readonly _output: infer Out }
      ? Out
      : unknown
  : unknown

// ── Helpers ─────────────────────────────────────────────────────────

/** Options for a capability method definition. */
export interface CapabilityMethodOptions<
  TKind extends CapabilityMethodKind = CapabilityMethodKind,
> {
  /** tRPC procedure kind. Default: 'query'. */
  readonly kind?: TKind
  /** Auth level. Default: 'protected'. */
  readonly auth?: CapabilityMethodAuth
  /** Per-method access flavour. When unset, codegen derives it from `kind` + name heuristic. */
  readonly access?: CapabilityMethodAccess
  /** What this method is for a viewer (D921). See {@link CapabilityMethodSchema.role}. */
  readonly role?: MethodRoleDecl
  /** Moleculer action timeout override (ms). Overrides broker global requestTimeout for this action only. */
  readonly timeoutMs?: number
  /**
   * Opt-in caller-identity injection (D-1). `'required'` ⇒ the router
   * injects a server-derived {@link CapCaller} into the provider input
   * and rejects unauthenticated calls. See
   * {@link CapabilityMethodSchema.caller}.
   */
  readonly caller?: CapabilityMethodCaller
}

/**
 * Shorthand to define a method schema.
 *
 * Overloaded so `{ caller: 'required' }` in the options is carried into
 * the RETURN TYPE as a literal (`& { readonly caller: 'required' }`) —
 * that literal is what `InferProvider` / `InferNativeProvider` key on to
 * add the injected `caller: CapCaller` field to the provider's input
 * type. Same pattern as `systemMethod()`'s `systemOnly: true` literal.
 */
export function method<
  TIn extends z.ZodType,
  TOut extends z.ZodType,
  TKind extends CapabilityMethodKind = 'query',
>(
  input: TIn,
  output: TOut,
  options: CapabilityMethodOptions<TKind> & { readonly caller: 'required' },
): CapabilityMethodSchema<TIn, TOut, TKind> & { readonly caller: 'required' }
export function method<
  TIn extends z.ZodType,
  TOut extends z.ZodType,
  TKind extends CapabilityMethodKind = 'query',
>(
  input: TIn,
  output: TOut,
  options?: CapabilityMethodOptions<TKind>,
): CapabilityMethodSchema<TIn, TOut, TKind>
export function method<
  TIn extends z.ZodType,
  TOut extends z.ZodType,
  TKind extends CapabilityMethodKind = 'query',
>(
  input: TIn,
  output: TOut,
  options?: CapabilityMethodOptions<TKind>,
): CapabilityMethodSchema<TIn, TOut, TKind> {
  return {
    input,
    output,
    kind: (options?.kind ?? 'query') as TKind,
    // Deliberately NOT defaulted here — see the doc comment on
    // `CapabilityMethodSchema.auth`. Leaving it unset when the caller
    // omits it preserves "was this explicit" all the way to
    // `resolveMethodAuth`, which is the only place the default is applied.
    ...(options?.auth !== undefined ? { auth: options.auth } : {}),
    ...(options?.access !== undefined ? { access: options.access } : {}),
    ...(options?.role !== undefined ? { role: options.role } : {}),
    ...(options?.caller !== undefined ? { caller: options.caller } : {}),
    timeoutMs: options?.timeoutMs,
  }
}

/**
 * A wrapper/system-only method: served exclusively by the cap's system-level
 * provider (`InferProvider`), and OPTIONAL on `InferNativeProvider` so per-device
 * driver natives don't stub out a wrapper concern (e.g. a cross-device cache
 * overview). The `systemOnly: true` literal is what `InferNativeProvider` keys on.
 */
export function systemMethod<
  TIn extends z.ZodType,
  TOut extends z.ZodType,
  TKind extends CapabilityMethodKind = 'query',
>(
  input: TIn,
  output: TOut,
  options?: CapabilityMethodOptions<TKind>,
): CapabilityMethodSchema<TIn, TOut, TKind> & { readonly systemOnly: true } {
  return { ...method(input, output, options), systemOnly: true }
}

/**
 * A method a SOURCE of a collection cap may legitimately not serve — OPTIONAL
 * on `InferProvider`. The `providerOptional: true` literal is what
 * `InferProvider` keys on; see {@link CapabilityMethodSchema.providerOptional}
 * for when this is the honest answer and when it is a soft stub.
 */
export function optionalMethod<
  TIn extends z.ZodType,
  TOut extends z.ZodType,
  TKind extends CapabilityMethodKind = 'query',
>(
  input: TIn,
  output: TOut,
  options?: CapabilityMethodOptions<TKind>,
): CapabilityMethodSchema<TIn, TOut, TKind> & { readonly providerOptional: true } {
  return { ...method(input, output, options), providerOptional: true }
}

/** Shorthand to define an event schema */
export function event<TData extends z.ZodType>(data: TData): CapabilityEventSchema<TData> {
  return { data }
}

/** Type guard: does this cap declare the D14 device-config archetype? */
export function isDeviceConfigCap(
  def: CapabilityDefinition | undefined,
): def is CapabilityDefinition & { deviceConfig: DeviceConfigSpec } {
  return def?.deviceConfig !== undefined
}
