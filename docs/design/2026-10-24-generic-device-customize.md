---
title: Generic cap-declared device Customize overrides
last-verified: 2026-10-24
---

# Generic cap-declared device Customize overrides

Status: design, approved with events in scope (2026-10-24). The contract is [D936](../decisions/adr-0936-a-customize-declaration-is-the-override-contract.md).

Recommendation: **go**. Build one cap-declared mechanism for scalar,
keyed-array and event assignments. `event` has two shapes, `pulse` and
`span`, because motion and doorbell are both event overrides and that is the
second real consumer §4.6 used to wait for. Migrate battery, running-state,
consumables, doorbell and motion onto it. A stored composition stays a
composition; motion's write stays the camera-sensor authority it already
uses. Nothing stays a bespoke Customize card unless a fact checked in §11
forces a different authority.

This is not a second state system. A declaration is compiled into the existing
composition and field-claim machinery. The composer remains the only evaluator,
the device-state mirror remains the authority that merges native and assigned
fields, and removing an assignment restores the native value exactly.

## 1. Intent

Today each simple assignment needs all of the following:

- a cap-specific card on Customize;
- a cap-specific builder that emits a `CompositionFieldsFeature`;
- cap-specific logic that recognizes whether a stored feature was written by
  that card;
- cap-specific source restrictions and transform controls;
- cap-specific tests for availability, add/remove and unreadable state.

The cost is repeated for facts that have the same underlying shape. Battery is
a scalar number, running is a scalar boolean derived from a boolean or number,
and consumables is a keyed array of scalar item fields. Doorbell is a pulse:
a rising edge, a count and a high-water mark, and no duration. Motion is a
span: it starts on a rising edge and ends on a falling edge or a timeout.
Their differences are declared. Motion does not become a claim on
`motion.detected`; the span's apply writes the camera-sensor authority that
already owns the camera's trigger.

The goal is:

> A capability declares what can be assigned, from which source values, with
> which transforms and on which device types. The framework derives the
> Customize card, validates and compiles the assignment, evaluates it through
> the composer, reports which authority is effective, and reuses the cap's own
> history and event declarations.

### Goals

- One declaration beside the capability's state schema.
- One generic UI for scalar, keyed-array and event assignments (`pulse` and
  `span`).
- One source picker and one transform vocabulary.
- One evaluator: the existing composer, driven by state changes and deadlines.
- Native state wins when no assignment is saved; an assignment wins only while
  its claim is effective.
- Pending, unknown, absent, stale and invalid remain different states.
- Existing stored battery, consumables and running assignments continue to
  load and edit without a migration.
- Adding a normal scalar override to a new cap requires a declaration and
  focused tests, not a new React component and evaluator.

### Non-goals

- Replacing the Advanced composition editor.
- Turning every Customize control into an assignment. Identity, linked devices
  and numeric self-transforms keep their existing authorities.
- General array merging into a native provider's array. Version 1 may add a
  keyed-array cap when the target lacks it, as consumables does today; it does
  not claim one native item while merging the provider's other items.
- Moving source freshness into the composer or polling sources.
- Making event delivery durable. Events remain telemetry; state is the durable
  fact.
- Hiding cap-specific semantics inside UI conditionals.

## 2. Binding constraints

The design follows these existing rules:

- Behavioural metadata lives only in the `*.cap.ts` definition (D4).
- Per-device aggregation and source resolution use bindings and
  `getProviderForDevice`; consumers do not branch on binding kind (D12, D13).
- Derived device UI follows the cap declaration rather than vendor-specific
  cards (D14).
- There is one authority for a value. A saved assignment claims it; no saved
  assignment means the native provider owns it. Removing the assignment
  releases the claim (D62, D663).
- A device-native fact remains fresh in its provider. The composer subscribes
  to the provider's mirrored state and never keeps a polling cache (D224).
- Pending and failed reads never look absent (D315).
- A failed measurement is `null`, not zero or false (D393).
- Per-device settings remain in the framework device store. The proposed
  mechanism adds no settings store and no per-device collection (D865).
- Consumables remain one keyed-array cap whose item kind and form retain their
  existing meanings (D915).
- History for a keyed array remains scoped by item key (D917).
- Operator-facing state and event vocabulary continues to come from the one
  cap-keyed vocabulary map. The new declaration references that vocabulary; it
  does not create another label map in capability files (D920).
- Running-state remains native or one assigned field, with unknown represented
  by `null` and the effective source reported (D933).
- Pickers suggest same-room devices; they never link or assign them
  automatically (D356).
- Events use `ctx.eventBus` and may be dropped. Their state transition remains
  recoverable from the cap slice (D8).

## 3. Current system

Customize edits one composition block whose target is an existing device.
Scalar and keyed-array cards write `CompositionFieldsFeature` objects. The
composer resolves source devices by `(addonId, stableId)`, subscribes to
`DeviceStateChanged`, evaluates affected fields, and writes the result through
device-state claims. The mirror keeps the native slice as an owner-only shadow
and serves the effective merge.

`DeclaredDevices` is not on this path. It creates or adopts devices for
new-target compositions. An existing-target customization declares no device;
it claims fields on the provider's existing row.

The Advanced editor is the escape hatch. A specialized card edits a stored
feature only when it recognizes the exact shape it writes. Otherwise it shows
"another formula" and links to Advanced rather than partially rebuilding and
silently losing fields.

### 3.1 Inventory

Line counts are physical lines as of 2026-10-24. Test counts include the
kind-focused specs named in the table, not shared composer coverage.

