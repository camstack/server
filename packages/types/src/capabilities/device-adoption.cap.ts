import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { SourceInfoSchema } from '../device/source-info.js'
import type { SourceInfo } from '../device/source-info.js'

/**
 * `device-adoption` — generic discovery + adoption surface,
 * system-scoped collection (one provider per integration addon), routed
 * by explicit `{ addonId }` on direct `deviceAdoption.*` calls — the same
 * pin model as `connection-test`. The admin UI keeps using
 * `deviceManager.adoption*` (which already threads `addonId`). The de-HA-ified
 * successor to `ha-discovery`:
 * keyed by `integrationId` (the addon resolves integrationId → broker
 * internally) rather than a connection-specific `brokerId`, and it
 * OWNS the shared `DiscoveredChildDevice` candidate type
 * (declared below) so a single shared adoption modal renders any integration's
 * candidate tree.
 *
 * UI flow (Integrations page → integration detail):
 *   1. `listCandidates({integrationId, page, pageSize, filter})` →
 *      paginated candidate list, each row collapsed.
 *   2. User expands a row → `getCandidate({integrationId,
 *      childNativeId})` returns the single candidate (with its nested
 *      `children`) for the accordion render.
 *   3. User clicks "Adopt" on one or more candidates →
 *      `adopt({integrationId, childNativeIds, perCandidate?})`
 *      materialises one parent CamStack device per candidate plus its
 *      accessory children. `perCandidate[childNativeId]` carries an
 *      optional display-name override + a `hiddenChildIds` pre-hide set
 *      (the parent's `accessories.hiddenChildIds` gates UI visibility).
 *   4. User clicks "Release" → `release({integrationId, camDeviceId})`
 *      removes the parent + every child from the kernel registry.
 */

/**
 * Status enum for a discovered device. Generic enough for
 * battery cams, awake cams, and unreachable cams alike.
 */
export const DiscoveredChildStatusSchema = z.enum(['online', 'sleeping', 'offline', 'unknown'])
export type DiscoveredChildStatus = z.infer<typeof DiscoveredChildStatusSchema>

/**
 * Explicit type for the (now self-referential) discovered-child entry.
 * A `z.lazy` schema cannot cleanly self-infer, so the shape is declared
 * here and the schema below is annotated with it. The `children` /
 * `sourceInfo` / `capabilities` / `features` fields are optional: Flat
 * enumerations (an NVR listing camera channels) omit them entirely;
 * integrations (Home Assistant previewing a device with entity-children)
 * populate them so the shared adoption modal can render an accordion.
 */
export type DiscoveredChildDevice = {
  childNativeId: string
  name: string
  type: DeviceType
  status: DiscoveredChildStatus
  metadata: {
    model?: string
    serialNumber?: string
    uid?: string
    mac?: string
    rtspChannel?: number
    isBattery?: boolean
    isDoorbell?: boolean
    isMultifocal?: boolean
    externalLocation?: string
    manufacturer?: string
    integration?: string
  }
  alreadyAdopted: boolean
  adoptedDeviceId: number | null
  // ── Shared adoption fields (optional; flat enumerations omit, integrations populate) ──
  capabilities?: readonly string[]
  features?: readonly string[]
  sourceInfo?: SourceInfo
  children?: readonly DiscoveredChildDevice[]
  /** `childNativeId` of the gateway candidate (in the same list) this device sits behind. */
  parentStableId?: string
}

