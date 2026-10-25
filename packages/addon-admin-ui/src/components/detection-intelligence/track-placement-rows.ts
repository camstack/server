/**
 * WHERE a track was detected, for the track detail panel: the node, the
 * inference device and the root model of the frame that OPENED it and of the
 * last sighting that CLOSED it (`Track.openedPlacement` / `closedPlacement`).
 *
 * One "Detected on" row when both are the same, two rows when the camera's
 * session hopped node or device mid-track (D916), and no row at all when the
 * track names no placement — a row written before the field is unknown, and
 * rendering it as a node would be a confident lie.
 */
import type { Track, TrackPlacement } from '@camstack/types'

export type TrackPlacementRowKind = 'detected' | 'opened' | 'closed'

export interface TrackPlacementRow {
  readonly kind: TrackPlacementRowKind
  readonly value: string
}

export type TrackPlacementFields = Pick<Track, 'openedPlacement' | 'closedPlacement'>

/** `node · device (model)`, leaving out what the placement does not name. */
export function formatTrackPlacement(p: TrackPlacement): string {
  const where = p.deviceKey !== undefined ? `${p.nodeId} · ${p.deviceKey}` : p.nodeId
  return p.modelId !== undefined ? `${where} (${p.modelId})` : where
}

export function trackPlacementRows(
  track: TrackPlacementFields | undefined | null,
): readonly TrackPlacementRow[] {
  const opened = track?.openedPlacement
  const closed = track?.closedPlacement
  if (opened !== undefined && closed !== undefined) {
    const openedText = formatTrackPlacement(opened)
    const closedText = formatTrackPlacement(closed)
    return openedText === closedText
      ? [{ kind: 'detected', value: openedText }]
      : [
          { kind: 'opened', value: openedText },
          { kind: 'closed', value: closedText },
        ]
  }
  if (opened !== undefined) return [{ kind: 'opened', value: formatTrackPlacement(opened) }]
  if (closed !== undefined) return [{ kind: 'closed', value: formatTrackPlacement(closed) }]
  return []
}
