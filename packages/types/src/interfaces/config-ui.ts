import { isKeychainStoredField } from './config-ui-secrets.js'
import { isSecretMarker, toSecretFieldView } from '../keychain/secret-marker.js'
import type {
  CustomModelMetadata,
  ModelCatalogEntry,
  ModelFormat,
  ModelOutputFormat,
} from '../types/models.js'

/**
 * Configuration UI Schema -- declarative form definition for any element.
 *
 * Used by addons to declare their settings UI. The admin UI collects schemas
 * from all active addons, merges tabs with the same ID, and renders responsive forms.
 *
 * Layout hierarchy: Tab → Section → Field
 * Multiple addons can contribute sections to the same tab.
 */

// --- Well-Known Tabs ─────────────────────────────────────────────────

/** Predefined tab identifiers that addons reference by ID. */
export type WellKnownTabId =
  | 'overview'
  | 'general'
  | 'image'
  | 'light'
  | 'motion'
  | 'audio'
  | 'snapshot'
  | 'osd'
  | 'alarms'
  | 'pipeline'
  | 'detection-pipeline'
  | 'stream-broker'
  | 'streaming'
  | 'ptz'
  | 'navigation'
  | 'consumables'
  | 'zones'
  | 'analytics'
  | 'live-stats'
  | 'recording'
  | 'notifications'
  | 'network'
  | 'storage'
  | 'engine'
  | 'scheduler'
  | 'decoder'
  | 'advanced'

export interface WellKnownTab {
  readonly id: WellKnownTabId
  readonly label: string
  readonly icon: string
  readonly order: number
}

/** Predefined tabs with standard label, icon, and sort order.
 *
 *  Pipeline (renamed Orchestrator in the UI) holds the four
 *  pipeline-orchestrator sections: General, Object Detection, Audio,
 *  and Cluster Assignment. Motion stays its own tab.
 *  `streaming` remains for older payloads that haven't been retagged. */
export const WELL_KNOWN_TABS: readonly WellKnownTab[] = [
  { id: 'overview', label: 'Overview', icon: 'layout-dashboard', order: -10 },
  { id: 'general', label: 'General', icon: 'settings', order: 0 },
  { id: 'image', label: 'Image', icon: 'image', order: 5 },
  { id: 'light', label: 'Light', icon: 'lightbulb', order: 7 },
  { id: 'motion', label: 'Motion', icon: 'activity', order: 10 },
  { id: 'audio', label: 'Audio', icon: 'mic', order: 12 },
  { id: 'alarms', label: 'Alarms', icon: 'bell-ring', order: 13 },
  { id: 'snapshot', label: 'Snapshot', icon: 'camera', order: 15 },
  { id: 'osd', label: 'OSD', icon: 'type', order: 18 },
  { id: 'stream-broker', label: 'Stream Broker', icon: 'radio', order: 20 },
  { id: 'streaming', label: 'Streaming', icon: 'video', order: 35 },
  { id: 'ptz', label: 'PTZ', icon: 'move', order: 40 },
  // The robot camera's drive panel (`navigation` cap). A top-tab whose id is
  // not well-known renders its RAW id: the device page showed "navigation".
  { id: 'navigation', label: 'Navigation', icon: 'compass', order: 41 },
  { id: 'consumables', label: 'Consumables', icon: 'recycle', order: 44 },
  { id: 'pipeline', label: 'Detection Pipeline', icon: 'cpu', order: 39 },
  {
    id: 'detection-pipeline',
    label: 'Detection pipeline',
    icon: 'cpu',
    order: 39,
  },
  { id: 'zones', label: 'Detection', icon: 'shapes', order: 38 },
  { id: 'analytics', label: 'Analytics', icon: 'activity', order: 37 },
  { id: 'live-stats', label: 'Live Stats', icon: 'activity', order: 39 },
  // The `videoclips` collection's browser is a SECTION of this tab, at the
  // end of it — not a tab of its own. It shipped as one and the operator
  // rejected the placement: the Recording tab already carries the recorder's
  // panel, the schedule bands and the unified retention policy, and footage
  // the camera holds is the same question asked of a different store (D557).
  { id: 'recording', label: 'Recording', icon: 'circle-dot', order: 40 },
  // Pipeline-page tabs — `engine` co-locates `detection-pipeline`'s
  // vision-engine section + `audio-analyzer`'s audio-engine section
  // (same modality of choice, different pipelines). `scheduler` and
  // `decoder` group the runner / decoder addon settings under their
  // own tabs so the pipeline page bar stays manageable.
  { id: 'engine', label: 'Inference Engine', icon: 'zap', order: 41 },
  { id: 'scheduler', label: 'Scheduler', icon: 'list-checks', order: 42 },
  { id: 'decoder', label: 'Decoder', icon: 'film', order: 43 },
  { id: 'notifications', label: 'Notifications', icon: 'bell', order: 50 },
  { id: 'network', label: 'Network', icon: 'globe', order: 60 },
  { id: 'storage', label: 'Storage', icon: 'hard-drive', order: 70 },
  { id: 'advanced', label: 'Advanced', icon: 'wrench', order: 100 },
] as const

/** Lookup map for well-known tabs by ID. */
export const WELL_KNOWN_TAB_MAP: Readonly<Record<WellKnownTabId, WellKnownTab>> =
  Object.fromEntries(WELL_KNOWN_TABS.map((t) => [t.id, t])) as Record<WellKnownTabId, WellKnownTab>

// --- Tab Declaration ─────────────────────────────────────────────────

/**
 * Custom tab declaration by an addon.
 * Use well-known tab IDs when possible. Custom tabs are for addon-specific UI.
 */
export interface ConfigTabDeclaration {
  /** Unique tab identifier. Use WellKnownTabId for standard tabs. */
  readonly id: string
  /** Display label (ignored for well-known tabs — their label is used). */
  readonly label: string
  /** Icon identifier (ignored for well-known tabs — their icon is used). */
  readonly icon: string
  /** Sort order within the tab bar. Lower = left. */
  readonly order?: number
}

// --- Schema Definition ───────────────────────────────────────────────

export interface ConfigUISchema {
  /**
   * Tabs contributed by this addon.
   * Multiple addons can reference the same tab ID — the UI merges them.
   * For well-known tabs, label/icon from WELL_KNOWN_TABS takes precedence.
   * Omit to use only well-known tabs referenced by sections.
   */
  readonly tabs?: readonly ConfigTabDeclaration[]
  readonly sections: readonly ConfigSection[]
}

export interface ConfigSection {
  readonly id: string
  readonly title: string
  /** `"<namespace>:<key>"` of the translated `title` (D863); `title` stays the English text. */
  readonly titleKey?: string
  readonly description?: string
  /** `"<namespace>:<key>"` of the translated `description` (D863). */
  readonly descriptionKey?: string
  readonly style?: 'card' | 'accordion'
  readonly defaultCollapsed?: boolean
  readonly columns?: 1 | 2 | 3 | 4
  /** Which tab this section belongs to. Default: 'general'. */
  readonly tab?: string
  /**
   * Where the section is rendered in the device page. Default
   * `'settings'` keeps the section under the device Settings panel
   * (existing behavior). `'top-tab'` hoists the section into a
   * top-level device tab (sibling of Live / Streams / Recordings /
   * Settings) keyed by the section's `tab` value. Multiple addons
   * targeting the same `(tab, location: 'top-tab')` pair render
   * inside the same top tab in `order` sequence — used for the
   * Zones tab where orchestrator (geometry CRUD) + motion-wasm
   * (motion rules) + detection-pipeline (detection rules) all
   * contribute to one operator surface. `'hero'` shows the section ONCE
   * directly under the device's hero card, outside every tab — the
   * Consumables section (D915).
   */
  readonly location?: 'settings' | 'top-tab' | 'hero'
  /** Sort order within the tab. Lower = top. */
  readonly order?: number
  /**
   * When true, every field in this section saves immediately on change
   * (no Save button needed). Per-field `immediate: false` overrides this.
   */
  readonly immediate?: boolean
  readonly fields: readonly ConfigField[]
}

// --- Field Types ---