export const DiscoveredChildDeviceSchema: z.ZodType<DiscoveredChildDevice> = z.lazy(() =>
  z.object({
    /** Stable, integration-defined identifier. Must be unique per parent and persistent across reboots. */
    childNativeId: z.string(),
    /** Friendly name as reported by the source (Reolink camera name, ONVIF profile, ...). */
    name: z.string(),
    /** DeviceType the child should be created with on adopt. */
    type: z.enum(DeviceType),
    status: DiscoveredChildStatusSchema,
    /** Free-form integration-specific metadata surfaced in the adoption modal. */
    metadata: z
      .object({
        model: z.string().optional(),
        serialNumber: z.string().optional(),
        uid: z.string().optional(),
        /** The device's hardware MAC, any separator or case. The Add device list matches it to a
         *  scan hit's `sourceInfo.uniqueId`, so one physical device is one row. */
        mac: z.string().optional(),
        /** Reolink: 0-based channel index inside the parent NVR. */
        rtspChannel: z.number().int().nonnegative().optional(),
        isBattery: z.boolean().optional(),
        isDoorbell: z.boolean().optional(),
        isMultifocal: z.boolean().optional(),
        externalLocation: z.string().optional(),
        /** Vendor / manufacturer name as reported by the source (HA device
         *  `manufacturer`, …). Surfaced in the adoption modal's fuzzy search. */
        manufacturer: z.string().optional(),
        /** Integration / platform domain the candidate belongs to (HA
         *  `entity_registry.platform`, e.g. `dreame_vacuum`). Surfaced in the
         *  adoption modal's fuzzy search. */
        integration: z.string().optional(),
      })
      .default({}),
    /**
     * `true` when the framework already created a child device for this
     * `childNativeId` under the current parent. The adoption modal uses it to
     * gate the Add/Remove button and surface the existing `deviceId`.
     */
    alreadyAdopted: z.boolean(),
    /** When `alreadyAdopted=true`, the framework-assigned child device id. */
    adoptedDeviceId: z.number().int().nonnegative().nullable(),
    /** Capability names the candidate advertises — integrations populate, flat enumerations omit. */
    capabilities: z.array(z.string()).readonly().optional(),
    /** Feature flags the candidate advertises — integrations populate, flat enumerations omit. */
    features: z.array(z.string()).readonly().optional(),
    /** Upstream-system identity + rendering hints for the candidate. */
    sourceInfo: SourceInfoSchema.optional(),
    /** Nested entity-children for accordion preview — integrations populate, flat enumerations omit. */
    children: z.array(DiscoveredChildDeviceSchema).readonly().optional(),
    /** `childNativeId` of the gateway candidate in the same list this device sits behind. */
    parentStableId: z.string().optional(),
  }),
)

/**
 * Provider-declared discovery *granularity* filter (the keystone of the
 * single-entity-import design). A provider advertises which discovery
 * granularities it supports via `listCandidateFilters`; the operator picks
 * one and it is passed back as the opaque `filter` string on
 * `listCandidates`/`adopt`.
 *
 * - **`id`** is provider-defined and OPAQUE to the cap + UI layers — only the
 *   declaring provider interprets it. The reserved id `'devices'` is the
 *   universal default (every provider's current behavior IS the `devices`
 *   filter). A provider that declares no filters is treated as a single
 *   implicit `{ id:'devices', label:'Devices', isDefault:true }`.
 * - **`label`** is the human label for the UI selector.
 * - **`isDefault`** marks the default filter; exactly one SHOULD be default.
 */
export const AdoptionFilterSchema = z.object({
  id: z.string(),
  label: z.string(),
  isDefault: z.boolean().optional(),
})
export type AdoptionFilter = z.infer<typeof AdoptionFilterSchema>

/**
 * Candidate-list TEXT/query filter. Mirrors the prior `ha-discovery` filter,
 * de-HA-ified — `area` / `manufacturer` stay free-form strings so any
 * integration can populate them from its own metadata. Distinct from the
 * granularity `AdoptionFilter` above: this narrows the candidate set within a
 * chosen granularity, whereas the granularity `filter` selects WHAT a
 * candidate is (a device vs an entity).
 */
export const CandidateQueryFilterSchema = z.object({
  /** Substring filter on name + manufacturer + model. */
  search: z.string().optional(),
  /** Area-name exact match. */
  area: z.string().optional(),
  /** Manufacturer exact match. */
  manufacturer: z.string().optional(),
  /** When true, only return candidates the operator already adopted. */
  adoptedOnly: z.boolean().optional(),
  /** When true, only return candidates the operator hasn't adopted yet. */
  unadoptedOnly: z.boolean().optional(),
})

export const ListCandidatesInputSchema = z.object({
  integrationId: z.string(),
  page: z.number().int().positive().default(1),
  // Pagination is client-side in the adoption UI: the modal fetches the whole
  // candidate set in one page and the shared list paginates locally. The cap
  // stays high enough to return every candidate at once. The large case is the
  // HA `entities` granularity — one HA device maps to many entities, so an
  // install can expose several thousand candidates; the ceiling is sized for it.
  pageSize: z.number().int().positive().max(20000).default(50),
  /**
   * Optional provider-declared discovery GRANULARITY id (opaque; see
   * `AdoptionFilterSchema`). Omitted = the reserved `'devices'` granularity =
   * exactly the pre-existing behavior (fully back-compatible).
   */
  filter: z.string().optional(),
  /** Optional candidate-list text/query narrowing within the granularity. */
  filterText: CandidateQueryFilterSchema.optional(),
})
export const ListCandidatesOutputSchema = z.object({
  candidates: z.array(DiscoveredChildDeviceSchema).readonly(),
  totalCount: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
})

