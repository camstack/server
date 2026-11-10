/**
 * `deviceManager.search` — the query behind the device → value picker.
 *
 * One server-side question answers everything a picker draws: which devices
 * can supply a value of the required capability(ies), narrowed by text and by
 * three generic facets, one cursor page at a time, with the facet counts and
 * the live reading of each matching value. The schemas live here (not in the
 * cap file) so the UI model files and the provider import one source; types
 * are `z.infer` of them.
 */
import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { ReadingQuantitySchema } from '../units/quantity.js'

/** Page size when the caller names none, and the ceiling it may ask for. */
export const DEVICE_SEARCH_DEFAULT_LIMIT = 50
export const DEVICE_SEARCH_MAX_LIMIT = 200

export const DeviceSearchRequiresSchema = z.object({
  /** Capability names the field wants a value of. */
  caps: z.array(z.string()).readonly(),
  /** `any` (default): a device with one of them is compatible. `all`: it must hold every one. */
  mode: z.enum(['any', 'all']).optional(),
})
export type DeviceSearchRequires = z.infer<typeof DeviceSearchRequiresSchema>

export const DeviceSearchFiltersSchema = z.object({
  locations: z.array(z.string()).readonly().optional(),
  integrationIds: z.array(z.string()).readonly().optional(),
  types: z.array(z.string()).readonly().optional(),
})
export type DeviceSearchFilters = z.infer<typeof DeviceSearchFiltersSchema>

export const DeviceSearchInputSchema = z.object({
  /** Matches name, location, type, integration (id and label) and id. Case-insensitive. */
  text: z.string().optional(),
  requires: DeviceSearchRequiresSchema.optional(),
  filters: DeviceSearchFiltersSchema.optional(),
  /** List the devices that do not provide the required cap too (greyed, not pickable). */
  includeIncompatible: z.boolean().optional(),
  /** The device the field belongs to: its location drives `suggested`. */
  contextDeviceId: z.number().optional(),
  /**
   * Resolve exactly these devices, regardless of every filter, so a picked
   * value can be rendered. When given, `items` is these devices in the order
   * asked (no paging, `nextCursor` null) and the ones that do not exist are
   * listed in `missingIds`.
   */
  ids: z.array(z.number()).readonly().optional(),
  cursor: z.string().nullable().optional(),
  limit: z.number().int().min(1).max(DEVICE_SEARCH_MAX_LIMIT).optional(),
})
export type DeviceSearchInput = z.infer<typeof DeviceSearchInputSchema>

export const DeviceValueOptionSchema = z.object({
  cap: z.string(),
  /** Status-schema field path inside the cap (same paths as `getWireableFields`). */
  path: z.string(),
  label: z.string(),
  /** The current value as text; `null` when it is unknown or the read FAILED — never `0`. */
  reading: z.string().nullable(),
  unit: z.string().nullable().optional(),
  /** The field's measured quantity, when the cap declares one, so a client can format the reading. */
  quantity: ReadingQuantitySchema.optional(),
})
export type DeviceValueOption = z.infer<typeof DeviceValueOptionSchema>

export const DeviceSearchItemSchema = z.object({
  id: z.number(),
  name: z.string(),
  type: z.enum(DeviceType),
  location: z.string().nullable(),
  integrationId: z.string().nullable(),
  integrationLabel: z.string().nullable(),
  online: z.boolean().nullable(),
  disabled: z.boolean(),
  compatible: z.boolean(),
  /** Only the required caps' fields; empty when nothing was required or the device is incompatible. */
  values: z.array(DeviceValueOptionSchema).readonly(),
})
export type DeviceSearchItem = z.infer<typeof DeviceSearchItemSchema>

export const DeviceSearchFacetValueSchema = z.object({ value: z.string(), count: z.number() })
export type DeviceSearchFacetValue = z.infer<typeof DeviceSearchFacetValueSchema>

export const DeviceSearchFacetIntegrationSchema = z.object({
  id: z.string(),
  label: z.string(),
  count: z.number(),
})
export type DeviceSearchFacetIntegration = z.infer<typeof DeviceSearchFacetIntegrationSchema>

export const DeviceSearchFacetsSchema = z.object({
  locations: z.array(DeviceSearchFacetValueSchema).readonly(),
  integrations: z.array(DeviceSearchFacetIntegrationSchema).readonly(),
  types: z.array(DeviceSearchFacetValueSchema).readonly(),
})
export type DeviceSearchFacets = z.infer<typeof DeviceSearchFacetsSchema>

export const DeviceSearchResultSchema = z.object({
  items: z.array(DeviceSearchItemSchema).readonly(),
  nextCursor: z.string().nullable(),
  /** Devices listed by this query across all pages (filters + text applied; incompatible counted only when `includeIncompatible`). */
  total: z.number(),
  /** Compatible devices after filters + text. */
  compatibleTotal: z.number(),
  /** Every device the caller's fleet holds, before anything is applied. */
  fleetTotal: z.number(),
  /** Incompatible devices after filters + text — the K of "show the K that don't". */
  hiddenIncompatible: z.number(),
  facets: DeviceSearchFacetsSchema,
  /** Same location as `contextDeviceId`; first page only. */
  suggested: z.array(DeviceSearchItemSchema).readonly(),
  missingIds: z.array(z.number()).readonly(),
})
export type DeviceSearchResult = z.infer<typeof DeviceSearchResultSchema>