export type ConfigField =
  | ConfigTextField
  | ConfigNumberField
  | ConfigBooleanField
  | ConfigSelectField
  | ConfigMultiSelectField
  | ConfigTimezoneField
  | ConfigDateTimeField
  | ConfigColorField
  | ConfigIconField
  | ConfigPasswordField
  | ConfigTextAreaField
  | ConfigSliderField
  | ConfigTagsField
  | ConfigScheduleField
  | ConfigGroupField
  | ConfigSubTabsField
  | ConfigSeparatorField
  | ConfigInfoField
  | ConfigQrCodeField
  | ConfigObjectArrayField
  | ConfigEditableArrayField
  | ConfigModelSelectorField
  | ConfigStorageLocationField
  | ConfigProbeField
  | ConfigButtonField
  | ConfigNodeSelectField
  | ConfigNodeMultiSelectField
  | ConfigDeviceSelectField
  | ConfigDeviceMultiSelectField
  | ConfigNotificationTargetSelectField
  | ConfigNotificationTargetMultiSelectField
  | ConfigWidgetField
  | ConfigAddonActionSelectField
  | ConfigAddonActionButtonField
  | ConfigDeviceActionButtonField
  | ConfigAccountSignInField
  | ConfigSecretPresenceField

/**
 * Per-MODEL applicability of a pipeline-step setting (D214).
 *
 * A step's config schema is static, but whether a knob has any effect depends
 * on WHICH model the step runs: an NMS IoU threshold means nothing to a model
 * whose export fuses NMS into the graph (YOLO-NAS, TFLite SSD), a
 * per-macro confidence slider is moot for a macro the model's labelmap cannot
 * produce, and a class allow-list must offer the MODEL's labels, not the
 * catalog's. Computed server-side (`buildSchemaSlots` → the step's model
 * union, static + custom registry) and consumed by the step editors, which
 * disable an inapplicable knob WITH its reason instead of rendering a control
 * that silently does nothing.
 *
 * COMPILE-TIME ONLY on the wire: `ConfigField` crosses the cap boundary via
 * `z.custom<ConfigField>()` (no stripping), so an addon compiled against this
 * field runs on hubs whose installed framework predates it — same pattern as
 * the `yolonas` `PostprocessorType` member (D208).
 */
export interface ConfigFieldModelApplicability {
  /**
   * modelId → operator-readable reason this knob has NO effect with that
   * model. The editor disables the control and shows the reason.
   */
  readonly inapplicable?: Readonly<Record<string, string>>
  /**
   * modelId → replacement options for select/multiselect fields whose offer
   * derives from the model's own labelmap (custom models: a class allow-list
   * must operate on THE MODEL's labels — options from another labelmap build
   * a filter that can never match).
   */
  readonly optionsByModel?: Readonly<Record<string, readonly ConfigOption[]>>
  /**
   * modelId → this field's DEFAULT when that model runs, for a field whose
   * default belongs to the model (D738: the per-class confidence floors).
   * Only models whose default differs from the field's own `default` are
   * listed; a model absent here runs at `default`.
   */
  readonly defaultByModel?: Readonly<Record<string, unknown>>
}

export interface ConfigFieldBase {
  readonly key: string
  readonly label: string
  /**
   * `"<namespace>:<key>"` of the translated `label` (D863). `label` stays the
   * mandatory English text: the hub substitutes the catalog text when the
   * request language has the key, and leaves `label` alone otherwise.
   */
  readonly labelKey?: string
  readonly description?: string
  /** `"<namespace>:<key>"` of the translated `description` (D863). */
  readonly descriptionKey?: string
  readonly required?: boolean
  readonly disabled?: boolean
  readonly placeholder?: string
  /** Default value used when the current value is undefined */
  readonly default?: unknown
  readonly span?: 1 | 2 | 3 | 4
  readonly showWhen?: ConfigCondition
  /**
   * The value is only for an in-form action (a sign-in). It is not written
   * into the integration settings.
   */
  readonly omitFromSettings?: boolean
  /**
   * The field's stored value is a CREDENTIAL and must never leave the process
   * on a read surface. Redaction machinery keys off
   * {@link isSecretConfigField}, which treats `type: 'password'` as implicitly
   * secret — this flag exists for the fields that carry a secret WITHOUT being
   * a password input.
   *
   * The concrete miss it was added for: the SFTP provider's `privateKey` is a
   * `textarea` (a PEM block does not fit a one-line password box) holding a
   * complete SSH private key. A redaction that trusted `type: 'password'`
   * alone would have shipped with that key still on the wire and an assurance
   * that credentials were redacted — worse than no redaction at all.
   *
   * Mark it on any field whose value would compromise something if read by a
   * non-admin session. It costs nothing when the field is already a password.
   */
  readonly secret?: boolean
  /**
   * Where a SECRET field's value is stored (D787). Default for every field
   * {@link isSecretConfigField} selects (`type: 'password'` or `secret: true`):
   * `'keychain'` — the settings blob holds a `{"$secret": ref}` marker and the
   * value lives in the encrypted keychain; the form sees "set / not set",
   * never the value. `'inline'` opts out, for a NON-secret value that is merely
   * drawn masked. Decided by the field's TYPE and this flag — never its name.
   */
  readonly storage?: 'keychain' | 'inline'
  /** Per-model knob applicability — see {@link ConfigFieldModelApplicability}. */
  readonly modelApplicability?: ConfigFieldModelApplicability
  /**
   * An operator value of this field is stored together with the model it was
   * made for (`<key>ModelId`) and applies only while that model runs; any
   * other model runs at its own default (D738). Read and written only through
   * `pipeline/model-bound-settings.ts`.
   */
  readonly bindsToModel?: boolean
  // Settings-redesign cleanup: `scope?: 'device' | 'global'` removed.
  // In the three-level model, a field's scope is determined by WHICH
  // schema it lives in — `getAddonSettings / getGlobalSettings /
  // getDeviceSettings` — not by a field-level marker. The keys are
  // disjoint across levels by invariant, so a scope marker is
  // redundant.
  /**
   * Save behavior when value changes.
   * - true: save immediately on change (toggles, selects, checkboxes)
   * - false (default): debounce 2 seconds for text/number inputs before saving
   *
   * The UI FormBuilder reads this flag and applies debounce accordingly.
   */
  readonly immediate?: boolean
  /**
   * Declares that changes to this field can only take effect after the
   * owning addon is (re)started — the field is bound at boot time and
   * cannot be hot-reloaded from `onConfigChanged()`. Example: Python
   * inference-pool `concurrency` (pool threads are allocated at pool
   * spawn). The UI surfaces a "Restart required" hint, and the
   * framework auto-restarts the addon after the update lands on a flag
   * transition — see `BaseAddon.updateGlobalSettings` /
   * `updateAddonSettings`.
   */
  readonly requiresRestart?: boolean
  /**
   * Per-node store scoping. `perNode: true` ⇒ the field's persisted store
   * key is physically `<key>@<nodeId>` — one value per cluster node — while
   * the SCHEMA field key stays bare (the UI form never sees the scoped key).
   * `BaseAddon.getGlobalSettings` / `updateGlobalSettings` / `resolveConfig`
   * scope reads and writes through `addon/per-node-store.ts`; a node with no
   * scoped key resolves to the field's schema `default` — NEVER another
   * node's value (deliberately NO bare-key fallback).
   *
   * Absent/false (default) ⇒ node-agnostic shared blob — a single value for
   * the whole cluster, today's behavior for the vast majority of fields.
   *
   * This is SCHEMA metadata (like `immediate` / `requiresRestart`), NOT
   * capability metadata: it lives on the field only — never in a `*.cap.ts`
   * definition or an addon manifest — so it is invisible to
   * `check-capability-metadata-drift.ts`.
   */
  readonly perNode?: boolean
  /**
   * Override the default placement of this field.
   * Moves it to a different tab and/or section than its parent section.
   * Useful for placing a single setting in a shared tab (e.g., 'advanced').
   */
  readonly placement?: {
    /** Target tab ID (well-known or custom). */
    readonly tab?: string
    /** Target section ID within the tab. Created if it doesn't exist. */
    readonly section?: string
  }
  /**
   * Device-aggregator metadata — only meaningful when this field is part of
   * a `ConfigUISchemaWithValues` merged by `deviceManager.getDeviceSettingsAggregate`
   * / `getDeviceLiveInfoAggregate`.
   *
   * - `readonlyField: true` — render as display-only, no mutation handler
   * - `source: 'live'`    — the value comes from the fast-poll live
   *                         aggregator; the UI re-queries it on its own
   *                         cadence and swaps the value in place. Default:
   *                         'settings' (slow, cached, invalidated on save)
   * - `writerCapName`     — when editable, the capability whose provider
   *                         accepts the mutation via
   *                         `deviceManager.updateDeviceField`.
   * - `writerAddonId`     — when editable, the addon id of the provider
   *                         for `writerCapName`. Ignored for
   *                         `readonlyField: true`.
   * - `minRole`           — minimum user role required to edit this
   *                         field. UI uses it to disable the input and
   *                         show a lock icon; the server still enforces
   *                         cap-level auth (`admin` for the aggregator
   *                         writers today). Default: 'admin'.
   *
   * The aggregator tags fields with `writerCapName` + `writerAddonId` before
   * returning them — providers produce clean schemas; provenance is injected
   * based on which (cap, provider) contributed the section.
   *
   * Named `readonlyField` instead of `readonly` to avoid colliding with the
   * TS modifier already implied by the interface fields.
   */
  readonly readonlyField?: boolean
  readonly source?: 'settings' | 'live'
  readonly writerCapName?: string
  readonly writerAddonId?: string
  readonly minRole?: 'viewer' | 'admin'
  /**
   * Optional inline action icons shown on the right of the field
   * control. Each action is a compact icon button that dispatches
   * through the same `onAction(action, key)` handler the button-field
   * type uses — keeps the action pipeline single-sourced. Common use:
   * readonly URL field with a "regenerate" icon, probe field with a
   * "copy" shortcut, etc.
   */
  readonly actions?: readonly FieldInlineAction[]
  /**
   * Declare this field as a *collection* of its underlying primitive.
   * When set, the stored value is an array (`T[]`) instead of a scalar
   * (`T`), and the form renderer shows:
   *   - `min` initial instances (empty slots if no value stored yet)
   *   - an `+ Add` button when the current count < `max`
   *   - a remove icon on each instance when the current count > `min`
   *   - an item counter badge (e.g. `2/3`) next to the section header
   *
   * Applies uniformly to every scalar-valued field type (text, number,
   * boolean, select, color, probe, password, textarea, slider, tags,
   * model-selector, storage-location). Structural fields (separator,
   * info, button) and group fields ignore this flag.
   *
   * Probe fields hit `testCreationField` / settings-contribution
   * probing per-index — the handler receives the full array and an
   * `index` hint so it can resolve just that slot.
   */
  readonly multiple?: ConfigFieldMultiple
}

