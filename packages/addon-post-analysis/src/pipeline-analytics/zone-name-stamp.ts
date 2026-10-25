/**
 * zone-name-stamp — turn a track's persisted zone IDS into the zone NAMES an
 * operator can read and type.
 *
 * `Track.zonesVisited` persists ids (`cfeec78c-8d69-…`) because that is what a
 * detection carries and what the zone filter keys on. The consequence went
 * unnoticed for as long as zones have existed: every free-text search surface
 * offered "zone" as a searchable field and could never match one, because the
 * only zone token on the wire was a UUID. It did not fail loudly — it returned
 * nothing, which reads as "no track was ever in that zone".
 *
 * Resolution happens HERE, once, on the read path, rather than in each client:
 * the `zones` capability is per-device, so a client-side resolve would be a
 * per-camera fan-out on the exact surfaces (`listRecentTracks`, the events
 * embed) that were built to remove one.
 *
 * Pure. The catalogue is passed in as a lookup so the caller owns caching and
 * this module owns only the rule.
 */

import type { Track } from '@camstack/types'

/**
 * Zone id → name for ONE device, or `null` when the catalogue is unknown.
 *
 * Zone ids are unique only within a camera, so the lookup is per-device and a
 * miss must never fall back to another camera's catalogue.
 */
export type ZoneCatalogueLookup = (deviceId: number) => ReadonlyMap<string, string> | null

/**
 * Copy each track with `zoneNames` stamped on.
 *
 * Three silences, all deliberate, all of them "say nothing" rather than "say
 * something wrong":
 *
 *  - a track that visited no zone gets NO field (an empty array on every row of
 *    a 1000-row page is pure wire cost for no information);
 *  - a zone id with no entry in the catalogue — a zone deleted since the track
 *    was written — is DROPPED. `zoneNames` is therefore not positionally
 *    aligned with `zonesVisited` and can be shorter;
 *  - a device whose catalogue could not be read at all leaves the track exactly
 *    as it arrived. A zones cap that is momentarily down must not look like a
 *    track that was never in a zone.
 */
export function stampZoneNames(
  tracks: readonly Track[],
  lookup: ZoneCatalogueLookup,
): readonly Track[] {
  return tracks.map((track) => {
    if (track.zonesVisited.length === 0) return track
    const catalogue = lookup(track.deviceId)
    if (catalogue === null) return track
    const names: string[] = []
    for (const id of track.zonesVisited) {
      const name = catalogue.get(id)
      if (name !== undefined && name.length > 0 && !names.includes(name)) names.push(name)
    }
    if (names.length === 0) return track
    return { ...track, zoneNames: names }
  })
}