| Kind | Target and cardinality | Sources and transform | Evaluation and authority | UI and special cases | Product / focused test lines |
| --- | --- | --- | --- | --- | ---: |
| Battery | `battery.percentage`; scalar number. Adds the cap if absent or replaces the native percentage. | A field on another device. Numeric fields copy directly; numeric strings use `number(x)`. No threshold or scaling in the card. | The card writes a composition feature. The composer adds or claims `percentage`; add mode also supplies `charging: 'unknown'`, `sleeping: false`, and `lastUpdated: now`. A confirmed source loss releases a replacement to native; an added nullable measurement becomes `null`. | `BatteryAssignment.tsx`. Native battery is a read-only first row. Stored shapes the card did not write are Advanced-only. | 202 / 390 |
| Consumables | `consumables.items`; keyed array by item `key`. Each added item assigns either `level` or `remaining.value`. The cap may be added only when no native consumables cap owns the device. | A numeric field, or a numeric string through `number(x)`. The operator chooses `%`, days, hours or cycles. | The composer assembles the whole `items` array from `status.itemArray.emptyItem`, writes fixed non-resettable composed-item fields, and records history per item key. One required item leaf can hold the whole composed array; nullable measurements remain `null`. | `ConsumablesAssignment.tsx` plus `DefaultConsumableRows.tsx`. Native items and legacy level fields are read-only. Added items preserve label and key. Kind/form/status are not assigned by the current card. A noncanonical item is Advanced-only. | 391 / 709 |
| Motion | Camera effective motion, but not a composition field assignment. It is an owner-specific list of attached sensors. | Non-camera source devices carrying recognized active-state caps, primarily motion and contact. Each source has mode `in-addition`, `confirm`, or `replace`. | `pipeline-orchestrator.setCameraSensors` writes the whole bridge configuration after an answered read. The orchestrator owns effective camera motion, forwarding, clear windows and source readiness. The current card refreshes the raw camera level every 5 seconds while mounted; this polling is UI status refresh, not assignment evaluation. | `MotionAssignment.tsx` plus `motion-assignment.ts`. It shows the camera's own raw level, missing/offline/unreadable sources, old-orchestrator compatibility, forwarding/enforcement failures and the maximum sensor count. | 443 / 696 |
| Doorbell | `doorbell.lastPressedAt` plus `pressCountSinceStart`; event-like, multi-source any-of. The feature adds a doorbell cap; a native doorbell is not replaced. | Every recognized active boolean and transition timestamp on each picked device. `rose(active, changedAt, 2s)` detects a press, `latest(...)` merges sources and `count(lastPressedAt)` counts advances. | The composer owns stateful edge memory, event high-water and the two fields. It emits `DoorbellOnPressed` before the state write, then advances high-water so a failed event or write cannot replay it. The event may drop; restored `lastPressedAt` is the durable fact. | `DoorbellAssignment.tsx`, `doorbell-assignment.ts` and the canonical builder in `composition/presets/doorbell-feature.ts`. The card has an enabled switch, supports multiple source devices, and refuses to edit a noncanonical formula. | 394 / 674 |
| Running | `running-state.running`; scalar boolean, with companion `since`, `source`, `phase` and `lastFetchedAt`. Adds the cap or replaces native running. | Switch: on means running and cannot invert. Other booleans may invert. Any numeric field is treated as watts and evaluated with one threshold plus start/stop dwell. Defaults are 5 W, 30 s and 180 s; there is no separate hysteresis band today. | The composer evaluates direct booleans or `dwell(x >= threshold, start, stop)`, and arms one deadline rather than polling. `since` uses the source's `lastChangedAt` when available or `latchedAt(running)`. The feature writes `source: 'assigned'`. The hub mirror emits running start/finish from the effective merged slice. | `RunningAssignment.tsx` and `types/running-state/assignment.ts`. Numeric input currently does not verify that the source unit is watts. Stateful preview can explain the pending dwell but cannot invent an immediate final value. | 603 / 230 |

The five kinds above account for 2,033 dedicated production lines and 2,699
focused test lines. They also share:

| Shared area | Production lines | Role |
| --- | ---: | --- |
| `customize/assignments/*` | 1,259 | `DevicePicker` dialogs, field selection, candidates, same-room suggestions, live values, rows and sections |
| `customize/preset-features.ts` | 243 | Battery and consumables builders plus shape recovery; also doorbell recovery helpers |
| `CustomizeTab.tsx` + `assignment-availability.ts` | 438 | Hard-coded card list and per-kind availability |
| Advanced composition editor | 1,402 | Four-step target/features/fields/verify editor and pushed live preview |
| Composer production files | 5,968 | Source tracking, evaluation, deadlines, claims, grafts, writes and declarations |

The generic mechanism should remove cap-specific code, not replace the 5,968
line evaluator with a second one.

### 3.2 What capability declarations say today

None of the five `*.cap.ts` files declares that its state is assignable, which
source kinds are legal or which transform should be offered. That policy exists
only in the admin UI and preset builders.

| Capability file | What it declares today | What is missing |
| --- | --- | --- |
| `battery.cap.ts` | Device applicability, status/runtime schema, events and scalar history | Assignability of `percentage`, add companions and source/transform rules |
| `consumables.cap.ts` | Device applicability, item schema, `status.itemArray` metadata and per-item history | Add-only policy, assignable item leaves, composed-item defaults and source/transform rules |
| `motion.cap.ts` | Camera/sensor applicability, effective motion state, `onMotionChanged` and history | The span declaration: sources, per-source mode, timeout bound to `motionCooldownMs`, and apply through `cameraSensors` rather than a claim on `detected` |
| `doorbell.cap.ts` | Button/camera applicability, press state, `onPressed` (`fromState` advance of `lastPressedAt`) and no cap history | The pulse declaration: add-only composition, rising edge, debounce, count and the composer's high-water mark |
| `running-state.cap.ts` | All-device applicability, state including effective `source`, events and scalar history | Add/replace policy, boolean/power source rules, threshold/dwell and companion fields |

The generic proposal moves only the missing behavioural policy next to these
schemas. It does not duplicate the runtime schema, history or event metadata.

### 3.3 Adjacent Customize mechanisms

These are deliberately outside the generic override declaration:

- **Identity** (`IdentityRow.tsx`, 143 lines): name, room, hidden and role write
  the authorities that already own them. They are not cap fields.
- **Numeric transforms** (`NumericTransformsCard.tsx`, 409 lines): convert,
  script or invert the device's own field. This is self-composition, not an
  assignment from another device.
- **Linked devices** (`LinkedDevicesTable.tsx` and
  `linked-devices-model.ts`, 479 lines): writes the `linked-devices` extension
  slot. It uses the shared `DevicePicker`, same-room suggestions and explicit
  confirmation, but it is not a field claim.
- **Advanced**: edits the full composition. It remains available for formulas
  that the declaration does not model and for stored noncanonical formulas.

## 4. Generic declaration

Add an optional `customize` member to `CapabilityDefinition`. Its source form
contains Zod schemas and behavioural policy; codegen projects a serializable
descriptor for the server and admin UI. Addon manifests and provider
registrations continue to name the cap only.

The following is the proposed TypeScript shape. Names are illustrative but the
separation is required: source declarations say what may be picked, transform
declarations say what may be configured, and output declarations say how the
result lands in the cap.