export const GetCandidateInputSchema = z.object({
  integrationId: z.string(),
  childNativeId: z.string(),
})

/**
 * How an integration instance turns its discovered candidates into devices.
 * `manual` (the default) adopts only what the operator picks; `auto` has the
 * DEVICE MANAGER adopt every candidate that is not adopted and not tombstoned
 * after each discovery refresh (D1090). A provider can declare `auto` as the
 * instance default (`AdoptionStatus.defaultAdoptMode`) but never adopts itself.
 */
export const AdoptModeSchema = z.enum(['manual', 'auto'])
export type AdoptMode = z.infer<typeof AdoptModeSchema>

/** Who started the adoption of a device: a person's pick, or the `auto` mode. */
export const AdoptedBySchema = z.enum(['operator', 'auto'])
export type AdoptedBy = z.infer<typeof AdoptedBySchema>

/**
 * Whether the source still lists an adopted device. `withdrawn` means the
 * source ANSWERED (3 confirmed discoveries in a row) and no longer lists it —
 * distinct from offline. The device is kept with its history (D1090). Only
 * candidates adopted without a filter are counted; one adopted under a filter
 * keeps its state.
 */
export const AdoptionStateSchema = z.enum(['offered', 'withdrawn'])
export type AdoptionState = z.infer<typeof AdoptionStateSchema>

/**
 * What the device manager remembers about one adopted candidate (D1090): who
 * adopted it, whether the source still offers it, and since when it does not.
 * One row per (addonId, integrationId, childNativeId, filter).
 */
export const AdoptionRecordSchema = z.object({
  addonId: z.string(),
  integrationId: z.string(),
  childNativeId: z.string(),
  /** The granularity the candidate was adopted under; absent = the default `devices`. */
  filter: z.string().optional(),
  /** The parent CamStack device the adoption created. */
  deviceId: z.number().int().nonnegative(),
  adoptedBy: AdoptedBySchema,
  adoptedAt: z.number().int().nonnegative(),
  adoptionState: AdoptionStateSchema,
  /** When the device became `withdrawn`; null while `offered`. */
  withdrawnSince: z.number().int().nonnegative().nullable(),
  /** Consecutive counted discoveries that did not list the candidate. */
  missedDiscoveries: z.number().int().nonnegative(),
  /** When the last miss was counted; null while none is. */
  lastMissAt: z.number().int().nonnegative().nullable(),
  /** The operator released the device through `adoptionRelease`. */
  released: z.boolean(),
})
export type AdoptionRecord = z.infer<typeof AdoptionRecordSchema>

/** Confirmed discoveries without a candidate before its device is `withdrawn`. */
export const ADOPTION_WITHDRAW_AFTER_MISSES = 3

/**
 * A miss counts only when this long has passed since the candidate's last
 * COUNTED miss, so pressing Refresh three times in a row withdraws nothing
 * (10 minutes).
 */
export const ADOPTION_MISS_MIN_SPACING_MS = 10 * 60 * 1000

export const AdoptionStatusSchema = z.object({
  /** The instance default a provider declares; the device manager applies it
   *  only when the operator has not stored a mode. Omitted = `manual`. */
  defaultAdoptMode: AdoptModeSchema.optional(),
  /** Last refresh timestamp (ms epoch) — null when never refreshed. */
  lastDiscoveryAt: z.number().int().nonnegative().nullable(),
  /** Count of candidates in the discovery cache. */
  candidateCount: z.number().int().nonnegative(),
  /** Count of candidates the operator has already adopted. */
  adoptedCount: z.number().int().nonnegative(),
  /** Last error message from a refresh attempt. */
  lastError: z.string().nullable(),
})

