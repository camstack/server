/**
 * A `dynamic` vocabulary offer (D920) is a list the DEVICE knows: a status
 * field holding it (of the action's cap or a sibling cap), or a read method
 * returning it. This file turns the raw read
 * into the choices of a select, and names where to read it; the hook that does
 * the read is `use-dynamic-choices.ts`.
 *
 * An offer that cannot be projected (the read failed, the shape is unexpected,
 * the list is empty) yields no choices, and the arg stays a free field — a
 * missing list must never block saving a step the operator can still type.
 */

import type { LooseVocabOffer } from '@camstack/types'

export type DynamicOffer = Extract<LooseVocabOffer, { readonly kind: 'dynamic' }>

export interface DynamicChoice {
  /** What the method receives: a string, or a number when the offer says so. */
  readonly value: string | number
  readonly label: string
}

export type DynamicChoices =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly choices: readonly DynamicChoice[] }
  /** The read failed or answered nothing usable: the arg stays free text. */
  | { readonly state: 'unavailable' }

export function isDynamicOffer(offer: LooseVocabOffer): offer is DynamicOffer {
  return offer.kind === 'dynamic'
}

/** The tRPC router key of a cap (`vacuum-control` → `vacuumControl`). */
export function capRouterKey(cap: string): string {
  return cap.replace(/-([a-z0-9])/g, (_m, ch: string) => ch.toUpperCase())
}

/**
 * The cap an offer reads: the action's own cap, or the sibling cap of the same
 * device whose status holds the list (D1050 — `heat-pump-control` reads the
 * circuits `heat-pump-status` reports).
 */
export function dynamicReadCap(cap: string, offer: DynamicOffer): string {
  return offer.from === 'status' && offer.cap !== undefined ? offer.cap : cap
}

/** The read an offer names: the cap's status, or one of its methods. */
export function dynamicReadName(offer: DynamicOffer): string {
  return offer.from === 'method' ? offer.method : 'getStatus'
}

function field(item: unknown, key: string): unknown {
  return typeof item === 'object' && item !== null ? Reflect.get(item, key) : undefined
}

function isScalar(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number'
}

/**
 * The choices of an offer from what the read answered. For a status read `raw`
 * is the whole status and the offer's `field` picks the list; for a method read
 * it is the method's answer.
 */
export function dynamicChoicesOf(raw: unknown, offer: DynamicOffer): readonly DynamicChoice[] {
  const list = offer.from === 'status' ? field(raw, offer.field) : raw
  if (!Array.isArray(list)) return []
  const out: DynamicChoice[] = []
  for (const item of list) {
    if (offer.where !== undefined && field(item, offer.where.key) !== offer.where.equals) continue
    const value = offer.valueKey === undefined ? item : field(item, offer.valueKey)
    if (!isScalar(value)) continue
    const label = offer.labelKey === undefined ? value : field(item, offer.labelKey)
    out.push({ value, label: isScalar(label) ? String(label) : String(value) })
  }
  return out
}