```ts
export type CustomizeCardinality = 'scalar' | 'keyedArray' | 'event'
export type CustomizeValueKind = 'boolean' | 'number' | 'string' | 'enum'
export type CustomizeApplyMode = 'add' | 'replace' | 'add-or-replace'

export interface CapabilityCustomizeSpec {
  readonly version: 1
  readonly targets: readonly CapabilityCustomizeTarget[]
}

export type CapabilityCustomizeTarget =
  | ScalarCustomizeTarget
  | KeyedArrayCustomizeTarget
  | EventCustomizeTarget

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

export interface ThresholdTransformSpec {
  readonly kind: 'threshold'
  readonly comparison: 'gte' | 'lte'
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
 * composition claim. A span may name an authority that already owns the
 * event, and the declaration's apply is that write.
 */
export type CustomizeApplyAuthority =
  | { readonly kind: 'composition-claim' }
  | {
      readonly kind: 'camera-sensors'
      /** The span timeout is this existing pipeline-runner field, not a new store. */
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

export interface KeyedArrayFieldTarget {
  readonly path: string
  readonly sources: readonly CustomizeSourceSpec[]
}

export interface KeyedArrayCustomizeTarget extends CustomizeTargetBase {
  readonly cardinality: 'keyedArray'
  readonly path: string
  readonly keyField: string
  readonly labelField: string
  readonly itemSchema: z.ZodObject<z.ZodRawShape>
  readonly fields: readonly KeyedArrayFieldTarget[]
  readonly companions?: readonly CustomizeCompanion[]
  readonly nativeItems: 'read-only'
}

export interface EventCustomizeTargetBase extends CustomizeTargetBase {
  readonly cardinality: 'event'
  readonly eventName: string
  /** One source firing is enough. There is no "all must agree" combine. */
  readonly combine: 'any'
  readonly sources: readonly EventSourceSpec[]
  readonly applyAuthority: CustomizeApplyAuthority
}

/**
 * A pulse has no duration. A rising edge, a button press or a native event
 * advances a timestamp, increments a counter, and moves the composer's
 * high-water mark. Presses inside `debounce` are one pulse.
 */
export interface PulseEventCustomizeTarget extends EventCustomizeTargetBase {
  readonly shape: 'pulse'
  readonly edges: readonly CustomizeEventEdge[]
  readonly timestampPath: string
  readonly counterPath: string
  /**
   * The composer already tracks a high-water mark on `timestampPath`'s
   * advance (D670). The declaration names that path; it does not add a
   * runtime field.
   */
  readonly highWater: 'composer-advance'
  readonly debounce: RisingEdgeTransformSpec
}

export type CameraSensorCustomizeMode = 'in-addition' | 'confirm' | 'replace'

/**
 * A span starts on a rising edge and ends on a falling edge or when
 * `timeoutMs` elapses. `cooldownMs` is present only when the authority has a
 * quiet period that is not the timeout. `sourceModes` is present only when
 * the authority stores a per-source mode.
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
```

`expression` is not a separate source device type. It is an advanced transform
over one or more field bindings. `advancedExpression: true` means the generic
card links to the existing Advanced editor; the simple add flow does not expose
raw expressions.

### 4.1 Projection and validation

Codegen must produce a `CAP_CUSTOMIZE_CATALOG` with no Zod objects in its wire
shape. It contains field kinds, nullability, enum values, item key/label paths,
device-type applicability and allowed transform controls. Generation fails
when:

- a declared target path is absent from `runtimeState`;
- a scalar target names a non-leaf;
- a keyed array does not agree with `status.itemArray`;
- an item field is absent from `itemSchema`;
- a transform's output kind cannot parse into its target;
- `sourceReport.runtimeField` is not an enum/string field capable of the two
  declared values;
- a required companion is neither supplied nor already native in add mode;
- an event name is not declared by the cap;
- a pulse `timestampPath` or `counterPath` is absent from `runtimeState`;
- a pulse cap that declares `events.*.fromState` does not advance the same
  timestamp path;
- a pulse declares a duration, or a span declares a counter;
- a span `timeoutMs` is missing or negative, or `cooldownMs` is present and
  negative;
- `applyAuthority.kind` is `camera-sensors` on anything other than a span
  whose event is `onMotionChanged`;
- an event target also claims that event's boolean as a scalar;
- `sourceModes` names a value outside `CameraSensorModeSchema`;
- a vocabulary reference does not exist in the D920 map;
- `deviceTypes` widens beyond the capability's own device types.

The server validates an assignment draft with Zod, looks up the generated
descriptor, and compiles it to a normal `CompositionFieldsFeature`. The stored
block remains a `Composition`; there is no second assignment record.

### 4.2 Authority and source reporting

The effective authority is derived, never stored as a second switch:

1. No saved assignment means no claim. The native provider is authoritative.
2. A saved and evaluable assignment claims its declared fields. The assigned
   value is authoritative.
3. Removing the assignment releases the claim and exposes the native shadow
   exactly.
4. A failed or first source read changes nothing. The previous assigned value
   is stale and held.
5. A confirmed unavailable source on a replacement releases the field to the
   native provider. A confirmed unavailable source on an added nullable field
   writes `null`.
6. A source returning reclaims and recomputes the field.

The generic assignment-status projection always reports:

```ts
export interface CustomizeAssignmentStatus {
  readonly targetId: string
  readonly configured: boolean
  readonly source: 'native' | 'assigned'
  readonly state: 'active' | 'stale' | 'released' | 'unavailable'
  readonly reason: string | null
}
```

`source` is the effective authority, not merely "an assignment row exists".
When a cap has a domain-visible source field, as running-state does, the
declaration also writes it through `sourceReport.runtimeField`. Caps without
such a field, such as battery today, still report source through the
assignment-status projection and Customize UI. This avoids adding an optional,
usually absent provenance field to every runtime schema.

### 4.3 Worked declaration: battery

```ts
customize: {
  version: 1,
  targets: [
    {
      id: 'percentage',
      cardinality: 'scalar',
      vocabulary: { cap: 'battery', stateField: 'percentage' },
      deviceTypes: batteryCapability.deviceTypes,
      apply: 'add-or-replace',
      path: 'percentage',
      sources: [
        {
          kind: 'field',
          valueKinds: ['number', 'string'],
          transforms: [
            { kind: 'identity' },
            { kind: 'linear', defaultScale: 1, defaultOffset: 0, clampMin: 0, clampMax: 100 },
          ],
        },
      ],
      companions: [
        { kind: 'constant', path: 'charging', value: 'unknown', when: 'add' },
        { kind: 'constant', path: 'sleeping', value: false, when: 'add' },
        { kind: 'clock', path: 'lastUpdated', when: 'add' },
      ],
      sourceReport: { status: 'assignment-status' },
      advancedExpression: true,
    },
  ],
},
```

The compiler preserves the current add and replace shapes. A numeric string is
normalized with `number(x)` before the selected transform. Invalid or
out-of-range output is `null`; it is never clamped unless the operator selected
the declared linear transform.

### 4.4 Worked declaration: consumables