/**
 * Array-widget metadata for a `ConfigFieldBase`. See `multiple` on
 * `ConfigFieldBase` for the activation semantics.
 */
export interface ConfigFieldMultiple {
  /** Minimum item count — always rendered, no remove button when count == min. */
  readonly min: number
  /** Maximum item count — Add button hidden when count == max. */
  readonly max: number
  /** Label for the "add" affordance. Default: "Add". */
  readonly addLabel?: string
  /** Template for each item's label (${n} = 1-based index). Default: none. */
  readonly itemLabel?: string
  /**
   * Default value each newly-added instance starts with. Falls back to
   * the field-level `default`, then to the empty string for string
   * fields or `null` for everything else.
   */
  readonly itemDefault?: unknown
}

/** Inline action icon attached to any ConfigField. */
export interface FieldInlineAction {
  /** Action identifier forwarded to the FormBuilder `onAction` handler. */
  readonly action: string
  /** Lucide icon name (e.g. 'refresh-cw', 'copy', 'external-link'). */
  readonly icon: string
  /** Tooltip shown on hover. */
  readonly tooltip: string
  /** Visual variant — `danger` flags destructive actions in red. */
  readonly variant?: 'default' | 'danger' | 'primary'
  /** Optional confirmation prompt before dispatching. */
  readonly confirmMessage?: string
}

export interface ConfigCondition {
  field: string
  equals?: unknown
  notEquals?: unknown
  in?: unknown[]
  notIn?: unknown[]
  /**
   * For `multiselect` / `tags` / array-valued fields: matches when the
   * referenced field's array value INCLUDES the given primitive. Example:
   * `{ field: 'motionSources', includes: 'analyzer' }` shows the
   * dependent field only when the analyzer source is selected.
   */
  includes?: unknown
  /** Inverse of `includes` — show when the field's array value does NOT
   *  contain the given primitive. */
  notIncludes?: unknown
}

export interface ConfigTextField extends ConfigFieldBase {
  type: 'text'
  maxLength?: number
  pattern?: string
  inputType?: 'text' | 'url' | 'email'
}

export interface ConfigNumberField extends ConfigFieldBase {
  type: 'number'
  min?: number
  max?: number
  step?: number
  unit?: string
}

export interface ConfigBooleanField extends ConfigFieldBase {
  type: 'boolean'
  style?: 'switch' | 'checkbox'
}

export interface ConfigSelectField extends ConfigFieldBase {
  type: 'select'
  options: readonly ConfigOption[]
  /**
   * Key of a sibling stored `string[]` catalog. Each entry becomes an
   * option `{ value, label }` at hydrate time (merged with `options`).
   * Same idea as tags `suggestionsFrom`, for a closed dropdown.
   */
  optionsFrom?: string
  dependsOn?: Record<string, unknown>
}

export interface ConfigMultiSelectField extends ConfigFieldBase {
  type: 'multiselect'
  options: readonly ConfigOption[]
  /**
   * Key of a sibling stored `string[]` catalog. Each entry becomes an
   * option `{ value, label }` at hydrate time (merged with `options`).
   * Same idea as tags `suggestionsFrom`, for a closed multi-picker.
   */
  optionsFrom?: string
  maxItems?: number
  /**
   * When true, the operator may commit values that are not in `options`.
   * Default false — closed catalogs stay closed.
   */
  creatable?: boolean
  /** Footer label for the “add value” action in the dropdown. Default “Add new…”. */
  createLabel?: string
}

/**
 * Friendly timezone picker. The stored value is an IANA timezone id
 * (e.g. 'Europe/Rome'); the renderer mounts the shared
 * `<TimezoneSelector>` from `@camstack/ui-library`, grouping the curated
 * `TIMEZONES` catalogue by region. DST is implied by the chosen zone —
 * there is no separate DST control. Consumers (device providers) resolve
 * the id via `findTimezone(id)` to obtain the standard offset + DST rule.
 */
export interface ConfigTimezoneField extends ConfigFieldBase {
  readonly type: 'timezone'
}

/**
 * Editable local date-time picker. The stored value is a string in the
 * native `datetime-local` shape `YYYY-MM-DDTHH:MM` (local wall-clock, no
 * seconds, no zone). The renderer mounts an `<input type="datetime-local">`
 * with the standard form-field chrome. Consumers that need a fully-zoned
 * timestamp append `:00` seconds + a zone designator on the save path.
 */
export interface ConfigDateTimeField extends ConfigFieldBase {
  readonly type: 'datetime'
}

export interface ConfigColorField extends ConfigFieldBase {
  type: 'color'
  presets?: string[]
}

/**
 * An icon chosen from the icon catalog (D780, D854) — `ICON_KEYS` in
 * `device/icon-catalog.ts`, the same keys the device and room pickers store.
 * The form renders the shared `<IconPicker>`; the stored value is a catalog
 * KEY, never a free-text lucide name. `default` must itself be a catalog key:
 * clearing the picker writes it back, and a stored value outside the catalog (a
 * pre-D780 free-text name) is drawn as the default — readers resolve it with
 * `resolveIconKey(value, default)`.
 *
 * COMPILE-TIME ONLY on the wire (`z.custom<ConfigField>()`): a form that
 * predates this type renders it through its default branch.
 */
export interface ConfigIconField extends ConfigFieldBase {
  readonly type: 'icon'
}

/** Select a single cluster node from the live topology. Options are
 * populated dynamically by the UI via useClusterNodes — no server-side
 * option list needed. */
export interface ConfigNodeSelectField extends ConfigFieldBase {
  type: 'node-select'
  /** When true, include offline nodes (greyed out). Default: false. */
  showOffline?: boolean
}

/** Select multiple cluster nodes from the live topology. */
export interface ConfigNodeMultiSelectField extends ConfigFieldBase {
  type: 'node-multiselect'
  showOffline?: boolean
  maxItems?: number
}

/**
 * Declarative, client-evaluated filter for `device-select` /
 * `device-multiselect`. The field carries ONLY this filter — the renderer
 * lists every system device (`deviceManager.listAll`) and narrows the
 * options CLIENT-SIDE. There is deliberately NO server-computed option
 * list (that path depended on `deviceManager.getAllBindings`, which returns
 * an empty set on the live cluster and left pickers blank).
 *
 * Match rule (union — a device is kept when ANY provided clause matches;
 * an absent/empty filter matches every device):
 *   - `caps`  → the device's advertised `features` intersect this list.
 *   - `types` → the device's `type` is one of these.
 * `excludeDeviceId` is always subtracted last (typically the device whose
 * settings host the field — e.g. a camera must not list itself as a source).
 */
