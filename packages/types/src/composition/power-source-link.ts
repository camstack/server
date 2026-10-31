/**
 * Which smart switch powers a device (the `power-source` Customize extension):
 * the source its stored `power-source.switchOn` field reads, and the off time of
 * a forced restart stored beside it. Read from the STORED composition, never kept
 * as a second copy (D676). Shared by the hub (which acts on the switch) and the
 * admin UI (which shows it).
 */
import {
  POWER_SOURCE_OFF_SECONDS_DEFAULT,
  POWER_SOURCE_OFF_SECONDS_MAX,
  POWER_SOURCE_OFF_SECONDS_MIN,
} from '../capabilities/power-source.cap.js'
import { fieldReads, type Composition } from './composition.js'
import type { CompositionSourceRef } from './source-ref.js'

export interface PowerSourceLink {
  /** The device the customization is on. */
  readonly device: CompositionSourceRef
  /** The smart switch that powers it. */
  readonly switch: CompositionSourceRef
  /** How long a forced restart keeps the switch off: an integer within the cap's bounds. */
  readonly offSeconds: number
}

/**
 * The stored off time, or the default when none is stored. A stored number out
 * of range is CLAMPED to the bounds (a hand-written value never refuses the
 * link, it just cannot cut power for an absurd time); a non-integer is rounded.
 */
export function normalizeOffSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return POWER_SOURCE_OFF_SECONDS_DEFAULT
  return Math.min(
    POWER_SOURCE_OFF_SECONDS_MAX,
    Math.max(POWER_SOURCE_OFF_SECONDS_MIN, Math.round(value)),
  )
}

/** The constant a stored `offSeconds` field carries, or undefined when it is not a literal number. */
function storedOffSeconds(composition: Composition): unknown {
  const feature = composition.features.find((f) => f.cap === 'power-source')
  if (feature === undefined || feature.kind !== 'fields') return undefined
  const field = feature.fields['offSeconds']
  if (field === undefined || field.kind !== 'expression') return undefined
  const n = Number(field.expr)
  return field.expr.trim() === '' || !Number.isFinite(n) ? undefined : n
}

export function powerSourceLinkOfComposition(
  composition: Composition | null,
): PowerSourceLink | null {
  if (composition === null || composition.target.kind !== 'existing') return null
  const feature = composition.features.find((f) => f.cap === 'power-source')
  if (feature === undefined || feature.kind !== 'fields' || feature.enabled === false) return null
  const field = feature.fields['switchOn']
  if (field === undefined) return null
  const read = fieldReads(field).find((r) => r.cap === 'switch')
  if (read === undefined) return null
  return {
    device: composition.target.device,
    switch: read.source,
    offSeconds: normalizeOffSeconds(storedOffSeconds(composition)),
  }
}