```ts
customize: {
  version: 1,
  targets: [
    {
      id: 'items',
      cardinality: 'keyedArray',
      vocabulary: { cap: 'consumables' },
      deviceTypes: consumablesCapability.deviceTypes,
      apply: 'add',
      path: 'items',
      keyField: 'key',
      labelField: 'label',
      itemSchema: ConsumableItemSchema,
      nativeItems: 'read-only',
      sourceReport: { status: 'assignment-status' },
      fields: [
        {
          path: 'level',
          sources: [
            {
              kind: 'numeric',
              transforms: [
                { kind: 'identity' },
                {
                  kind: 'linear',
                  defaultScale: 1,
                  defaultOffset: 0,
                  clampMin: 0,
                  clampMax: 100,
                },
              ],
            },
          ],
        },
        {
          path: 'remaining.value',
          sources: [{ kind: 'numeric', transforms: [{ kind: 'identity' }] }],
        },
        {
          path: 'status',
          sources: [
            {
              kind: 'enum',
              transforms: [
                {
                  kind: 'enum-map',
                  outputValues: ConsumableStatusSchema.options,
                  unmapped: null,
                },
              ],
            },
          ],
        },
      ],
      companions: [
        { kind: 'clock', path: 'lastChangedAt', when: 'add' },
        { kind: 'clock', path: 'lastFetchedAt', when: 'add' },
      ],
      advancedExpression: true,
    },
  ],
},
```

Keyed-array companion paths are relative to the cap state; fixed item fields
come from the cap's `emptyItem`. The item form continues to ask for key/label
and uses the cap's kind/form defaults and fixed composed-item fields. It can
assign level, remaining count or status without a new component. Native items
remain read-only in version 1 because claiming `items` owns the whole array;
silently merging a native item list in the UI would create a second authority.

### 4.5 Worked declaration: running-state

```ts
customize: {
  version: 1,
  targets: [
    {
      id: 'running',
      cardinality: 'scalar',
      vocabulary: { cap: 'running-state', stateField: 'running' },
      deviceTypes: runningStateCapability.deviceTypes,
      apply: 'add-or-replace',
      path: 'running',
      sources: [
        { kind: 'switch', transforms: [{ kind: 'identity' }] },
        {
          kind: 'binary',
          transforms: [{ kind: 'identity' }, { kind: 'invert' }],
        },
        {
          kind: 'numeric',
          requiredUnit: 'W',
          transforms: [
            {
              kind: 'threshold',
              comparison: 'gte',
              defaultThreshold: RUNNING_POWER_THRESHOLD_WATTS,
              defaultStartDwellMs: RUNNING_POWER_START_DELAY_MS,
              defaultStopDwellMs: RUNNING_POWER_STOP_DELAY_MS,
              thresholdUnit: 'W',
            },
          ],
        },
      ],
      companions: [
        { kind: 'constant', path: 'source', value: 'assigned', when: 'always' },
        { kind: 'constant', path: 'phase', value: null, when: 'always' },
        { kind: 'clock', path: 'lastFetchedAt', when: 'always' },
        { kind: 'transition-time', path: 'since', sourceChangedAt: 'prefer' },
      ],
      sourceReport: {
        status: 'assignment-status',
        runtimeField: 'source',
        nativeValue: 'native',
        assignedValue: 'assigned',
      },
      advancedExpression: true,
    },
  ],
},
```

Unlike the current card, the declaration requires the numeric source unit to
normalize to watts. An untyped number is not offered as power. This prevents a
temperature or percentage field from being accepted merely because it is
numeric.

### 4.6 Motion and doorbell

Motion and doorbell are the two event consumers. Both migrate. Neither is a
keyed array and neither claims a boolean the native provider already owns.

**Pulse — doorbell pressed.** The cap already says so: `onPressed` is "a
pulse" with no release, `fromState` advances `lastPressedAt`, and the
canonical builder emits `latest(rose(...))` plus `count(lastPressedAt)` with
`DOORBELL_RISE_DEBOUNCE_MS` (2 s). The composer emits `DoorbellOnPressed`
before the state write and then advances its high-water mark, so a dropped
event is not replayed (D670). A level that is already high at first sight
does not ring. Apply is `add`: a native doorbell is not replaced. The
feature's existing `enabled` flag is the card's switch. The compiler emits
that same canonical feature; it does not invent an event category from a
string. The explicit composition event map stays the fail-closed authority.

```ts
customize: {
  version: 1,
  targets: [
    {
      id: 'pressed',
      cardinality: 'event',
      shape: 'pulse',
      vocabulary: { cap: 'doorbell', eventName: 'onPressed' },
      deviceTypes: [DeviceType.Camera],
      apply: 'add',
      applyAuthority: { kind: 'composition-claim' },
      eventName: 'onPressed',
      edges: ['rising'],
      timestampPath: 'lastPressedAt',
      counterPath: 'pressCountSinceStart',
      highWater: 'composer-advance',
      combine: 'any',
      debounce: {
        kind: 'rising-edge',
        defaultDebounceMs: DOORBELL_RISE_DEBOUNCE_MS,
        changedAtRequired: true,
      },
      sources: [{ kind: 'binary' }, { kind: 'switch' }],
      sourceReport: { status: 'assignment-status' },
      advancedExpression: true,
    },
  ],
},
```

`edges` may also name `button` or `native-event`. Doorbell's override uses
`rising` because that is what the stored feature evaluates. A native firmware
ring is the provider of `onPressed`, not a second override of it.

**Span — motion detected.** The target event is `motion.onMotionChanged`.
The camera's effective `detected` stays the orchestrator's merged slice.
Checked: `CameraSensorsConfigSchema` stores
`{ sensors: [{ addonId, stableId, mode }] }` and nothing else
(`packages/types/src/pipeline/camera-sensors.ts`). The current card writes
that whole list through `setCameraSensors` (`motion-assignment.ts`). Per-source
mode is `in-addition | confirm | replace` (D673). A list that was not read is
never written (D49). A pre-CS-2 orchestrator that cannot accept the write
offers no control (D676). More than `MAX_CAMERA_SENSORS` (8) is refused. A
camera cannot be a sensor (D672 rule 5).

The span's apply is that write, not a composition claim on `detected`. A
second claim would be a second authority (D62). Timeout is the camera's
existing `motionCooldownMs` (pipeline-runner default 30 s): the window after
which a heartbeat-only camera's own edge no longer counts, and the window the
span uses when a falling edge does not arrive. Checked separately:
`maxSessionHoldMs` (default 120 s) is the stuck-high bound inside the
orchestrator (D672 rule 9), and `MOTION_CLOSE_AFTER_MS` (15 s) closes the
episode row (D672 rule 12). Neither is an operator field on `cameraSensors`,
and neither is a quiet period distinct from `motionCooldownMs`. The motion
span therefore declares no `cooldownMs`. A span whose authority does have a
distinct quiet period declares `cooldownMs`; motion is not that span.