export interface DeviceSelectFilter {
  /** Keep devices whose `features` intersect ANY of these capability names. */
  readonly caps?: readonly string[]
  /** Keep devices whose `type` is one of these `DeviceType` strings. */
  readonly types?: readonly string[]
  /** Always drop this device id from the options (e.g. the host device). */
  readonly excludeDeviceId?: number
  /** Always drop devices of these `DeviceType`s — a container is never a
   *  legitimate pick, its children are. Applied before every positive clause. */
  readonly excludeTypes?: readonly string[]
}

/**
 * Pick a SINGLE device from the live device catalogue. Options are the
 * result of `deviceManager.listAll` filtered client-side by `deviceFilter`.
 * Stored value is the chosen device id as a string.
 */
export interface ConfigDeviceSelectField extends ConfigFieldBase {
  type: 'device-select'
  deviceFilter?: DeviceSelectFilter
}

/**
 * Pick MULTIPLE devices from the live device catalogue — the searchable
 * sibling of `device-select` (same client-side `deviceFilter`). Stored
 * value is a `string[]` of device ids.
 */
export interface ConfigDeviceMultiSelectField extends ConfigFieldBase {
  type: 'device-multiselect'
  deviceFilter?: DeviceSelectFilter
  maxItems?: number
  /**
   * Devices sharing this location are listed FIRST, under a "Suggested"
   * heading, and the location / type facet chips are shown — the shape the
   * linked-devices picker needs (D356): a catalogue of hundreds narrowed by
   * where and what before the free-text search, and the room's own devices
   * offered without being linked on anybody's behalf. `null` = no suggestion.
   */
  suggestLocation?: string | null
}

/**
 * Pick a SINGLE `notification-output` target from the live catalog
 * (`listTargets`). Stored value is the target id string. Same control the
 * Notification Center editors use — scripts and addon settings must not
 * invent a parallel free-text "target id" field.
 */
export interface ConfigNotificationTargetSelectField extends ConfigFieldBase {
  type: 'notification-target-select'
}

/**
 * Pick MULTIPLE `notification-output` targets. Stored value is a `string[]`
 * of target ids.
 */
export interface ConfigNotificationTargetMultiSelectField extends ConfigFieldBase {
  type: 'notification-target-multiselect'
  maxItems?: number
}

export interface ConfigPasswordField extends ConfigFieldBase {
  type: 'password'
  showToggle?: boolean
}

export interface ConfigTextAreaField extends ConfigFieldBase {
  type: 'textarea'
  rows?: number
  maxLength?: number
  /**
   * When true, the stored value is a JSON-serializable object/array and
   * the UI shows it as pretty-printed JSON, with parse-on-save semantics.
   * `hydrateSchema` takes care of stringifying on the way out; the
   * FormBuilder is expected to parse before emitting the patch.
   *
   * Used by `zodEntriesToConfigUI` when the Zod schema is an
   * array/object — falls back gracefully when the FormBuilder hasn't
   * implemented parse-on-save yet (the field still renders the JSON
   * string instead of `[object Object],…`).
   */
  isJson?: boolean
}

export interface ConfigSliderField extends ConfigFieldBase {
  type: 'slider'
  min: number
  max: number
  step?: number
  showValue?: boolean
  unit?: string
  default?: number
  /** Display scale factor: displayed = stored / displayScale. E.g., displayScale=1000 shows ms as seconds. */
  displayScale?: number
  /** When true, allows a "not set" state where the value is null (e.g., "Auto" mode) */
  nullable?: boolean
  /** Label shown when the value is null (default: "Auto") */
  nullLabel?: string
  /**
   * When true, render +/− stepper buttons flanking the numeric input.
   * Each click increments/decrements by `step` (default 1) and clamps
   * to `[min, max]`. Pairs with `showValue` so the operator can fine-
   * tune from the keyboard / pointer without scrubbing the slider.
   */
  showStepper?: boolean
}

export interface ConfigTagsField extends ConfigFieldBase {
  type: 'tags'
  suggestions?: string[]
  /**
   * Key of a sibling stored value that holds a `string[]` of extra
   * suggestions (e.g. a scrape-filled `channelCatalog`). Merged into
   * `suggestions` at hydrate time so a form can offer a live catalog
   * without baking it into the static schema.
   */
  suggestionsFrom?: string
  maxTags?: number
  /**
   * When true (default for tags fields), the operator may add values outside
   * the suggestion catalog. Set false to restrict to known suggestions only.
   */
  creatable?: boolean
  /** Footer label for the “add value” action. Default “Add new…”. */
  createLabel?: string
}

/**
 * Weekly schedule — the same `NcSchedule` editor used by Notification Center.
 * Value shape is {@link NcSchedule} (or `undefined` = always / unset).
 *
 * Two authoring modes, one wire shape:
 *   - `windows` (default) — start→end bands ("active WHILE inside")
 *   - `times` — one HH:MM per row ("fire AT"), stored as one-minute windows
 *
 * The consumer decides what a window means at evaluation time.
 */
export interface ConfigScheduleField extends ConfigFieldBase {
  type: 'schedule'
  /**
   * `windows` — start→end activation bands (default).
   * `times` — punctual send/fire times (single clock per row).
   */
  mode?: 'windows' | 'times'
  /** Default windows when the store has no value yet. */
  default?: {
    readonly windows: readonly {
      readonly days: readonly number[]
      readonly startMinute: number
      readonly endMinute: number
    }[]
    readonly timezone?: string
    readonly invert?: boolean
  }
}

export interface ConfigGroupField extends ConfigFieldBase {
  type: 'group'
  fields: readonly ConfigField[]
  style?: 'card' | 'inline' | 'accordion'
  defaultCollapsed?: boolean
}

/** Visual separator between fields */
export interface ConfigSeparatorField {
  type: 'separator'
  key: string
}

// --- Sub-tabs Field ---
//
// Renders a nested tab strip inside a section. Each sub-tab carries its
// own list of `ConfigField`s. Values are flat across all sub-tabs (the
// outer save controller treats them like any other field key) — the
// sub-tabs are purely a layout primitive, not a save scope. Use when a
// section needs to host many fields that fall into clearly separable
// categories (e.g. one sub-tab per camera stream source).

/** A single sub-tab inside a `ConfigSubTabsField`. */
export interface ConfigSubTabDefinition {
  readonly id: string
  readonly label: string
  readonly icon?: string
  /** Short text shown next to the label (e.g. live status / counter). */
  readonly badge?: string
  readonly fields: readonly ConfigField[]
}

export interface ConfigSubTabsField extends ConfigFieldBase {
  type: 'sub-tabs'
  /** Tab definitions; rendered in array order. The first tab is active by default. */
  tabs: readonly ConfigSubTabDefinition[]
}

/**
 * Read-only QR code — renders an arbitrary string as a scannable QR
 * image via the shared `<QrCode>` component in `@camstack/ui-library`.
 *
 * Use for per-device pairing surfaces (HomeKit `X-HM://…` URI, OAuth
 * device-flow user code, etc.). When `value` is empty / absent the
 * renderer skips the field — addons that haven't materialised the
 * pairing payload yet (cold start, unpublished accessory) can return
 * the field unconditionally without rendering noise.
 */
export interface ConfigQrCodeField extends ConfigFieldBase {
  type: 'qr-code'
  /** The string encoded as the QR. Empty/absent → field renders nothing. */
  value?: string
  /** Optional caption shown above or beside the QR. */
  caption?: string
  /** Pixel size of the rendered QR (square). Default 192. */
  size?: number
  /** Alt text for accessibility. Defaults to the label. */
  alt?: string
}

/** Read-only informational text */
export interface ConfigInfoField {
  type: 'info'
  key: string
  label: string
  /** `"<namespace>:<key>"` of the translated `label` (D863). */
  labelKey?: string
  content: string
  variant?: 'info' | 'warning' | 'success' | 'danger'
  /**
   * Rendering mode for `content`. Default `'text'` keeps the legacy
   * "plain string with auto-newlines" behaviour. `'html'` interprets
   * `content` as inline HTML (sanitised in the renderer to a small
   * allowlist: a, ul, ol, li, strong, em, code, br) so addons can ship
   * clickable links and bulleted steps without inventing markdown.
   *
   * HTML mode is for addon-authored copy that lives in the bundle (no
   * user-supplied input flows here), so the surface stays narrow.
   */
  format?: 'text' | 'html'
  /** Same semantics as `ConfigFieldBase.showWhen` — lets info banners
   *  conditionally appear (e.g. "Cloudflare API token instructions"
   *  only when mode === 'custom'). */
  showWhen?: ConfigCondition
}

