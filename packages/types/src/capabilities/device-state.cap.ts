import { z } from 'zod'
import { type CapabilityDefinition, method, event } from './capability-definition.js'

/**
 * Per-field ownership (D663). A composition may CLAIM fields of a native
 * cap's runtime-state slice on an existing device: `replace` overlays the
 * claimed fields on the native slice, `add` builds a slice the device does
 * not natively have. Declared here — once — so the hub mirror (Task 5) and
 * the claim methods (Task 6) share one union.
 */
export const FieldClaimModeSchema = z.enum(['replace', 'add'])
export type FieldClaimMode = z.infer<typeof FieldClaimModeSchema>

/** What a claim, patch or release answers. A refusal always names its reason. */
export const ClaimOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), changed: z.boolean() }),
  z.object({
    ok: z.literal(false),
    code: z.enum([
      'owned-by-other',
      'not-claimed',
      'field-not-claimed',
      'invalid-slice',
      'unknown-device',
      /** The device's row could not be read (D49): the answer is UNKNOWN — never "released", never "not claimed". */
      'row-unreadable',
      /**
       * A migration of this device is in flight: its row is about to be swapped
       * with another device's, and a claim written now would travel with the
       * wrong hardware. Refused, never queued — retry once the migration is over.
       */
      'migration-in-flight',
    ]),
    message: z.string(),
  }),
])
export type ClaimOutcome = z.infer<typeof ClaimOutcomeSchema>

/** One claim as `listClaims` reports it. `fields` is the PLANNED set, explicit (ruling S5). */
export const FieldClaimSchema = z.object({
  deviceId: z.number(),
  capName: z.string(),
  owner: z.string().min(1),
  mode: FieldClaimModeSchema,
  fields: z.array(z.string().min(1)).min(1),
})
export type FieldClaim = z.infer<typeof FieldClaimSchema>

/**
 * What `listClaims` answers. The claims INDEX is a listing projection loaded
 * from the settings store at boot; until a load has succeeded it is
 * `not-loaded`, never `[]` — an unanswered question must not look like an
 * empty answer (D315).
 */
export const ClaimsListingSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('loaded'), claims: z.array(FieldClaimSchema) }),
  z.object({ state: z.literal('not-loaded'), reason: z.string() }),
])
export type ClaimsListing = z.infer<typeof ClaimsListingSchema>

/**
 * `deviceState` — generic, cap-agnostic surface for cross-process
 * access to per-device runtime state. Read pendant for every cap's
 * runtime-state slice + the canonical write entrypoint. Mirrors the
 * in-process `BaseDevice.runtimeState` API:
 *
 *   - `getSnapshot({deviceId})` → full `Record<capName, slice>`.
 *   - `getCapSlice({deviceId, capName})` → one slice.
 *   - `setCapSlice({deviceId, capName, slice})` → unified single-slice
 *     write. Hub validates (when a cap schema is registered),
 *     persists to disk (debounced), updates the mirror, and emits
 *     `onChanged` for that cap.
 *   - `onChanged` event → fires on every slice change.
 *
 * Drivers don't implement this cap directly — the kernel auto-mounts
 * a singleton provider against `device-manager`'s in-hub mirror.
 * Every `setCapState` call on a `BaseDevice.runtimeState` ultimately
 * routes through `setCapSlice` (single cross-layer entrypoint) so
 * UIs / addons subscribe to a single event channel for every
 * cap-state change; per-cap events (`battery.onStatusChanged`, …)
 * remain available for typed consumers but no longer have to be
 * defined on every new cap with runtime state.
 */