Source readiness, forwarding (`notForwarded`) and enforcement
(`notEnforced`) stay answers of `CameraSensorsStatus`. The generic span card
renders those answers. It does not poll, and it does not keep a copy.

```ts
customize: {
  version: 1,
  targets: [
    {
      id: 'detected',
      cardinality: 'event',
      shape: 'span',
      vocabulary: { cap: 'motion', eventName: 'onMotionChanged' },
      deviceTypes: [DeviceType.Camera],
      apply: 'replace',
      applyAuthority: { kind: 'camera-sensors', timeoutField: 'motionCooldownMs' },
      eventName: 'onMotionChanged',
      start: 'rising-edge',
      end: 'falling-edge-or-timeout',
      timeoutMs: 30_000,
      combine: 'any',
      sourceModes: ['in-addition', 'confirm', 'replace'],
      sources: [{ kind: 'binary' }, { kind: 'switch' }],
      sourceReport: { status: 'assignment-status' },
      advancedExpression: false,
    },
  ],
},
```

`apply: 'replace'` here means the saved sensor list replaces the stored
`cameraSensors` value (the whole list, as today). It does not replace the
camera's native motion provider. Removing the assignment writes `null`
through the same method, which is how that authority clears the list.

## 5. One evaluator

### 5.1 Save path

The UI submits an `OverrideDraft`, not a hand-built expression string. The
server:

1. parses the draft with Zod;
2. resolves the cap and target from `CAP_CUSTOMIZE_CATALOG`;
3. verifies target device type, current binding mode and source field kind/unit;
4. compiles the selected transform to a `CompositionFieldSource`;
5. fills declared companion fields;
6. merges the resulting feature into the device's one customization block;
7. validates the complete composition with the existing planner;
8. saves with `expectedUpdatedAt`.

The pure compiler is shared with admin UI preview, but the server repeats
validation at the boundary. The stored result is still the current
`CompositionSchema`.

### 5.2 Runtime path

No generic assignment service runs beside the composer.

```text
provider owns source freshness
        │ setCapState / pushed edge
        ▼
hub DeviceStateMirror ── DeviceStateChanged ──► SourceTracker
        ▲                                      │
        │ native shadow                        ▼
        │                              CompositionRuntime
        │                              transform + deadline
        │                                      │
        └──────── effective cap slice ◄── field claim / patch
```

- Source providers retain their existing stale windows and
  serve-and-revalidate policy.
- `SourceTracker` keeps one last answered source reading for stale semantics;
  this is part of the evaluator, not a consumer-owned copy.
- A source state event evaluates only fields that read that source.
- `threshold` compiles to `dwell(...)`; the runtime arms its one earliest
  deadline. It never polls.
- `linear` compiles to arithmetic plus explicit clamp.
- `enum-map` compiles to a closed expression whose unmapped result is the
  declared fallback, normally `null`.
- UI preview subscribes through `useDeviceCapSlice`; it does not poll. A
  stateful transform may show "waiting for 30 s dwell" instead of pretending
  it already has a final value.

### 5.3 Failure semantics

| Condition | Effective value | Assignment status | Action |
| --- | --- | --- | --- |
| Source query pending | Previous value if any; otherwise not seeded | `stale` or `unavailable` | No claim release |
| Source read failed | Previous value marked stale | `stale`, reason shown | Provider retries by its own policy |
| Source answered `null` | `null` when target is nullable | `active` with unknown value | No coercion |
| Expression/transform failed on an answered value | `null` when nullable; otherwise cap unavailable | `unavailable`, named error | Next source value may recover |
| Source confirmed gone, replacement | Native shadow | `source: native`, `released` | Reclaim if source returns |
| Source confirmed gone, added cap | `null` for nullable fields; cap unavailable if a required field has no value | `source: assigned`, `unavailable` | No invented native |
| Target write refused transiently | Last landed effective slice | `unavailable`, named refusal | Retry on next source/deadline pass |
| Target write refused terminally | No further writes from this runtime | `unavailable`, block failed | Operator edit/removal required |

Every value-producing failure remains `null`, never `0`, `false` or an empty
array unless the source actually reported that value. A transport/read failure
does not manufacture a measurement at all, so D224 keeps the last answered
slice and marks it stale; when evaluation does produce a failed measurement,
D393 requires `null`.

### 5.4 History

The evaluator does not write history. It writes the effective cap slice.
`DeviceStateChanged` then feeds the existing device-history capture:

- scalar fields use the cap's existing `history.fields`;
- keyed arrays use `history.items`, with the item key as series scope;
- released replacements resume native history naturally;
- no assignment-specific series or retention policy is introduced.

### 5.5 Events

Running start/finish stays in the hub mirror, after the native/assigned merge.
It sees one boolean authority and does not emit on a restored seed or on null.
That path is not an `event` customize target.

An `event` target uses the cap's own event declaration and the explicit
`EventCategory` map. The compiler does not infer a category from a string.
Replace never creates a second event authority beside a native provider.
Event delivery remains telemetry (D8): a failure is logged, the state write
still happens, and a failed emit does not replay. Consumers that need the
fact read the cap slice.

**Pulse.** Evaluation is the existing doorbell order. A rising edge of a
binary or switch, a button press, or a native event advances `timestampPath`
and increments `counterPath`. Edges closer than `debounce` are one pulse. A
source already high when first observed does not pulse. The composer emits
the cap event before the state write, then advances the high-water mark on
that timestamp, so a failed emit or a failed write cannot replay the pulse
(D670). There is no duration and no falling-edge end.

**Span.** A rising edge starts the span. A falling edge ends it. If the
falling edge does not arrive, the span ends when `timeoutMs` elapses. When
`cooldownMs` is declared, a new rising edge inside that quiet period does not
start another span. Motion's span has no `cooldownMs` (§4.6). Its apply does
two writes that already exist, each through the owner of that fact:

1. the sensor list and per-source mode, through `setCameraSensors`;
2. the timeout, through the camera's `motionCooldownMs`.

The orchestrator keeps emitting `onMotionChanged`. The card does not emit a
second event, and it does not claim `motion.detected`. An unread sensor list
is not written back (D49). A confirmed-gone source is reported from the
authority's status (`missing`, `offline`, `unsupported`, `unreadable`); the
card does not drop it silently. Forwarding and enforcement failures stay
`notForwarded` and `notEnforced` on that status.

## 6. Derived Customize UI

The page orders cards from the generated descriptor, not from imports in
`CustomizeTab.tsx`. Identity stays first, then generic cap cards (scalar,
keyed-array, pulse, span), linked devices, then Advanced (a modal; Remove
lives in that modal only when a customization exists).

### 6.1 Component map

