import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DiscoveredChildDeviceSchema } from './device-discovery.cap.js'

/**
 * `device-adoption` — generic discovery + adoption surface,
 * system-scoped collection (one provider per integration addon), routed
 * by explicit `{ addonId }` on direct `deviceAdoption.*` calls — the same
 * pin model as `connection-test`. The admin UI keeps using
 * `deviceManager.adoption*` (which already threads `addonId`). The de-HA-ified
 * successor to `ha-discovery`:
 * keyed by `integrationId` (the addon resolves integrationId → broker
 * internally) rather than a connection-specific `brokerId`, and it
 * REUSES the shared `DiscoveredChildDevice` candidate type from
 * `device-discovery.cap.ts` so a single shared adoption panel renders
 * any integration's candidate tree.
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

export const AdoptionStatusSchema = z.object({
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
    listCandidateFilters: method(
      z.object({ integrationId: z.string() }),
      z.object({ filters: z.array(AdoptionFilterSchema) }),
      { auth: 'admin' },
    ),
    listCandidates: method(ListCandidatesInputSchema, ListCandidatesOutputSchema, {
      auth: 'admin',
    }),
    getCandidate: method(GetCandidateInputSchema, DiscoveredChildDeviceSchema.nullable(), {
      auth: 'admin',
    }),
    refresh: method(z.object({ integrationId: z.string() }), AdoptionStatusSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    adopt: method(AdoptInputSchema, AdoptResultSchema, { kind: 'mutation', auth: 'admin' }),
    release: method(ReleaseInputSchema, z.void(), { kind: 'mutation', auth: 'admin' }),
    resync: method(ResyncInputSchema, ResyncResultSchema, { kind: 'mutation', auth: 'admin' }),
  },
} as const satisfies CapabilityDefinition

export type IDeviceAdoptionProvider = InferProvider<typeof deviceAdoptionCapability>
export type AdoptionStatus = z.infer<typeof AdoptionStatusSchema>