/**
 * Read-only structured table for diagnostic data. Renders as a row-per-
 * entry list with column headers. Use when a section needs to surface
 * multiple parallel records (live sessions, socket-pool entries, recent
 * doorbell presses, …) — replaces the older "joined-string in an info
 * field" pattern that lost structure on long entries.
 *
 * Columns describe how to render each cell. Each entry in `value` is a
 * record keyed by the column `key`. Missing keys render as em-dash.
 *
 * NOT editable — the FormBuilder ignores the field for save patches.
 */
export interface ConfigObjectArrayField {
  type: 'object-array'
  key: string
  label: string
  labelKey?: string
  description?: string
  descriptionKey?: string
  /**
   * Column definitions in render order. The `kind` hint controls cell
   * formatting:
   *   - `text` (default): plain string; null/undefined → em-dash
   *   - `monospace`: monospace font (good for IPs, sessionIds)
   *   - `status`: small colored dot + label, value should be one of
   *     'ok' | 'warn' | 'danger' | 'idle' | 'unknown'
   *   - `duration`: number of ms, formatted as "1m 23s"
   *   - `timestamp`: number (ms epoch), formatted as locale time
   */
  columns: ReadonlyArray<{
    readonly key: string
    readonly label: string
    /** `"<namespace>:<key>"` of the translated `label` (D863). */
    readonly labelKey?: string
    readonly kind?: 'text' | 'monospace' | 'status' | 'duration' | 'timestamp'
    /** Optional fixed width hint (CSS values: '120px', '20%', etc). */
    readonly width?: string
  }>
  /** Rows. Empty array renders `emptyMessage`. */
  value: ReadonlyArray<Record<string, unknown>>
  /** Shown when `value` is empty. Default: "No entries". */
  emptyMessage?: string
}

export interface ConfigOption {
  value: string
  label: string
  /** `"<namespace>:<key>"` of the translated `label` (D863). */
  labelKey?: string
  description?: string
  icon?: string
  /**
   * Event-taxonomy icon id (`audio-dog`, `person`, …). DATA, not a glyph: the
   * renderer resolves it — `resolveEventKindIcon` (lucide-react) on the web,
   * the viewer's own `lucide-react-native` map on native — so one option shape
   * draws correctly on both. Prefer this to baking a character into `label`:
   * the audio classifier used to ship `` `${emoji} ${name}` ``, which pinned
   * every UI to one glyph vocabulary the shared icon set did not use.
   */
  iconId?: string
}

// --- Editable Array Field ---

/**
 * Editable array of records. Each row exposes the fields declared in
 * `itemFields`; the form renderer reuses the standard scalar field
 * components (text / number / select / password / boolean) for each
 * cell. Add/Remove row buttons mutate `value` (the FormBuilder picks
 * up the new array via the standard onChange flow).
 *
 * Use for "configure N items" cases — e.g. a backup-sftp addon
 * exposing a list of remote destinations the operator can add or
 * remove. Don't use for fixed-cardinality data; a flat group of
 * fields reads better.
 *
 * Constraints inside `itemFields`:
 *   - Only scalar field types are supported (text/number/select/
 *     multiselect/password/boolean/textarea/color/icon/tags/slider). Nested
 *     groups, sub-tabs, probes, button actions, and other arrays are
 *     intentionally rejected — they conflate row-state with section-
 *     state and the FormBuilder's flat onChange contract can't carry
 *     the nesting cleanly. Build a custom-renderer if you need that.
 *   - Field `key`s are scoped to the row (no global collisions with
 *     the surrounding section).
 *   - `showWhen` inside a row references siblings within the same row.
 */
export interface ConfigEditableArrayField extends ConfigFieldBase {
  readonly type: 'editable-array'
  /** Per-row schema. Same shape as section.fields, scalar-only. */
  readonly itemFields: readonly ConfigField[]
  /** Default values used when the operator clicks "Add". */
  readonly defaultItem?: Record<string, unknown>
  /** Minimum number of rows allowed. Remove disabled below this count. */
  readonly minRows?: number
  /** Maximum number of rows allowed. Add disabled at this count. */
  readonly maxRows?: number
  /** Label for the "Add" button. Defaults to "Add". */
  readonly addLabel?: string
  /** Shown when the array is empty. Default: "No entries". */
  readonly emptyMessage?: string
  /**
   * Optional template for each row's title (e.g. "{displayName}" or
   * "{host}:{port}"). Resolved against the row's values; missing keys
   * collapse to an em-dash. Falls back to `Row N` when not provided.
   */
  readonly rowTitleTemplate?: string
  /**
   * The row field that IDENTIFIES a row (default `'id'`). A secret inside a row
   * is stored under a ref addressed by this id — never by index — so a reorder
   * keeps every ref, a removed row's refs are deleted, and a duplicated row's
   * secret is "not set" rather than copied (D787). A row saved without one has
   * an id minted for it.
   */
  readonly itemIdKey?: string
}

// --- Model Selector Field ---

export interface ConfigModelSelectorField extends ConfigFieldBase {
  type: 'model-selector'
  /** Filter models by type */
  modelType?: string
  /** Allow user to enter a custom local path or URL (default: true) */
  allowCustomPath?: boolean
  /** Allow file upload via UI (default: true) */
  allowUpload?: boolean
  /** Accepted file extensions for upload (default: ['.onnx']) */
  acceptExtensions?: string[]
  /** URL to model conversion documentation/guide */
  conversionGuideUrl?: string
  /** Brief text explaining what models are compatible */
  compatibilityNote?: string
  /** Legacy: inline catalog entries */
  catalog?: readonly ModelCatalogEntry[]
  allowCustom?: boolean
  acceptFormats?: readonly ModelFormat[]
  allowConversion?: boolean
  requiredMetadata?: readonly (keyof CustomModelMetadata)[]
  outputFormatHint?: ModelOutputFormat
}

// --- Probe Field ---

/** Result of probing a single field value (returned by IDeviceProvider.testField) */
export interface FieldProbeResult {
  status: 'ok' | 'error'
  /** Labels to display as chips (e.g. "1920×1080", "H.265", "25fps") */
  labels?: readonly string[]
  /** Error message when status is 'error' */
  error?: string
  /**
   * Optional values the provider suggests applying to other form fields
   * after a successful probe. The form-builder merges these into the
   * working snapshot ONLY for fields the operator hasn't filled yet,
   * never overwriting user input. Typical use: a host-probe that
   * autodetects the camera model and proposes it as the device `name`.
   */
  suggestedValues?: Readonly<Record<string, unknown>>
}

/**
 * A probeable input field. Renders as a text input with a test button.
 * The provider implements the actual probing logic via IDeviceProvider.testField.
 *
 * UX states:
 * - idle: muted icon, no labels
 * - probing: spinner icon
 * - ok: green check icon + provider-returned labels as chips
 * - error: red icon + error message
 */
export interface ConfigProbeField extends ConfigFieldBase {
  type: 'probe'
  /** Input type hint for the text input (default: 'url') */
  inputType?: 'url' | 'text'
}

// --- Storage Location Selector Field ---

import type { StorageLocationType } from './storage.js'

export interface ConfigStorageLocationField extends ConfigFieldBase {
  type: 'storage-location'
  /** Which location type this field selects a provider for */
  locationType: StorageLocationType
  /** Show available space indicator next to each provider option */
  showAvailableSpace?: boolean
}

export interface ConfigButtonField extends ConfigFieldBase {
  type: 'button'
  /** Button label text */
  buttonLabel: string
  /** Visual variant */
  variant?: 'default' | 'danger' | 'primary'
  /** tRPC action identifier — the form handler calls this action when pressed */
  action: string
  /** Confirmation prompt before executing (optional) */
  confirmMessage?: string
}

/**
 * Select whose options are pulled from a customAction on an addon at
 * render time. Generalises the "user pastes a token, server returns
 * the list of zones / buckets / dirs they can pick from" UX pattern
 * across every addon that integrates with an external API.
 *
 * Wiring at render time (admin-ui side):
 *   1. Collect `paramsFromForm` keys from the current form values.
 *   2. Merge with `paramsStatic`.
 *   3. Call `trpc.addons.custom({addonId, action, input}).query()`.
 *   4. Map each result item via `mapOption` → `{value, label, description?}`.
 *   5. If `refreshOn` is set, re-fetch when any listed form key changes.
 *
 * Example (cloudflare-tunnel zone picker):
 *   { type: 'addon-action-select',
 *     key: 'zoneId', label: 'Zone',
 *     addonId: 'cloudflare-tunnel',
 *     action: 'listZones',
 *     paramsFromForm: { token: 'apiToken' },
 *     refreshOn: ['apiToken'],
 *     mapOption: { value: 'id', label: 'name' } }
 */