export const deviceStateCapability = {
  name: 'device-state',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /** Full state snapshot for one device. Empty object if no
     *  cap-keyed slice has been written yet. */
    getSnapshot: method(
      z.object({ deviceId: z.number() }),
      z.record(z.string(), z.record(z.string(), z.unknown())),
    ),
    /**
     * Single cap slice — the EFFECTIVE one: the merge every consumer sees, null
     * when the slice hasn't been written, the device isn't registered, or a
     * claim HOLDS the cap (D663). Never the native shadow — that is
     * `getNativeCapSlice`, admin-only.
     */
    getCapSlice: method(
      z.object({ deviceId: z.number(), capName: z.string() }),
      z.record(z.string(), z.unknown()).nullable(),
    ),
    /**
     * Whole-system snapshot — every device's full state in one
     * payload. Used by `SystemManager` for warm-boot: a single
     * round-trip populates the client mirror so every subsequent
     * `sm.getDeviceById(id).state.<cap>.value` is sync. Empty inner
     * record for devices that haven't emitted any slice yet.
     */
    getAllSnapshots: method(
      z.object({}),
      z.record(z.string(), z.record(z.string(), z.record(z.string(), z.unknown()))),
    ),

    /**
     * Canonical cross-layer WRITE for one cap-keyed slice. Used by
     * everyone who needs to publish runtime state for a device:
     * device providers (via `BaseDevice.runtimeState.setCapState`
     * which delegates here), system-scope addons (e.g. the orchestrator
     * writing a camera's effective `motion` slice, D696), and
     * direct cap-router callers in tests.
     *
     * Behavior on the hub:
     *   1. Resolve the device — throws if unknown.
     *   2. Diff the slice against the current mirror (no-op on
     *      identical writes — saves disk and event churn).
     *   3. Update the mirror in place.
     *   4. Persist the full per-device blob to disk (debounced).
     *   5. Emit `onChanged` for this cap so subscribers (UI mirror,
     *      SystemManager, per-cap typed listeners) refresh.
     *
     * Schema validation is the caller's responsibility — callers
     * going through `BaseDevice.runtimeState.setCapState` get the
     * cap's `runtimeState` schema enforced in-process before the
     * write reaches here. Direct callers should validate against
     * the cap's schema themselves.
     *
     * No `patch` variant — for shallow merges read the slice via
     * `getCapSlice` first, merge, and write. The single-writer
     * conventions on each cap make atomic-merge semantics
     * unnecessary in practice.
     */
    setCapSlice: method(
      z.object({
        deviceId: z.number(),
        capName: z.string(),
        slice: z.record(z.string(), z.unknown()),
      }),
      z.void(),
      { kind: 'mutation' },
    ),

    // ── Per-field claims (D663) — admin only: a claim rewrites what every
    // consumer reads for a device's field. The row is the merge authority; a
    // claims INDEX (one settings blob, written before the row on a claim and
    // after it on a release) is what `listClaims` and the boot seed read.

    /**
     * Claim `fields` of `capName` on a device for `owner`. The PLANNED field set
     * is explicit (ruling S5): `values` may be partial and MUST be a subset of
     * `fields` (else `field-not-claimed`); a claimed field with no value is HELD,
     * never answered from the native. A re-claim by the same owner REPLACES
     * `fields` and MERGES `values` — a field dropped from `fields` loses its
     * value. Another owner's claim → `owned-by-other`.
     */
    claimFields: method(
      z.object({
        deviceId: z.number(),
        capName: z.string(),
        owner: z.string().min(1),
        mode: FieldClaimModeSchema,
        fields: z.array(z.string().min(1)).min(1),
        values: z.record(z.string(), z.unknown()),
      }),
      ClaimOutcomeSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Write owned values. Every key of `values` must be in the claim's `fields`
     * (`field-not-claimed`); no claim → `not-claimed`; another owner's →
     * `owned-by-other`. Partial patches merge (S5); debounced like a native slice.
     */
    patchOwnedFields: method(
      z.object({
        deviceId: z.number(),
        capName: z.string(),
        owner: z.string().min(1),
        values: z.record(z.string(), z.unknown()),
      }),
      ClaimOutcomeSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Hand the cap back. A `replace` re-emits the native slice exactly as last
     * written; an `add` leaves the mirror. `not-claimed` also removes a stale
     * index entry — the index self-heals through this method.
     */
    releaseClaim: method(
      z.object({ deviceId: z.number(), capName: z.string(), owner: z.string().min(1) }),
      ClaimOutcomeSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Every claim the index lists, optionally those whose owner starts with `ownerPrefix`. */
    listClaims: method(z.object({ ownerPrefix: z.string().optional() }), ClaimsListingSchema, {
      auth: 'admin',
    }),
    /**
     * The NATIVE slice — what the provider wrote, the shadow under a `replace`
     * claim — for the owner's derived reads. Admin-only (D224, ruled in the
     * Task 6 review): the shadow is a second truth beside the merge, and the
     * event channel already refuses it to everyone but the composer; a
     * protected read of it would hand out what the events withhold.
     */
    getNativeCapSlice: method(
      z.object({ deviceId: z.number(), capName: z.string() }),
      z.record(z.string(), z.unknown()).nullable(),
      { auth: 'admin' },
    ),
  },
  events: {
    /**
     * Fires whenever a cap-keyed slice changes. Per-event payload
     * carries the slice that changed — subscribers can render off
     * the payload alone without re-querying. Filterable by `deviceId`
     * via the standard `EventFilter` helpers.
     */
    onChanged: event(
      z.object({
        deviceId: z.number(),
        capName: z.string(),
        slice: z.record(z.string(), z.unknown()),
      }),
    ),
  },
} as const satisfies CapabilityDefinition