| Need | Existing component |
| --- | --- |
| Cap card and setting rows | `SectionCard`, `SettingRow`, `Badge`, `StatusBadge` |
| Source device selection | shared `DevicePicker` |
| Long picker on a phone | `Dialog` + `DialogContent placement="sheet-on-mobile" scroll="body"` |
| Buttons and remove action | `Button`, `IconButton`, `useConfirm` |
| Transform controls | `Select`, `Input`, `Checkbox`, `Switch` |
| Pending | `Skeleton` or an explicit status row |
| Failed read / retry | `ErrorBox` |
| Answered empty list | `EmptyState` |
| Keyed rows | `DataTable` on desktop; its responsive row content on phone |
| Live values | `useDeviceCapSlice` with the existing live-value formatter |
| Presence gate | `useCapabilityPresence` |

`AssignmentSection`, `AssignmentRow` and the two current picker wrappers can
become one generic local composition over these library components. No new
visual language is needed.

### 6.2 Cap card list

```text
Customize
┌ Identity ────────────────────────────────────────────────────────┐
│ Name              Room              Hidden             Role      │
└─────────────────────────────────────────────────────────────────┘

┌ Battery                                      Assigned · Garage ┐
│ Native camera battery                                      73% │
│ Override: Garage sensor · numeric-sensor.percentage         81% │
│ [Change] [Remove]                                               │
└─────────────────────────────────────────────────────────────────┘

┌ Running                                      Native · Dishwasher┐
│ No override                                                      │
│ [+ Add override]                                                 │
└─────────────────────────────────────────────────────────────────┘

┌ Consumables                                      2 assigned ┐
│ Salt             Native                                  Low │
│ Main filter      Garage meter · 64%                       64% │
│ [+ Add item]                                                   │
└───────────────────────────────────────────────────────────────┘

┌ Motion                                       Span · 2 sources ┐
│ Garage PIR        binary · in addition              Clear   │
│ Porch contact     contact · confirm                 Open    │
│ Timeout 30 s · ends when every source is clear             │
│ [+ Add source]                                              │
└─────────────────────────────────────────────────────────────┘
```

The status badge reflects the effective authority. A configured assignment
whose confirmed source disappeared can therefore say `Native · source
missing`, not the misleading `Assigned`.

### 6.3 Add override

```text
Add running override
┌───────────────────────────────────────────────────────────────┐
│ 1  Source device                                              │
│    [ Search devices...                                      ] │
│    Suggested · Kitchen                                       │
│    ○ Dishwasher plug       Switch · Kitchen                  │
│    ○ Power meter           Numeric sensor · Kitchen          │
│                                                               │
│ 2  Field                                                     │
│    ● power                 8.4 W                              │
│    ○ voltage               231 V        Not compatible       │
│                                                               │
│ 3  Transform                                                 │
│    Running at or above [ 5 ] W                               │
│    Start after          [ 30 ] s                              │
│    Stop after           [ 180 ] s                             │
│                                                               │
│ Live preview                                                  │
│    Source 8.4 W · threshold active · running in 18 s          │
│                                                               │
│                         [Cancel] [Save override]               │
└───────────────────────────────────────────────────────────────┘
```

The sequence is source device, field, transform. It uses one dialog and keeps
the selected device visible while the operator changes the field. Same-room
devices are suggestions only. Incompatible fields remain absent or carry a
specific reason; a number with the wrong unit is not silently accepted.

The preview uses the same pure compiler/evaluator as runtime where possible.
Stateful transforms show their current level and remaining dwell. They do not
simulate memory the runtime does not yet have.

### 6.4 Keyed-array item

```text
Add consumable
┌───────────────────────────────────────────────────────────────┐
│ Item                                                          │
│ Name [ Main filter                 ]                           │
│ Key  [ main-filter                 ]                           │
│ Field to assign  [ Remaining level ▼ ]                        │
│                                                               │
│ Source device                                                │
│ [ Garage maintenance counter                                ] │
│ Source field  [ hoursRemaining · 192 h ▼ ]                    │
│                                                               │
│ Transform                                                     │
│ [ Linear scale ▼ ]   scale [0.3333]  offset [0]               │
│ Clamp [0] to [100] %                                          │
│                                                               │
│ Preview: 192 h → 64% · Part · OK                              │
│                         [Cancel] [Add item]                    │
└───────────────────────────────────────────────────────────────┘
```

Each item is independently addable/removable in the UI, but the compiler emits
one canonical `items` feature and the composer writes the array whole. Native
items are shown read-only. A row from another formula is shown and links to
Advanced; the generic card never removes it.

### 6.5 Event assignment

Pulse and span are two cards. Both pick sources with `DevicePicker`. Same-room
devices are suggestions only. A source already on when first observed does not
start a pulse or a span.

**Span** — start on a rising edge, end on a falling edge or after the timeout,
optional cooldown when the declaration has `cooldownMs`. Motion shows
per-source mode because its authority stores one, and it shows the authority's
answered status (ready, offline, missing, unreadable, not forwarded) on the
row. It does not offer a cooldown control: the motion declaration has no
`cooldownMs`.

```text
Motion detected
┌───────────────────────────────────────────────────────────────┐
│ Garage PIR       binary.on           In addition    Clear    │
│ Porch contact    contact.entryOpen   Confirm        Open     │
│                                                               │
│ Starts when any source rises. Ends when every source falls,  │
│ or after the timeout if a fall never arrives.                 │
│                                                               │
│ Timeout   [ 30 ] s                                            │
│ Cooldown  [ 10 ] s          (hidden when not declared)        │
│                                                               │
│ [+ Add source]                                                │
└───────────────────────────────────────────────────────────────┘
```

**Pulse** — a rising edge, a button press or a native event. Count and
high-water mark, no duration. Doorbell keeps the enabled switch (`enabled` on
the composition feature) and says that presses inside the debounce are one
press.

```text
Doorbell presses                                      [Active ✓]
┌───────────────────────────────────────────────────────────────┐
│ Front gate button     binary.on          Inactive             │
│ Porch contact         contact.entryOpen  Closed               │
│                                                               │
│ Any rising edge rings this camera. There is no duration.      │
│ Presses within [ 2 ] s merge. The count advances once.        │
│                                                               │
│ [+ Add source]                                  [Advanced...] │
└───────────────────────────────────────────────────────────────┘
```

Adding a pulse source lists only fields that can rise: an active boolean with
a transition timestamp, a button, or a native event the source cap declares.
A bare "on" level is not a pulse. The high-water mark is not a control.

### 6.6 Pending, unknown and invalid states

