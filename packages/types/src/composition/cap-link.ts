/**
 * Whole-capability links (D1076): the declaration a `capLink` feature names,
 * its expansion into the field claims the composer already runs, and the wire
 * shapes of the two core-blocks methods that read and migrate them.
 *
 * Pure. Nothing here reads a device: the caller passes the cap's top-level
 * state fields, and the planner judges the source.
 */
import { z } from 'zod'
import type { CustomizeCatalog } from '../capabilities/customize-catalog.js'
import type { CustomizeCapLink } from '../capabilities/customize-spec.js'
import { CAP_CUSTOMIZE_CATALOG } from '../generated/customize-catalog.js'
import {
  type Composition,
  type CompositionCapLinkFeature,
  type CompositionFieldSource,
  type CompositionFieldsFeature,
} from './composition.js'
import { CompositionSourceRefSchema } from './source-ref.js'

/** The clock every cap with a `lastFetchedAt` carries. A link writes it as `now`. */
export const CAP_LINK_CLOCK_FIELD = 'lastFetchedAt'
const CLOCK_SOURCE: CompositionFieldSource = { kind: 'expression', expr: 'now', bindings: {} }

/** The link a cap declares under this id, from the generated catalog; undefined when there is none. */
export function declaredCapLink(cap: string, linkId: string): CustomizeCapLink | undefined {
  const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG
  return catalog[cap]?.links?.find((link) => link.id === linkId)
}

/** The `project` link a cap declares first, or undefined — what the migration converts to. */
export function projectCapLinkOf(cap: string): CustomizeCapLink | undefined {
  const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG
  return catalog[cap]?.links?.find((link) => link.mode === 'project')
}

/**
 * The host top-level fields a `project` link serves: its `map` keys, or every
 * top-level field of the host cap. The clock rides with them. A `reference`
 * link serves none (it writes nothing).
 */
export function capLinkServedFields(
  link: CustomizeCapLink,
  hostFields: Iterable<string>,
): readonly string[] {
  if (link.mode !== 'project') return []
  const host = new Set(hostFields)
  const mapped = link.map === undefined ? null : Object.keys(link.map)
  const own = mapped ?? [...host].filter((path) => path !== CAP_LINK_CLOCK_FIELD)
  return host.has(CAP_LINK_CLOCK_FIELD) ? [...own, CAP_LINK_CLOCK_FIELD] : own
}

/**
 * The `fields` feature a `project` link stands for: each served field is a
 * plain `from` of the source's `sourceCap` (the same path, or the map's), the
 * clock an expression of `now`. Null for a `reference` link.
 */
export function expandCapLink(
  feature: CompositionCapLinkFeature,
  link: CustomizeCapLink,
  hostFields: Iterable<string>,
): CompositionFieldsFeature | null {
  if (link.mode !== 'project') return null
  const fields: Record<string, CompositionFieldSource> = {}
  for (const path of capLinkServedFields(link, hostFields)) {
    fields[path] =
      path === CAP_LINK_CLOCK_FIELD && link.map?.[path] === undefined
        ? CLOCK_SOURCE
        : {
            kind: 'from',
            source: feature.source,
            cap: link.sourceCap,
            fieldPath: link.map?.[path] ?? path,
          }
  }
  return {
    kind: 'fields',
    cap: feature.cap,
    ...(feature.enabled === undefined ? {} : { enabled: feature.enabled }),
    fields,
  }
}

/**
 * A composition with every `project` capLink replaced, in place, by the
 * `fields` feature it expands to — what the cycle graph reads. A link the cap
 * does not declare, a `reference` link and a cap `topLevel` does not know stay
 * as they are (the planner refuses or ignores them).
 */
export function expandCapLinks(
  composition: Composition,
  topLevel: (cap: string) => Iterable<string> | null,
): Composition {
  if (!composition.features.some((feature) => feature.kind === 'capLink')) return composition
  return {
    ...composition,
    features: composition.features.map((feature) => {
      if (feature.kind !== 'capLink') return feature
      const link = declaredCapLink(feature.cap, feature.linkId)
      const hostFields = topLevel(feature.cap)
      if (link === undefined || hostFields === null) return feature
      return expandCapLink(feature, link, hostFields) ?? feature
    }),
  }
}

// ---- wire shapes of the core-blocks methods ----

export const CAP_LINK_STATES = ['linked', 'source-gone', 'disabled'] as const
export const CapLinkStateSchema = z.enum(CAP_LINK_STATES)
export type CapLinkState = z.infer<typeof CapLinkStateSchema>

/** One link of a device, as the card and the Customize table read it. */
export const CapLinkViewSchema = z.object({
  linkId: z.string(),
  /** The host cap the link is declared on. */
  cap: z.string(),
  /** The host slot a `reference` link fills; null for a `project` link. */
  slot: z.string().nullable(),
  mode: z.enum(['project', 'reference']),
  /** The device the link points at; `deviceId` is null once it is gone. */
  source: z.object({ deviceId: z.number().int().nullable(), cap: z.string() }),
  state: CapLinkStateSchema,
})
export type CapLinkView = z.infer<typeof CapLinkViewSchema>

/** `not-loaded` until the compositions have been read — never an empty list (D315). */
export const CapLinksReadSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), links: z.array(CapLinkViewSchema) }),
  z.object({ status: z.literal('not-loaded') }),
])
export type CapLinksRead = z.infer<typeof CapLinksReadSchema>

export const MigrateCapLinksInputSchema = z.object({ dryRun: z.boolean() })
export type MigrateCapLinksInput = z.infer<typeof MigrateCapLinksInputSchema>

/** A set of per-field links turned (or, on a dry run, that would be turned) into one `capLink`. */
export const MigratedCapLinkSchema = z.object({
  deviceId: z.number().int(),
  cap: z.string(),
  linkId: z.string(),
  source: CompositionSourceRefSchema,
  /** The host fields the old features carried. */
  fields: z.array(z.string()),
})
export type MigratedCapLink = z.infer<typeof MigratedCapLinkSchema>

/** A set of per-field links the migration left untouched, with every reason. */
export const MixedCapLinkSchema = z.object({
  deviceId: z.number().int(),
  cap: z.string(),
  reasons: z.array(z.string()),
})
export type MixedCapLink = z.infer<typeof MixedCapLinkSchema>

export const MigrateCapLinksReportSchema = z.object({
  dryRun: z.boolean(),
  converted: z.array(MigratedCapLinkSchema),
  mixed: z.array(MixedCapLinkSchema),
  /** Features skipped by rule: stamped by an identity link (D1063), or disabled. */
  skipped: z.number().int(),
  /** Customizations already holding a `capLink` for the cap — nothing to do. */
  alreadyLinked: z.number().int(),
})
export type MigrateCapLinksReport = z.infer<typeof MigrateCapLinksReportSchema>