const PerCandidateSchema = z.object({
  /** Override the default display name for this candidate's parent. */
  name: z.string().min(1).optional(),
  /** Pre-hide a subset of entity-children — created (state still flows)
   *  but listed in the parent's `accessories.hiddenChildIds`. */
  hiddenChildIds: z.array(z.string()).optional(),
})
export const AdoptInputSchema = z.object({
  integrationId: z.string(),
  /**
   * Candidate native ids to adopt. Their MEANING is filter-relative: under the
   * default `'devices'` granularity these are device-native ids; under a
   * provider-declared granularity (e.g. HA `'entities'`) they are that
   * granularity's native ids (e.g. entity ids). The field name is kept stable
   * to avoid a breaking rename.
   */
  childNativeIds: z.array(z.string()).min(1),
  /**
   * Optional provider-declared discovery GRANULARITY id (opaque; see
   * `AdoptionFilterSchema`). Omitted = the reserved `'devices'` granularity =
   * exactly the pre-existing behavior (fully back-compatible).
   */
  filter: z.string().optional(),
  /** When true, import each adopted device's source-system location (e.g. HA
   *  area) into CamStack — fuzzy-match an existing location or create it, then
   *  assign. Omitted/false = no location work (back-compat). */
  importLocations: z.boolean().optional(),
  perCandidate: z.record(z.string(), PerCandidateSchema).optional(),
})
export const AdoptResultSchema = z.object({
  adopted: z
    .array(
      z.object({
        childNativeId: z.string(),
        parentDeviceId: z.number().int().nonnegative(),
        accessoryDeviceIds: z.array(z.number().int().nonnegative()).readonly(),
      }),
    )
    .readonly(),
})

export const ReleaseInputSchema = z.object({
  integrationId: z.string(),
  /** Parent CamStack device id (NOT an accessory child id). Removing
   *  the parent cascades into every accessory. */
  camDeviceId: z.number().int().nonnegative(),
})

export const ResyncInputSchema = z.object({
  /** Parent CamStack device id of an adopted device. The provider resolves its
   *  source (integration/broker + native id) and re-aligns the device's
   *  structural spec (type/role/capabilities/units) with the live mapping,
   *  rebuilding any child whose class changed while preserving operator edits. */
  camDeviceId: z.number().int().nonnegative(),
  /** "Resync from zero" (#19). When true, the kernel PURGES every accessory
   *  child of `camDeviceId` BEFORE the provider re-derives the device, so the
   *  children are rebuilt fresh from source — correct names, coords, and units —
   *  instead of being preserved by the incremental reconcile. Use to recover from
   *  legacy generic/placeholder names that the normal name-precedence keeps frozen
   *  (the operator's explicit reset). Push-driven integrations (no-op resync)
   *  rebuild on their next snapshot; pull/command integrations rebuild in `resync`.
   *  Operator edits on the PARENT (its name, layout, primary-child pick) survive —
   *  only the children are torn down. Omitted/false ⇒ the normal incremental
   *  re-sync that preserves children. */
  resetToSource: z.boolean().optional(),
})
export const ResyncResultSchema = z.object({
  /** True when the persisted spec actually changed (children may have been rebuilt). */
  changed: z.boolean(),
  /** Number of child devices rebuilt into a new class by this re-sync. */
  rebuiltChildren: z.number().int().nonnegative(),
  /** Number of accessory children torn down by a `resetToSource` purge before the
   *  provider re-derived the device. 0/absent for a normal incremental re-sync. */
  removedChildren: z.number().int().nonnegative().optional(),
})

export const deviceAdoptionCapability = {
  name: 'device-adoption',
  scope: 'system',
  mode: 'collection',
  status: { schema: AdoptionStatusSchema, kind: 'poll' },
  methods: {
    /** The filters an integration offers to narrow its discovered candidates. */
    listCandidateFilters: method(
      z.object({ integrationId: z.string() }),
      z.object({ filters: z.array(AdoptionFilterSchema) }),
      { auth: 'admin' },
    ),
    /** List the devices an integration has discovered and that can be adopted. */
    listCandidates: method(ListCandidatesInputSchema, ListCandidatesOutputSchema, {
      auth: 'admin',
    }),
    /** Fetch one discovered candidate; null when unknown. */
    getCandidate: method(GetCandidateInputSchema, DiscoveredChildDeviceSchema.nullable(), {
      auth: 'admin',
    }),
    /** Rescan an integration for new candidates and report the adoption status. */
    refresh: method(z.object({ integrationId: z.string() }), AdoptionStatusSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Adopt a discovered candidate as a device. */
    adopt: method(AdoptInputSchema, AdoptResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Release an adopted device back to the candidate list. */
    release: method(ReleaseInputSchema, z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Re-read an adopted device from the integration and reconcile it. */
    resync: method(ResyncInputSchema, ResyncResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
  vocabulary: {
    notOperatorFacing: 'device adoption — an onboarding flow, not an action',
  },
} as const satisfies CapabilityDefinition

export type IDeviceAdoptionProvider = InferProvider<typeof deviceAdoptionCapability>
export type AdoptionStatus = z.infer<typeof AdoptionStatusSchema>
