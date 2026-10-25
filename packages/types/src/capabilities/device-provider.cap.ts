import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { SourceInfoSchema } from '../device/source-info.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

const ProviderStatusSchema = z.object({
  connected: z.boolean(),
  deviceCount: z.number(),
  error: z.string().optional(),
  /**
   * `'orchestrator'`: this provider writes NO camera's `motion` runtime slice
   * — the orchestrator is its only writer (D696). Set by `BaseDeviceProvider`,
   * which every provider bundles, so only a provider BUILT from D696-amended
   * code says it. ABSENT means an older provider that may still write it (raw
   * VMD writes, a boot seed), and the orchestrator's provider gate keeps that
   * provider's cameras unwritten (`camera-sensors/motion-slice-provider-gate.ts`)
   * — the provider twin of the runner's `getLocalLoad().motionSliceWriter`.
   */
  motionSliceWriter: z.literal('orchestrator').optional(),
})

const DiscoveredDeviceSchema = z.object({
  externalId: z.string(),
  name: z.string(),
  type: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

/**
 * Candidate handed back from discovery and accepted by
 * `adoptDiscoveredDevice`. Shape mirrors the in-process
 * `DiscoveredDevice` interface used by `DeviceDiscovery`.
 */
const DiscoveryCandidateSchema = z.object({
  stableId: z.string(),
  type: z.enum(DeviceType),
  suggestedName: z.string(),
  prefilledConfig: z.record(z.string(), z.unknown()),
  /**
   * Optional upstream-system identity (HA entity_id, vendor MAC, …).
   * Discovery pre-populates this for systems that know the upstream
   * identity ahead of adoption. Rendering metadata (unit, precision)
   * flows live through the cap STATUS SLICE after adoption.
   */
  sourceInfo: SourceInfoSchema.optional(),
  /**
   * Set when this candidate is a device the provider ALREADY owns.
   *
   * A scan cannot generally produce the identity a device was onboarded under
   * (Reolink keys on `mac-<mac>`, learned at adopt time), so a stableId
   * comparison never matches and an owned device looks addable. Re-adopting one
   * overwrites its config with scan-derived values — that is how a Home Hub's
   * Baichuan port was overwritten with its ONVIF port, taking the hub and its
   * three child cameras offline for four hours.
   *
   * A provider that can recognise its own devices says so here. Absent means
   * "not recognised", which is not the same as "known to be new" — a provider
   * that cannot tell simply never sets it.
   */
  alreadyOnboarded: z.boolean().optional(),
  /** Numeric id of the device this candidate was matched to. Set with `alreadyOnboarded`. */
  onboardedDeviceId: z.number().optional(),
  /** Operator-facing name of the matched device, so the UI can say WHICH one it is. */
  onboardedName: z.string().optional(),
})

/**
 * Flat device summary returned by `createDevice` / `adoptDiscoveredDevice`.
 * Mirrors `toDeviceShape()` output in `device-management.router.ts` so the
 * tRPC layer can pass it through without reshaping.
 */
const DeviceSummarySchema = z.object({
  id: z.number(),
  stableId: z.string(),
  addonId: z.string(),
  type: z.string(),
  name: z.string(),
  parentDeviceId: z.number().nullable(),
  online: z.boolean(),
  features: z.array(z.string()),
  config: z.record(z.string(), z.unknown()),
  /** Optional upstream-system identity (dispatch key + system tag).
   *  See `SourceInfo`. Present when the device has a non-synthetic
   *  source identifier (HA entities, vendor MAC, …); omitted when the
   *  synthetic backfill is in effect. */
  sourceInfo: SourceInfoSchema.optional(),
})

/**
 * Result of a live field test (e.g. probing an RTSP URL during device
 * creation). Matches the UI-side `FieldProbeResult` in
 * `interfaces/config-ui.ts` — the admin `FormBuilder` renders the
 * returned `labels` as chips next to the input.
 */
const FieldProbeResultSchema = z.object({
  status: z.enum(['ok', 'error']),
  labels: z.array(z.string()).optional(),
  error: z.string().optional(),
})

/**
 * The output of `getChildCreationSchema` is a UI schema tree. We store
 * it as `unknown` at the capability layer — the router just passes it
 * through and the admin UI renders it via `FormBuilder`. The actual
 * type is `ConfigUISchema` (see `packages/types/src/interfaces/config-ui.ts`),
 * but we deliberately avoid a Zod mirror because the union is large and
 * not meant for runtime validation at this seam.
 */
const CreationSchemaOutputSchema = z.unknown()

export const deviceProviderCapability = {
  name: 'device-provider',
  scope: 'system',
  mode: 'collection',
  methods: {
    // ── Lifecycle + introspection ─────────────────────────────────────
    start: method(z.void(), z.void(), { kind: 'mutation' }),
    stop: method(z.void(), z.void(), { kind: 'mutation' }),
    getStatus: method(z.void(), ProviderStatusSchema),
    getDevices: method(
      z.void(),
      z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          type: z.string(),
        }),
      ),
    ),

    /**
     * Tear down and reconstruct ONE device in place from its persisted rows —
     * touching no other device this provider owns.
     *
     * The primitive `deviceManager.migrateDevice` uses to flush the two
     * migrated numbers: after `swapIds` the runner's live instance still
     * carries the PRE-swap numeric id (baked into the object, its native-cap
     * registrations and its log tags), and a live object cannot be renumbered.
     * Before this method the only flush was restarting the whole owning addon
     * — which took every camera the provider owns down with it (28 devices
     * for one migrated camera, measured 2026-09-04, and the morning of the
     * same day ~27 devices' native caps did not come back on their own).
     *
     * Keyed by `stableId`, deliberately: the numeric id is exactly the thing
     * that changes. The reply carries the id the device answers on NOW.
     * Implemented once in `BaseDeviceProvider` — decommission the live
     * instance (if any), then re-create from the persisted row: the same
     * teardown/rehydrate pair every graceful shutdown + boot already uses.
     * An RPC, never an event: a dropped event would leave the runner writing
     * against the wrong camera (D8).
     *
     * Construction can dial hardware, and the migrated source is
     * characteristically dead — the timeout covers a full activate window
     * rather than the 60 s default.
     */
    reloadDevice: method(z.object({ stableId: z.string() }), z.object({ deviceId: z.number() }), {
      kind: 'mutation',
      timeoutMs: 3 * 60_000,
    }),

    // ── Discovery + adoption (optional — see supportsDiscovery) ──────
    supportsDiscovery: method(z.object({}), z.boolean()),
    /**
     * Run a network scan. `params` carries optional provider-specific scan
     * inputs (e.g. a broadcast address / subnet for cross-subnet discovery),
     * shaped by `getDiscoveryParamsSchema`. Omitted for the generic scan
     * (provider uses its local-network default).
     */
    discoverDevices: method(
      z.object({ params: z.record(z.string(), z.unknown()).optional() }),
      z.array(DiscoveryCandidateSchema),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Optional form schema (`ConfigUISchema`) for the EXTRA per-scan inputs a
     * provider accepts (e.g. Gree's broadcast address for a different subnet).
     * `null` when the provider takes no extra scan params — the generic
     * aggregated scan never renders this; the per-integration scan does.
     */
    getDiscoveryParamsSchema: method(z.object({}), CreationSchemaOutputSchema),
    /**
     * The DeviceType this provider creates via manual add (Camera for
     * Reolink/ONVIF, Container for Gree, Hub for Ecowitt). `null` when the
     * provider does not support manual creation. Lets the Add-Device dialog
     * pick the right type instead of assuming Camera.
     */
    getManualCreationType: method(
      z.object({}),
      z.object({ deviceType: z.enum(DeviceType).nullable() }),
    ),
    adoptDiscoveredDevice: method(
      z.object({ candidate: DiscoveryCandidateSchema }),
      DeviceSummarySchema,
      { kind: 'mutation', auth: 'admin' },
    ),

    // ── Manual creation (optional — see supportsManualCreation) ──────
    supportsManualCreation: method(z.object({}), z.boolean()),
    /**
     * Fetch the creation form schema for a given DeviceType. Returns
     * `null` when the provider does not support manually creating
     * devices of that type. The output is a `ConfigUISchema` — the
     * router type-asserts it at the boundary.
     */
    getChildCreationSchema: method(
      z.object({ type: z.enum(DeviceType) }),
      CreationSchemaOutputSchema,
    ),
    createDevice: method(
      z.object({
        type: z.enum(DeviceType),
        config: z.record(z.string(), z.unknown()),
      }),
      DeviceSummarySchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Test a single field in the creation form before the device has
     * been persisted. Typical use: probing an RTSP URL entered by the
     * user. Providers that don't support field probing return
     * `{ success: true, message: 'Field test not supported' }`.
     *
     * `formValues` is the live snapshot of every field in the form at
     * the moment the user clicked Test — useful for probes that depend
     * on multiple fields together (e.g. Reolink autodetect needs host
     * + credentials + UID + transport mode in a single call). Optional
     * for backwards compatibility; providers free to ignore it.
     */
    testCreationField: method(
      z.object({
        type: z.enum(DeviceType),
        key: z.string(),
        value: z.unknown(),
        formValues: z.record(z.string(), z.unknown()).optional(),
      }),
      FieldProbeResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IDeviceProvider = InferProvider<typeof deviceProviderCapability>

export {
  DeviceSummarySchema,
  DiscoveredDeviceSchema,
  DiscoveryCandidateSchema,
  FieldProbeResultSchema,
  ProviderStatusSchema,
}