export interface ConfigAddonActionSelectField extends ConfigFieldBase {
  type: 'addon-action-select'
  addonId: string
  action: string
  /** Map form-value keys → action input keys. */
  paramsFromForm?: Readonly<Record<string, string>>
  /** Static params merged into the action input. */
  paramsStatic?: Readonly<Record<string, unknown>>
  /** Form keys that trigger an options refresh when changed. */
  refreshOn?: readonly string[]
  /** Map a result row to the dropdown option shape. */
  mapOption: {
    readonly value: string
    readonly label: string
    readonly description?: string
  }
  /** Optional message shown when the form is missing required params (e.g. token). */
  emptyParamsMessage?: string
  /** Optional message shown when the action returns no results. */
  emptyResultsMessage?: string
  /**
   * When the action returns fewer than this many rows, render nothing.
   * A single row is written into `writesKey`, or into this field's key.
   * The manual fallback next to it stays the control the operator sees.
   */
  hideWhenFewerThan?: number
  /**
   * Settings key the chosen value is written to when it is not this field's
   * key. Use it so a discovery select and a manual text field do not share
   * one React key.
   */
  writesKey?: string
}

/**
 * Button that invokes an addon customAction. Used for "Verify token /
 * Test connection / Refresh credentials" affordances inside addon
 * settings panels. The form renderer surfaces success + error inline.
 */
export interface ConfigAddonActionButtonField extends ConfigFieldBase {
  type: 'addon-action-button'
  addonId: string
  action: string
  /** Visible label. */
  buttonLabel: string
  /** Visual variant. */
  variant?: 'default' | 'primary' | 'danger'
  /** Map form-value keys → action input keys. */
  paramsFromForm?: Readonly<Record<string, string>>
  /** Static params merged into the action input. */
  paramsStatic?: Readonly<Record<string, unknown>>
  /**
   * Merge the form's DEVICE into the action input as `deviceId`.
   *
   * An addon action on a per-camera form almost always needs to know which
   * camera, and a device id is not something a field can carry: it is context,
   * not a value the operator typed. Without this the only way to put an addon
   * action on a device form was `device-action-button`, which goes to a
   * different door (`deviceManager.runDeviceAction`) and therefore to a
   * different registration — so an addon that had registered a customAction
   * could not offer it here at all.
   *
   * No-op on a form with no device.
   */
  includeDeviceId?: boolean
  /**
   * Ask the operator for one value when the button is pressed and send it as
   * `input[param]`. For a one-shot argument that must not live in the saved
   * settings (ids to delete, a code to send). Cancelling runs nothing.
   */
  prompt?: {
    readonly param: string
    readonly title?: string
    readonly message?: string
    readonly placeholder?: string
  }
  /** Toast/inline success message template. `{key}` placeholders are
   *  resolved against the action result. */
  successMessage?: string
  /**
   * After a successful action, copy string fields from the result into form
   * keys (e.g. pairing writes `sslCertificate` without showing PEM fields).
   */
  assignResult?: Readonly<Record<string, string>>
  /** Confirmation prompt before executing. */
  confirmMessage?: string
}

/**
 * "Sign in with <provider>". The button asks the addon for an authorize URL.
 * PKCE verifier and state stay on the addon, keyed by `attemptId`. One paste
 * box completes the sign-in. Tokens are written into secret fields and are
 * not rendered here.
 */
export interface ConfigAccountSignInField extends ConfigFieldBase {
  readonly type: 'account-sign-in'
  /** The paste box is local. Stored keys are the sibling fields. */
  readonly value?: undefined
  readonly addonId: string
  /** "Sign in with {providerLabel}". */
  readonly providerLabel: string
  readonly beginAction: string
  readonly completeAction: string
  readonly signOutAction: string
  /** Non-secret settings key holding the account label. */
  readonly accountKey: string
  /** Optional numeric settings key shown after the account. */
  readonly countKey?: string
  /** Singular noun for `countKey` ("gateway" → "gateways"). */
  readonly countNoun?: string
  /**
   * Settings key holding an array or a JSON array string whose length is the
   * count when `countKey` is empty.
   */
  readonly countFromKey?: string
  /** Placeholder for the paste box. */
  readonly pastePlaceholder?: string
  /**
   * Shown when the complete action returns more than one `choices` row.
   * Picking one writes `choiceKey` plus `brand` and `region` when the row has them.
   */
  readonly choiceKey?: string
  readonly choiceLabel?: string
  /** Secret settings keys cleared with the keychain clear instruction on sign-out. */
  readonly secretKeys: readonly string[]
  /**
   * Copy these result keys into the form after a successful paste.
   * Secret values are stored for save and rendered only by their own fields.
   */
  readonly assignResult?: Readonly<Record<string, string>>
}

/**
 * "yes" / "no" for a secret that must not be shown. Reads another field's
 * value: a non-empty string or a keychain view counts as present.
 */
export interface ConfigSecretPresenceField extends ConfigFieldBase {
  readonly type: 'secret-presence'
  /** Reads another field. This row stores nothing. */
  readonly value?: undefined
  readonly sourceKey: string
  readonly yesLabel: string
  readonly noLabel: string
}

/**
 * Button that invokes a DEVICE custom action (the device equivalent of
 * `addon-action-button`). The deviceId comes from the form context, so it is
 * NOT a field. The form renderer dispatches it via
 * `trpc.deviceManager.runDeviceAction({ deviceId, action, input })`.
 */
export interface ConfigDeviceActionButtonField extends ConfigFieldBase {
  type: 'device-action-button'
  action: string
  buttonLabel: string
  variant?: 'default' | 'primary' | 'danger'
  /** Map form-value keys → action input keys. */
  paramsFromForm?: Readonly<Record<string, string>>
  /** Static params merged into the action input. */
  paramsStatic?: Readonly<Record<string, unknown>>
  successMessage?: string
  confirmMessage?: string
}

/**
 * Generic widget field — addon-contributed widget mounted by the
 * shared `<WidgetSlot>` runtime via the `WidgetRegistry`.
 *
 * The form-builder reads `widgetId` as the public widget identifier
 * (`<addonId>/<stableId>`) and forwards `widgetConfig` as `props.config`
 * to the widget. Widget fields go through the generic `WidgetRegistry`
 * without any per-type renderer registration in admin-ui.
 *
 * `key` is the form-field's unique identifier (kept distinct from the
 * widget identifier so the same widget can be mounted twice in the
 * same form). `widgetId` is the public id resolved against the
 * WidgetRegistry.
 *
 * Field carries no stored value — the widget owns its own state via
 * DeviceProxy / runtime-state hooks. Placed in
 * `ConfigFieldWithValue` only so the discriminated-union round-trip
 * through `hydrateSchema` stays homogeneous (`value: null`).
 */
export interface ConfigWidgetField extends ConfigFieldBase {
  readonly type: 'widget'
  /** `<addonId>/<stableId>` — resolved via the WidgetRegistry. */
  readonly widgetId: string
  /** Per-instance config payload forwarded to the widget as `props.config`. */
  readonly widgetConfig?: Readonly<Record<string, unknown>>
}

// IConfigurable is no longer a separate interface — config methods are part of ICamstackAddon.

// ---------------------------------------------------------------------------
// Schema + values fused ("hydrated") for the new three-level settings API
// ---------------------------------------------------------------------------
//
// `ConfigUISchemaWithValues` is the shape returned by the new
// `getAddonSettings() / getGlobalSettings() / getDeviceSettings()` family of
// methods on `ICamstackAddon`. Each leaf field carries its *current* value
// inline so the admin UI form builder can render in one pass without having
// to cross-reference a separate `values` object.
//
// Hydration rule (applied by `hydrateSchema` below):
//   value = storedValues[key] ?? field.default ?? null
//
// `value` is NEVER `undefined` — consumers can rely on `in` / `??` without
// surprises. Fields that don't carry a value (separator, info) are returned
// unchanged.

