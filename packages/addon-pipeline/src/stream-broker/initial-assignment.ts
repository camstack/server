/**
 * The broker's AUTOMATIC profile assignment — which published cam-stream
 * serves `high` / `mid` / `low` when the operator has not chosen.
 *
 * Extracted from `StreamBrokerManager.computeInitialAssignment` so the one
 * rule added here — a publisher's `profileHint` — is testable without the
 * manager, and so the pixel-count heuristic every camera relied on stays
 * byte-for-byte what it was for a catalog that does not hint.
 *
 * ## The hint, and why it comes first
 *
 * The heuristic ranks by resolution and parks a SINGLE stream on `mid`. That
 * is the slot no storage class is written for on its own (`recordings` is
 * high|mid, `recordingsLow` is low — `recorder/addon/roots.ts`) and the one
 * profile scrub does not read (`profile === 'low'`, `data-planes.md`). The
 * robot camera has exactly one stream — a 720p cloud relay that is a `low` in
 * every respect except the slot the heuristic chose — so its footage landed in
 * the high class and could not be scrubbed. The publisher knows what its
 * stream IS; the heuristic only knows how many pixels it has. So a hint is
 * honoured before the ranking, and the remaining streams are ranked into the
 * slots the hints left free.
 *
 * What the hint does NOT do: override an operator. A locked assignment
 * (`auto === false`) never reaches this function — that is the manager's
 * `reconcileAutoAssignment`, unchanged.
 */
import type { CamProfile } from '@camstack/types'

/** The fields the ranking reads — a projection of `CameraStreamInternal`. */
export interface RankableStream {
  readonly camStreamId: string
  /** Insertion order within the device — the tie-break after pixels. */
  readonly order: number
  readonly autoEligible: boolean
  readonly resolution?: { readonly width: number; readonly height: number }
  readonly profileHint?: CamProfile
}

/** Slot → camStreamId, partial like the manager's assignment map. */
export type InitialAssignment = Partial<Record<CamProfile, string>>

function pixels(stream: RankableStream): number {
  return stream.resolution ? stream.resolution.width * stream.resolution.height : -1
}

/** Pixels descending, then publish order — the heuristic as it always was. */
function rankByPixels(streams: readonly RankableStream[]): readonly RankableStream[] {
  return [...streams].toSorted((a, b) => {
    const aPx = pixels(a)
    const bPx = pixels(b)
    if (aPx !== bPx) return bPx - aPx
    return a.order - b.order
  })
}

/**
 * The slots the un-hinted ranking fills, by how many streams are left: one
 * stream is a `mid`, two are `high`+`low`, three fill everything. Filtered to
 * the slots the hints did not take, in this priority order, so a camera with
 * one hinted `low` and one other stream gets `high` for the other — the pair
 * every two-stream camera already had.
 */
const RANK_ORDER_BY_COUNT: Readonly<Record<number, readonly CamProfile[]>> = {
  1: ['mid'],
  2: ['high', 'low'],
  3: ['high', 'mid', 'low'],
}

/**
 * Streams marked `autoEligible: false` are skipped — they remain published
 * (visible + manually assignable via `assignProfile`) but never become the
 * default. If every stream is non-eligible the map stays empty: ranking
 * ineligible streams (a derived that beat the catalog to boot) parked a
 * transcode on `high` and left the natives around it (618, 2026-08-17).
 */
export function rankInitialAssignment(streams: readonly RankableStream[]): InitialAssignment {
  const eligible = streams.filter((s) => s.autoEligible)
  if (eligible.length === 0) return {}

  const hinted: Partial<Record<CamProfile, string>> = {}
  const rest: RankableStream[] = []
  // Publish order decides between two streams hinting the same slot: the
  // first keeps it, the second is ranked like an un-hinted stream.
  for (const stream of [...eligible].toSorted((a, b) => a.order - b.order)) {
    const hint = stream.profileHint
    if (hint !== undefined && hinted[hint] === undefined) hinted[hint] = stream.camStreamId
    else rest.push(stream)
  }

  // The slot ORDER is decided by how many streams the camera has in all —
  // a two-stream camera is a high+low pair whether or not one of them hinted —
  // and the hinted slots are simply taken out of it.
  const ranked = rankByPixels(rest).slice(0, 3)
  const freeSlots = (RANK_ORDER_BY_COUNT[Math.min(3, eligible.length)] ?? []).filter(
    (slot) => hinted[slot] === undefined,
  )
  const byRank: Partial<Record<CamProfile, string>> = {}
  ranked.forEach((stream, index) => {
    const slot = freeSlots[index]
    if (slot !== undefined) byRank[slot] = stream.camStreamId
  })
  return { ...hinted, ...byRank }
}