```text
┌ Running ──────────────────────────────────────────────────────┐
│ Checking capabilities...                                     │
└───────────────────────────────────────────────────────────────┘

┌ Running ──────────────────────────────────────────────────────┐
│ Could not read the source field                              │
│ Power meter did not answer. The last assigned value is held. │
│ [Retry]                                                       │
└───────────────────────────────────────────────────────────────┘

┌ Running                                      Native · released┐
│ The assigned source no longer exists. Native state is active.│
│ [Choose another source] [Remove assignment]                  │
└───────────────────────────────────────────────────────────────┘
```

- A card is absent only after the cap applicability query answered.
- Saving is disabled while target bindings, source fields or current
  customization are unread.
- A missing stored source is retained and named. It is never silently removed.
- A failed preview is `?` with a reason, not `0`.
- The source device, field and transform remain visible during an error so the
  operator can repair rather than recreate the assignment.

### 6.7 Phone layout

```text
390 px
┌ Running ───────────────┐
│ Assigned               │
│ Dishwasher plug        │
│ power · 8.4 W          │
│ ≥ 5 W                  │
│ 30 s start             │
│ 180 s stop             │
│                        │
│ [Change]               │
│ [Remove]               │
└────────────────────────┘

┌ Add running override ──┐  ← sheet-on-mobile
│ Source device          │
│ [Search...]            │
│ ○ Dishwasher plug      │
│ ○ Power meter          │
│                        │
│ Field                  │
│ ● power · 8.4 W        │
│                        │
│ Transform              │
│ threshold [5 W]        │
│ start [30 s]           │
│ stop [180 s]           │
│                        │
│ Preview ...            │
│ [Cancel] [Save]        │  ← sticky dialog footer
└────────────────────────┘
```

Cards become one column, labels sit above controls, and actions wrap rather
than compress. The picker is a bottom sheet, not a desktop modal scaled down.
There is no nested unconditional page padding.

## 7. Stored format and migration

Recommendation: **no migration because the stored format does not change**.

Battery, consumables and running assignments are already compositions. The
generic compiler must emit the same canonical feature shapes, and its decoder
must recognize the existing shapes:

- battery direct/`number(x)` percentage, with existing add companions;
- consumable item level or remaining-unit forms;
- running direct/inverted boolean and the current `dwell(...)` form.

Golden fixtures copied from current tests prove old rows remain editable. They
live in `packages/types/src/composition/customize/__fixtures__/` (stored
compositions for battery, consumables, running-state and doorbell; the
`cameraSensors` write for motion; plain UI card states for all five). The
round-trip harness is
`packages/types/src/composition/customize/__tests__/customize-round-trip.spec.ts`:
decode the stored value to a draft, compile the draft, and require the
normalized result to equal the stored value. The old specialized builders are
deleted only after that harness stays green on the generic decoder.

This follows the D900 migration lesson: do not ship a permanent adoption layer
for an old store. Either the new mechanism reads the existing format directly,
as proposed, or the release is a documented clean cut. A hidden best-effort
conversion is not acceptable. Because both old and new use
`CompositionSchema`, direct readability is simpler and safer than a clean cut.

No `legacyAssignment`, `adoptsFrom`, startup rewrite or fallback collection is
introduced.

## 8. Comparison with today

| Area | Today | Generic scalar, keyed array and event | Trade-off |
| --- | --- | --- | --- |
| Source of truth | Cap schema plus hard-coded card/builders | Cap schema plus one `customize` declaration | Behavioural metadata becomes explicit and codegen-checkable |
| UI consistency | Similar cards with divergent controls and errors | One card family, one picker, one preview and one error model | Cap-specific polish must be expressible as declaration hints |
| Evaluation | Composer for compositions; orchestrator for camera sensors | Same two owners. The compiler emits composition features or the authority write the declaration names | Avoids a second evaluator. Motion does not move into the composer |
| New scalar cap cost | React card, builder/recovery, availability branch and tests | Declaration, vocabulary entry if needed, compiler/catalog tests | Large reduction after framework cost |
| Keyed-array cost | Consumables-only code | Generic item renderer and item descriptor | Version 1 cannot merge selected native items |
| Pulse cost | Doorbell-specific edge builder | Generic pulse compiler emitting the canonical `rose` / `count` feature | Debounce, count and high-water stay one audited shape |
| Span cost | Motion card over `setCameraSensors` | Generic span card. Apply writes `cameraSensors` and `motionCooldownMs` | Diagnostics come from `CameraSensorsStatus`, not a second component. No cooldown knob, because the authority has no distinct quiet period |
| Source freshness | Provider plus pushed composer tracker | Unchanged for composition claims. Motion status stays the orchestrator's answered read | No polling/cache regression |
| Authority | Encoded by each builder and claims | Declared apply mode and `applyAuthority` | Effective source can be displayed consistently. Motion still has one writer |
| Unknown/error states | Implemented repeatedly | Shared discriminated state | Less chance of pending becoming absent or null becoming zero |
| Advanced formulas | Full editor | Unchanged, linked from unrecognized composition rows | Motion has no advanced expression; its write is the sensor list |
| Migration | N/A | None for compositions. Motion keeps the `cameraSensors` document | Golden round trips before deleting cards |
| Production code removed | All five cards, their builders and hard-coded availability branches | The five dedicated cards (about 2,033 lines) after parity | Deletion happens only after the round-trip harness stays green |
| Production code added | None | Declarations, catalog, compiler/decoder/status, generic scalar, keyed-array, pulse and span UI | The event phase is where motion and doorbell move |
| Test strategy | Per-kind builder and UI suites | Declaration guards, compiler matrix, golden round trips, generic UI states and one end-to-end spec per cardinality including pulse and span | More framework tests, fewer repeated cap-card tests |
| Per-kind UX nuance | Maximum | Declaration-driven controls, including span timeout and optional cooldown, and pulse debounce | A fact the authority does not store is not a control. The escape is a declared apply authority, not a conditional in the generic renderer |

### Estimated code movement

First-phase candidates currently occupy approximately:

- 941 UI lines: battery, consumables/default rows and running cards;
- 255 running builder lines;
- part of the 243-line shared preset builder;
- approximately 1,329 direct UI/type test lines before shared preset tests.

Expected additions:

- 250–350 lines for declaration types, codegen projection and guards;
- 250–350 lines for draft schema, compiler, decoder and assignment-status
  projection;
- 450–650 lines for the generic cards and source/transform flow;
- 800–1,100 lines of focused compiler, compatibility and UI tests.

Scalar plus keyed-array is close to production-line neutral on its own. Pulse
and span are in scope because each is the other's second consumer: doorbell's
394 lines and motion's 443 lines move in the event phase, after the golden
round trip covers both stored shapes. The payoff is one card family and the
next cap's cost.

## 9. Test strategy

### Declaration and codegen

