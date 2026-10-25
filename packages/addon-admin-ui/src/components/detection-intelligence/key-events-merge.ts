/**
 * Pure key-events feed helpers: merge per-camera fan-out results, sort,
 * client-side filter, group selected track ids by device (fan-IN for delete),
 * and resolve a nullable date range into a concrete [since, until] window.
 * All functions return new structures — no input mutation.
 */
import type { KeyEvent } from '@camstack/types'

/**
 * One feed row = one TRACK (`getKeyEvents` returns one entry per completed
 * track, mapped to that track's best event — see the cap doc). The shape is
 * EXTENDED from the generated `KeyEvent` rather than restated: a hand-copied
 * mirror of a cap output goes stale silently, and every field added to
 * `KeyEventSchema` would otherwise be invisible to this file.
 *
 * `deviceId` is the one field that is not on the cap output — it is stamped
 * from the per-camera fan-out key in `useKeyEventsFeed`.
 */
/**
 * The finest thing known about a row's subject (roadmap 4g).
 *
 * `label` is tier 1 (the sub-class, `bird`) and `subLabel` is tier 2 (the
 * instance, `Turdus migratorius`). Every surface that shows a name to a person
 * asks THIS, never a column: reading `label` alone shows nothing on a
 * species-only row, which is every row the 4g migration touched.
 */
export function rowDisplayLabel(row: {
  readonly label?: string
  readonly subLabel?: string
  /** Peak-first heard audio macros (D189). Used when tier labels are absent —
   *  an `audio` card otherwise shows only the taxonomy macro. */
  readonly audioLabels?: readonly { readonly label: string }[]
}): string | undefined {
  const tier = row.subLabel ?? row.label
  if (tier !== undefined) return tier
  const heard = row.audioLabels?.[0]?.label
  return heard !== undefined && heard.length > 0 ? heard : undefined
}

export interface KeyEventRow extends KeyEvent {
  readonly deviceId: number
}

export type SortMode = 'importance' | 'time'

/** 30-day floor used when a range endpoint is left open (null). */
const FLOOR_MS = 30 * 24 * 60 * 60 * 1000

/** Flatten per-camera arrays into one list (new array). */
export function mergeKeyEvents(perCamera: readonly (readonly KeyEventRow[])[]): KeyEventRow[] {
  const out: KeyEventRow[] = []
  for (const camera of perCamera) out.push(...camera)
  return out
}

/** Sort by importance-desc or timestamp-desc — pure copy, no mutation. */
export function sortKeyEvents(rows: readonly KeyEventRow[], mode: SortMode): KeyEventRow[] {
  const copy = [...rows]
  copy.sort((a, b) =>
    mode === 'importance' ? b.importance - a.importance : b.timestamp - a.timestamp,
  )
  return copy
}

/** Drop rows by camera set, class set, and min importance. Empty sets = no filter. */
export function filterKeyEvents(
  rows: readonly KeyEventRow[],
  f: {
    readonly cameras: ReadonlySet<number>
    readonly classes: ReadonlySet<string>
    readonly minImportance: number
  },
): KeyEventRow[] {
  return rows.filter((r) => {
    if (r.importance < f.minImportance) return false
    if (f.cameras.size > 0 && !f.cameras.has(r.deviceId)) return false
    if (f.classes.size > 0 && !f.classes.has(r.className)) return false
    return true
  })
}

/**
 * Composite selection key. `trackId` is a PER-DEVICE counter (e.g. `track-158`
 * exists independently on every camera), so a bare-`trackId` selection set can
 * collide across cameras and select/delete the wrong device's track. Key every
 * selection by `${deviceId}:${trackId}` so it is globally unique.
 */
export function trackSelectionKey(deviceId: number, trackId: string): string {
  return `${String(deviceId)}:${trackId}`
}

/**
 * Group selected tracks by device id (fan-IN for one delete call per device),
 * de-duped. `selectedKeys` holds COMPOSITE `${deviceId}:${trackId}` keys (see
 * `trackSelectionKey`) — matching on the composite avoids the cross-camera
 * trackId collision.
 */
export function groupTrackIdsByDevice(
  rows: readonly KeyEventRow[],
  selectedKeys: ReadonlySet<string>,
): Map<number, string[]> {
  const byDevice = new Map<number, string[]>()
  const seen = new Set<string>()
  for (const r of rows) {
    const key = trackSelectionKey(r.deviceId, r.trackId)
    if (!selectedKeys.has(key)) continue
    if (seen.has(key)) continue
    seen.add(key)
    const list = byDevice.get(r.deviceId)
    if (list) list.push(r.trackId)
    else byDevice.set(r.deviceId, [r.trackId])
  }
  return byDevice
}

/** Resolve a nullable range into a concrete window; null from → now-30d, null to → now. */
export function resolveWindow(
  range: { readonly fromMs: number | null; readonly toMs: number | null },
  nowMs: number,
): { readonly since: number; readonly until: number } {
  return {
    since: range.fromMs ?? nowMs - FLOOR_MS,
    until: range.toMs ?? nowMs,
  }
}