/** A `ConfigField` with its current value attached inline. */
export type ConfigFieldWithValue =
  | (ConfigTextField & { readonly value: unknown })
  | (ConfigNumberField & { readonly value: unknown })
  | (ConfigBooleanField & { readonly value: unknown })
  | (ConfigSelectField & { readonly value: unknown })
  | (ConfigMultiSelectField & { readonly value: unknown })
  | (ConfigTimezoneField & { readonly value: unknown })
  | (ConfigDateTimeField & { readonly value: unknown })
  | (ConfigColorField & { readonly value: unknown })
  | (ConfigIconField & { readonly value: unknown })
  | (ConfigPasswordField & { readonly value: unknown })
  | (ConfigTextAreaField & { readonly value: unknown })
  | (ConfigSliderField & { readonly value: unknown })
  | (ConfigTagsField & { readonly value: unknown })
  | (ConfigScheduleField & { readonly value: unknown })
  | ConfigGroupFieldWithValue
  | ConfigSubTabsFieldWithValue
  | ConfigSeparatorField
  | ConfigInfoField
  | ConfigQrCodeField
  | ConfigObjectArrayField
  | (ConfigEditableArrayField & { readonly value: unknown })
  | (ConfigModelSelectorField & { readonly value: unknown })
  | (ConfigStorageLocationField & { readonly value: unknown })
  | (ConfigProbeField & { readonly value: unknown })
  | ConfigButtonField // buttons are actions, not values
  | (ConfigNodeSelectField & { readonly value: unknown })
  | (ConfigNodeMultiSelectField & { readonly value: unknown })
  | (ConfigDeviceSelectField & { readonly value: unknown })
  | (ConfigDeviceMultiSelectField & { readonly value: unknown })
  | (ConfigNotificationTargetSelectField & { readonly value: unknown })
  | (ConfigNotificationTargetMultiSelectField & { readonly value: unknown })
  | ConfigWidgetField // widgets manage their own state; no form value
  | (ConfigAddonActionSelectField & { readonly value: unknown })
  | ConfigAddonActionButtonField // buttons are actions, not values
  | ConfigDeviceActionButtonField // buttons are actions, not values
  | ConfigAccountSignInField // the paste box is local; stored keys are sibling fields
  | ConfigSecretPresenceField // reads another field; stores nothing

/** Recursive version of `ConfigGroupField` with hydrated child fields. */
export interface ConfigGroupFieldWithValue extends ConfigFieldBase {
  readonly type: 'group'
  readonly fields: readonly ConfigFieldWithValue[]
  readonly style?: 'card' | 'inline' | 'accordion'
  readonly defaultCollapsed?: boolean
  readonly value?: undefined // groups don't carry their own value
}

/** Hydrated sibling of `ConfigSubTabDefinition` — fields inside each
 *  sub-tab carry their resolved values. */
export interface ConfigSubTabDefinitionWithValue {
  readonly id: string
  readonly label: string
  readonly icon?: string
  readonly badge?: string
  readonly fields: readonly ConfigFieldWithValue[]
}

/** Recursive version of `ConfigSubTabsField` with hydrated child fields. */
export interface ConfigSubTabsFieldWithValue extends ConfigFieldBase {
  readonly type: 'sub-tabs'
  readonly tabs: readonly ConfigSubTabDefinitionWithValue[]
  readonly value?: undefined // sub-tabs are layout, not a value
}

export interface ConfigSectionWithValues extends Omit<ConfigSection, 'fields'> {
  /**
   * Array kept mutable (not `readonly`) to stay assignable to the Zod-inferred
   * wire shape produced by `DEVICE_SETTINGS_CONTRIBUTION_METHODS.getDeviceSettingsContribution.output`.
   * Consumers treat it as immutable by convention — mutation is never
   * expected and would be a bug.
   */
  fields: ConfigFieldWithValue[]
}

export interface ConfigUISchemaWithValues {
  /** See `ConfigSectionWithValues.fields` — kept mutable for Zod wire compat. */
  tabs?: ConfigTabDeclaration[]
  sections: ConfigSectionWithValues[]
}

// ---------------------------------------------------------------------------
// `hydrateSchema` — backend-side helper
// ---------------------------------------------------------------------------

/**
 * Field types that never carry a value (separator, info, button). Used by
 * `hydrateSchema` to skip the `value` injection for structural-only fields.
 */
function isValuelessField(
  field: ConfigField,
): field is
  | ConfigSeparatorField
  | ConfigInfoField
  | ConfigQrCodeField
  | ConfigButtonField
  | ConfigObjectArrayField
  | ConfigWidgetField
  | ConfigAddonActionButtonField
  | ConfigDeviceActionButtonField
  | ConfigAccountSignInField
  | ConfigSecretPresenceField {
  return (
    field.type === 'separator' ||
    field.type === 'info' ||
    field.type === 'qr-code' ||
    field.type === 'button' ||
    field.type === 'object-array' ||
    field.type === 'widget' ||
    field.type === 'addon-action-button' ||
    field.type === 'device-action-button' ||
    field.type === 'account-sign-in' ||
    field.type === 'secret-presence'
  )
}

/**
 * The read-side inverse of `hydrateSchema`: flatten a hydrated
 * `ConfigUISchemaWithValues` (what `addonSettings.getDeviceSettings` /
 * every `get*Settings` endpoint returns) into a `key → effective value`
 * map, recursing through `group` and `sub-tabs` layout fields exactly as
 * `hydrateSchema` nested them. "Effective" = the field's `value`, falling
 * back to its `default`.
 *
 * Structural over `unknown` (the cap wire shape is loose) so any consumer
 * — an addon widget, an admin-ui card — can read a settings payload it
 * received over tRPC without re-implementing the walk. Malformed input
 * yields an empty map, never throws.
 */
/** A hydrated field's raw stored `value` and its schema `default`. */
export interface HydratedFieldEntry {
  readonly value: unknown
  readonly default: unknown
}

/**
 * Base collector: flatten a hydrated `ConfigUISchemaWithValues` into
 * `key → { value, default }`, recursing through `group` and `sub-tabs`
 * layout fields. Keeping `value` and `default` SEPARATE (rather than
 * pre-resolving) lets callers both read the effective value AND detect
 * overrides (`value` differs from `default`). Structural over `unknown`;
 * malformed input yields an empty map, never throws.
 */
export function collectHydratedFieldEntries(schema: unknown): Map<string, HydratedFieldEntry> {
  const out = new Map<string, HydratedFieldEntry>()
  if (typeof schema !== 'object' || schema === null) return out
  const sections = (schema as { sections?: unknown }).sections
  if (!Array.isArray(sections)) return out
  for (const section of sections) {
    if (typeof section === 'object' && section !== null) {
      collectFieldEntriesInto((section as { fields?: unknown }).fields, out)
    }
  }
  return out
}

/** Recursive field walker for {@link collectHydratedFieldEntries}. */
function collectFieldEntriesInto(fields: unknown, into: Map<string, HydratedFieldEntry>): void {
  if (!Array.isArray(fields)) return
  for (const field of fields) {
    if (typeof field !== 'object' || field === null) continue
    const type = (field as { type?: unknown }).type
    if (type === 'group') {
      collectFieldEntriesInto((field as { fields?: unknown }).fields, into)
      continue
    }
    if (type === 'sub-tabs') {
      const tabs = (field as { tabs?: unknown }).tabs
      if (Array.isArray(tabs)) {
        for (const tab of tabs) {
          if (typeof tab === 'object' && tab !== null) {
            collectFieldEntriesInto((tab as { fields?: unknown }).fields, into)
          }
        }
      }
      continue
    }
    const key = (field as { key?: unknown }).key
    if (typeof key !== 'string' || key.length === 0) continue
    if (!('value' in field)) continue
    into.set(key, {
      value: (field as { value?: unknown }).value,
      default: (field as { default?: unknown }).default,
    })
  }
}

/**
 * Flatten a hydrated settings payload into `key → EFFECTIVE value`
 * (`value ?? default`). The read-side inverse of `hydrateSchema` for the
 * common "just give me the resolved values" case. Built on
 * {@link collectHydratedFieldEntries}.
 */
export function collectHydratedFieldValues(schema: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const [key, entry] of collectHydratedFieldEntries(schema)) {
    out.set(key, entry.value ?? entry.default)
  }
  return out
}

/**
 * Read one field's effective value out of a hydrated settings payload —
 * convenience wrapper over {@link collectHydratedFieldValues} for the
 * single-field case. Returns `undefined` when the field is absent.
 */
export function resolveHydratedFieldValue(schema: unknown, key: string): unknown {
  const entry = collectHydratedFieldEntries(schema).get(key)
  return entry === undefined ? undefined : (entry.value ?? entry.default)
}

/**
 * Merge a `ConfigUISchema` with a raw `values` record into a
 * `ConfigUISchemaWithValues`. Used by every `get*Settings` backend endpoint
 * before returning to the admin UI. Groups are walked recursively.
 *
 * For each leaf field:
 *   - structural fields (`separator`, `info`, `button`) pass through unchanged
 *   - other fields get `value = values[key] ?? field.default ?? null`
 *
 * Unknown keys in `values` (keys not declared in the schema) are silently
 * ignored — they don't contribute to the output. Missing keys fall back to
 * the schema default or `null`. This mirrors the old backend behaviour where
 * `FormBuilder` rendered `values[key] ?? field.default`.
 */