- A guard enumerates every `customize` target and rejects missing paths,
  incompatible transforms, item-array drift, missing vocabulary and widened
  device types.
- Generated catalog snapshots prove Zod schemas do not cross the wire and
  source/output kinds are preserved.
- Each worked declaration has a focused cap spec.

### Compiler and compatibility

- Table-driven tests compile every source/transform pair.
- Invalid units, enum members, thresholds, dwell values, scale and clamps are
  refused by name.
- Golden current battery, consumables, running and doorbell features, plus the
  motion `cameraSensors` write, decode into drafts and recompile to the same
  normalized value. UI card states for all five are frozen beside them.
- A noncanonical expression decodes as `advanced`, is displayed, and is never
  removed by the generic card.
- Removing one keyed item preserves every other item byte-for-byte.
- Disarm checks replace the generic compiler output with a wrong field or
  transform and prove the relevant test fails.

### Evaluator

The composer is reused, so existing composition tests remain the primary
runtime proof:

- source push recomputes without polling;
- failed read holds stale state;
- confirmed loss releases a replacement to native;
- added nullable output becomes null;
- dwell arms one deadline;
- keyed history uses item key;
- running events observe the merged effective slice;
- event high-water prevents replay.

Add one end-to-end existing-target spec per cardinality using the generated
declaration compiler, not hand-built compositions.

### UI

- Descriptor-driven card ordering and applicability.
- `pending`, `unknown`, `absent`, native, assigned, stale and released renders.
- Device → field → transform flow and pushed preview.
- Same-room devices are suggested but never selected automatically.
- Wrong-unit numeric fields are not offered for running.
- Keyed item add/remove preserves unrecognized rows.
- Phone sheet layout and sticky actions.
- `npm run ui:check` on every changed UI file.
- Before/after `ui:shots` in light/dark at 1440×900, 390×844 and 320×640,
  with the PNGs inspected.

### Live verification

For implementation, use one device per migrated kind:

1. observe native value and `source: native`;
2. save an assignment and change the source;
3. observe value and history follow, with `source: assigned`;
4. make the source unreadable and confirm stale/null semantics;
5. remove the assignment and confirm exact native restoration;
6. restart the composer and confirm the stored assignment is still readable.

Running additionally proves start/finish events occur once around a real
threshold/dwell transition. Consumables proves history remains scoped by item
key.

## 10. Phased implementation plan

| Phase | Work | Effort | Cut line |
| --- | --- | ---: | --- |
| 0. Characterize | Freeze current battery, consumables, running-state and doorbell compositions, the motion `cameraSensors` write, and the five UI card states under `packages/types/src/composition/customize/__fixtures__/`. Round-trip harness: decode → draft → compile → identical normalized value. No behaviour change. | 1–2 days | Required |
| 1. Contract and catalog | Add `CapabilityCustomizeSpec` (`scalar`, `keyedArray`, `event` with `pulse` and `span`), codegen projection, path/type/vocabulary guard, `OverrideDraft` schema and assignment-status shape. Declare battery and running-state only. | 2–3 days | Required |
| 2. Scalar compiler | Compile/decode identity, invert, threshold+dwell, linear and companions. Battery and running declarations drive it. Reuse current UI initially behind descriptor adapters. | 3–4 days | Required for useful release |
| 3. Generic scalar UI | Replace battery and running cards with the generic card/dialog/preview. Preserve Advanced handling and exact stored shapes. | 3–4 days | Required for the UI payoff |
| 4. Keyed arrays | Add keyed item descriptor/compiler/UI; migrate consumables and preserve native read-only rows, kind/form and D917 history. | 4–5 days | Can ship scalar-only first |
| 5. Events | Pulse compiler and span apply. Migrate doorbell onto the canonical `rose` / `count` feature with the same debounce and high-water. Migrate motion onto `setCameraSensors` plus `motionCooldownMs`, including per-source mode and the authority's status rows. Declarations land in this phase. | 4–6 days | Required. The second consumer is motion; doorbell is not a pilot |
| 6. Cleanup and enforcement | Delete all five migrated cards and builders, remove hard-coded availability branches, add "declared target needs no bespoke card" guard, update architecture and generated references. | 1–2 days | Required before calling migration complete |

Scalar plus keyed-array is approximately 14–20 engineering days including
tests and UI verification. A scalar-only checkpoint is approximately 9–13
days. The event phase adds 4–6 days and is part of the same design: pulse and
span each justify the other. There is no leftover "keep bespoke" phase.

## 11. Final decision

Proceed with the full generic design, including events:

1. Generic, cap-declared scalar assignments.
2. Generic, cap-declared keyed-array assignments with native arrays read-only.
3. Generic `event` assignments with two shapes: `pulse` (doorbell) and `span`
   (motion).
4. Existing composer, claims, history and event paths for composition claims.
   Motion's apply is the camera-sensor authority and the camera's
   `motionCooldownMs`, not a new evaluator.
5. Same stored composition format, and the same `cameraSensors` document. No
   migration code and no second store.
6. Nothing stays a bespoke Customize card.

Facts checked before dropping the bespoke exception:

- Doorbell is a pulse. `doorbell.cap.ts` documents `onPressed` as a pulse with
  no release; `fromState` advances `lastPressedAt`; `buildDoorbellCompositionFeature`
  emits `latest(rose(...))` and `count(lastPressedAt)` with a 2 s debounce.
  High-water is the composer's advance mark (D670), not a runtime field.
- Motion is a span on `onMotionChanged`. `CameraSensorsConfigSchema` stores
  only the sensor list and per-source mode (`in-addition`, `confirm`,
  `replace`). The card writes that list through `setCameraSensors`. Timeout
  is `motionCooldownMs` on the pipeline-runner config (default 30 s).
  `maxSessionHoldMs` and `MOTION_CLOSE_AFTER_MS` are orchestrator bounds
  (D672 rules 9 and 12), not operator fields on this write, so the motion
  span declares no `cooldownMs`.
- Claiming `motion.detected` would be a second authority beside the
  orchestrator (D62, D672). The span's apply is the existing write.
- An unread sensor list must not be written (D49). A pre-CS-2 orchestrator
  that cannot accept the write offers no control (D676). The cap is eight
  sensors, and a camera cannot be a sensor (D672 rule 5). Those stay gates
  of the authority.
- Source readiness, `notForwarded` and `notEnforced` are fields of
  `CameraSensorsStatus`. The span card shows them; it does not own them.

What stays outside this mechanism, because a checked fact says it is a
different authority rather than an event, a scalar or a keyed array:

- Identity writes name, room, hidden and role.
- Numeric self-transforms rewrite the device's own field.
- Linked devices write the D648 `linked-devices` slot.

Those three are not Customize overrides of a cap target. They are not bespoke
copies of this card.
