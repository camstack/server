/**
 * The six tiered-label columns, read and written in ONE place (roadmap 4g).
 *
 * The track row and the object-event row carry the same six columns for the
 * same reason the schema spreads one field group into both cap shapes: a track
 * and its events must not be able to disagree about what was seen. Two copies
 * of this mapping is exactly how they would — one of them would learn about a
 * new column and the other would not.
 *
 * `labelMeta` / `subLabelMeta` are JSON columns. They are validated through the
 * SCHEMA on the way out, never trusted as a shape: an unparseable attribution
 * leaves the meta ABSENT while keeping the text and the score, because the
 * value is still true even when its provenance was written by an older build.
 */

import { type LabelAttribution, LabelAttributionSchema } from '@camstack/types'
import type { TieredLabelPatch } from '../pipeline/label-tier.js'

/** The tiered columns as they read back off a persisted row. */
export interface TieredLabelColumns {
  readonly label?: string
  readonly labelScore?: number
  readonly labelMeta?: LabelAttribution
  readonly subLabel?: string
  readonly subLabelScore?: number
  readonly subLabelMeta?: LabelAttribution
}

function readMeta(value: unknown): LabelAttribution | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = LabelAttributionSchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/** Project the six columns of a persisted row onto the cap's optional fields. */
export function readTieredLabelColumns(data: Record<string, unknown>): TieredLabelColumns {
  const label = data['label']
  const labelScore = data['labelScore']
  const subLabel = data['subLabel']
  const subLabelScore = data['subLabelScore']
  const labelMeta = readMeta(data['labelMeta'])
  const subLabelMeta = readMeta(data['subLabelMeta'])
  return {
    ...(typeof label === 'string' ? { label } : {}),
    ...(typeof labelScore === 'number' ? { labelScore } : {}),
    ...(labelMeta !== undefined ? { labelMeta } : {}),
    ...(typeof subLabel === 'string' ? { subLabel } : {}),
    ...(typeof subLabelScore === 'number' ? { subLabelScore } : {}),
    ...(subLabelMeta !== undefined ? { subLabelMeta } : {}),
  }
}

/**
 * The `data` payload of an UPDATE that applies one tier's decision.
 *
 * Only the three columns of the tier that won are named: an update naming the
 * other tier — even as `undefined` — is a write, and a write is how a tier-1
 * decision would come to clear a species. The patch produced by
 * `resolveTieredLabelWrite` already contains exactly one tier's fields, so this
 * is a projection of that guarantee onto the store, not a second rule.
 */
export function tieredLabelColumnData(patch: TieredLabelPatch): Record<string, unknown> {
  return {
    ...(patch.label !== undefined
      ? { label: patch.label, labelScore: patch.labelScore ?? null, labelMeta: patch.labelMeta }
      : {}),
    ...(patch.subLabel !== undefined
      ? {
          subLabel: patch.subLabel,
          subLabelScore: patch.subLabelScore ?? null,
          subLabelMeta: patch.subLabelMeta,
        }
      : {}),
  }
}