/** How `hydrateSchema` treats keychain-stored secret fields (D789). */
export interface HydrateSchemaOptions {
  /**
   * `true` — the form is the addon's OWN settings form, saved through the
   * keychain-aware `BaseAddon` path: a pre-keychain inline value is shown as
   * "set" too, never as text. Omitted — only a keychain MARKER becomes a view;
   * an inline value hydrates as before, because forms saved through other
   * paths (a camera driver's settings) need the value they were given.
   */
  readonly inlineSecretsAsViews?: boolean
}

export function hydrateSchema(
  schema: ConfigUISchema,
  values: Record<string, unknown>,
  options: HydrateSchemaOptions = {},
): ConfigUISchemaWithValues {
  return {
    ...(schema.tabs ? { tabs: [...schema.tabs] } : {}),
    sections: schema.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => hydrateField(field, values, options)),
    })),
  }
}

function hydrateField(
  field: ConfigField,
  values: Record<string, unknown>,
  options: HydrateSchemaOptions,
): ConfigFieldWithValue {
  // Structural fields (separator / info / button) pass through unchanged —
  // they carry no stored value.
  if (isValuelessField(field)) {
    return field
  }

  // Groups are recursive — hydrate their children but don't attach a top-level value.
  if (field.type === 'group') {
    const hydratedChildren = field.fields.map((child) => hydrateField(child, values, options))
    const out: ConfigGroupFieldWithValue = {
      ...field,
      fields: hydratedChildren,
    }
    return out
  }

  // Sub-tabs are recursive too — hydrate fields inside every sub-tab but
  // skip the top-level value (sub-tabs are layout, not a value).
  if (field.type === 'sub-tabs') {
    const hydratedTabs: ConfigSubTabDefinitionWithValue[] = field.tabs.map((tab) => ({
      ...tab,
      fields: tab.fields.map((child) => hydrateField(child, values, options)),
    }))
    const out: ConfigSubTabsFieldWithValue = {
      ...field,
      tabs: hydratedTabs,
    }
    return out
  }

  // Leaf valued field. After the guards above, `field` is narrowed to every
  // variant of ConfigField that extends ConfigFieldBase (i.e. has `key` +
  // optional `default`), so we can read them directly.
  const key: string = field.key
  const storedValue = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined
  const defaultValue = field.default

  // A keychain-stored secret (D787) hydrates as "set / not set" — the
  // marker's view, or `null` — and NEVER its value or a default. The value
  // stays on the hub; an untouched form sends the view back, which the save
  // path reads as KEEP. Inline plaintext that predates the keychain shows as
  // set too, and is not echoed.
  const asView = (v: unknown): boolean =>
    isSecretMarker(v) || (options.inlineSecretsAsViews === true && v !== undefined)
  if (isKeychainStoredField(field) && asView(storedValue)) {
    return { ...field, value: toSecretFieldView(storedValue) }
  }
  if (isKeychainStoredField(field) && options.inlineSecretsAsViews === true) {
    return { ...field, value: null }
  }
  if (field.type === 'editable-array' && Array.isArray(storedValue)) {
    const secretItemKeys = field.itemFields
      .filter((item) => 'key' in item && isKeychainStoredField(item))
      .map((item) => ('key' in item ? item.key : ''))
    if (secretItemKeys.length > 0) {
      const rows = storedValue.map((row: unknown) => {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
        const out: Record<string, unknown> = { ...row }
        for (const k of secretItemKeys) {
          const v: unknown = Reflect.get(row, k)
          if (asView(v)) out[k] = toSecretFieldView(v)
        }
        return out
      })
      return { ...field, value: rows }
    }
  }

  // Multiple-mode: normalise to an array of `max(min, storedLen)` items.
  // Missing slots are padded with the field's `itemDefault` → `default`
  // → type-appropriate zero value so the renderer can always assume the
  // value is an array of exactly the right length.
  if (field.multiple) {
    const stored: readonly unknown[] = Array.isArray(storedValue)
      ? storedValue
      : storedValue !== undefined && storedValue !== null
        ? [storedValue]
        : []
    const itemFallback =
      field.multiple.itemDefault !== undefined
        ? field.multiple.itemDefault
        : defaultValue !== undefined
          ? defaultValue
          : typeOf(field) === 'string'
            ? ''
            : null
    const minCount = Math.max(field.multiple.min, stored.length)
    const items: unknown[] = []
    for (let i = 0; i < minCount; i++) {
      items.push(i < stored.length ? stored[i] : itemFallback)
    }
    return { ...field, value: items }
  }

  const rawValue: unknown =
    storedValue !== undefined ? storedValue : defaultValue !== undefined ? defaultValue : null

  // (Secret fields returned above. The mask that once hydrated as '' and was
  // saved back over the stored secret is why the keychain's KEEP rule treats
  // '' and the view as "unchanged" — D787 supersedes the plaintext round-trip.)

  // Textarea with `isJson: true` serialises the stored object/array as
  // pretty JSON so the human-editable input. The save path is
  // expected to `JSON.parse` before forwarding the patch to the writer.
  const value =
    field.type === 'textarea' && field.isJson && rawValue !== null && typeof rawValue === 'object'
      ? JSON.stringify(rawValue, null, 2)
      : rawValue

  // Tags may pull live suggestions from a sibling stored key (e.g. a scrape
  // catalog written by the owning addon/script). Merge, never replace the
  // static `suggestions` the schema already declared.
  if (field.type === 'tags' && typeof field.suggestionsFrom === 'string') {
    const from = values[field.suggestionsFrom]
    const extra = Array.isArray(from)
      ? from.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : []
    const merged = [...new Set([...(field.suggestions ?? []), ...extra])]
    return { ...field, suggestions: merged, value }
  }

  // Select / multiselect may pull options from a sibling catalog (string[]
  // or `{ value, label }[]`, e.g. NordVPN stations / UniFi route ids).
  if (
    (field.type === 'select' || field.type === 'multiselect') &&
    typeof field.optionsFrom === 'string'
  ) {
    const from = values[field.optionsFrom]
    const byValue = new Map<string, ConfigOption>()
    for (const opt of field.options) byValue.set(opt.value, opt)
    if (Array.isArray(from)) {
      for (const entry of from) {
        if (typeof entry === 'string' && entry.length > 0) {
          if (!byValue.has(entry)) byValue.set(entry, { value: entry, label: entry })
          continue
        }
        if (entry === null || typeof entry !== 'object') continue
        const v = Reflect.get(entry, 'value')
        const lbl = Reflect.get(entry, 'label')
        if (typeof v !== 'string' || v.length === 0) continue
        if (!byValue.has(v)) {
          byValue.set(v, {
            value: v,
            label: typeof lbl === 'string' && lbl.length > 0 ? lbl : v,
          })
        }
      }
    }
    return { ...field, options: [...byValue.values()], value }
  }

  // Spread-with-added-value preserves the discriminated-union variant.
  const hydrated = { ...field, value }
  return hydrated
}

/**
 * Rough "value family" classifier used by `hydrateField`'s multiple
 * fallback to pick a sensible zero-value when no `itemDefault` / no
 * field `default` / no stored value is available.
 */
function typeOf(field: ConfigField): 'string' | 'number' | 'boolean' | 'other' {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'password':
    case 'color':
    case 'probe':
    case 'timezone':
    case 'datetime':
      return 'string'
    case 'number':
    case 'slider':
      return 'number'
    case 'boolean':
      return 'boolean'
    default:
      return 'other'
  }
}

/** Strip inline `value` from a hydrated field for schema-only round-trips. */
export function dehydrateConfigField(field: ConfigFieldWithValue): ConfigField {
  if (field.type === 'group') {
    return {
      ...field,
      fields: field.fields.map(dehydrateConfigField),
    }
  }
  if (field.type === 'sub-tabs') {
    return {
      ...field,
      tabs: field.tabs.map((tab) => ({
        ...tab,
        fields: tab.fields.map(dehydrateConfigField),
      })),
    }
  }
  if (isValuelessField(field)) {
    return field
  }
  const { value: _drop, ...rest } = field
  return rest
}

/** Inverse of {@link hydrateSchema} — drops resolved values from every leaf field. */
export function dehydrateSchema(schema: ConfigUISchemaWithValues): ConfigUISchema {
  return {
    ...(schema.tabs ? { tabs: [...schema.tabs] } : {}),
    sections: schema.sections.map((section) => ({
      ...section,
      fields: section.fields.map(dehydrateConfigField),
    })),
  }
}
