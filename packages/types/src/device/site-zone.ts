/**
 * A SITE ZONE — a named part of the property that several locations belong to.
 *
 * "Night zone" holds every bedroom; "Zona giorno" the living room and the
 * kitchen. A camera belongs to exactly one location, and a location to at most
 * one zone, so a camera's zone is derived and never stored on the device: the
 * whole point of this entity is that grouping rooms touches no device row.
 *
 * ## Why not `zone`
 *
 * Because `zone` is already the most loaded word in this product: 612 source
 * files and 24 Italian strings where it means a DETECTION zone drawn on a
 * camera. The two are unrelated — one is a polygon in a frame, the other is a
 * set of rooms — and a reader who confuses them will look for a camera's
 * bedrooms. So the code says `siteZone` everywhere, and the UI frees the plain
 * word by calling the drawn one what it actually is: a detection zone.
 *
 * ## The key
 *
 * `siteZoneKey(label)` — trimmed, lower-cased, the SAME derivation locations
 * use (`locationIconKey`). Membership and the icon both hang off it, so a
 * case-only rename keeps them, which is exactly the orphaning that cost us a
 * silently-dropped location description.
 *
 * The icon is a key of the one icon catalog (D854), like a location's: a zone
 * is drawn on the same two surfaces by the same glyph tables.
 */
import { z } from 'zod'

import { IconKeySchema } from './icon-catalog.js'

/**
 * One zone as it travels: its key, the label the operator typed, its icon and
 * the locations inside it.
 *
 * The LABEL is carried alongside the key because the key is lossy on purpose —
 * a surface must show "Night zone", not "night zone". Locations are carried
 * here, rather than left to a second call, because every consumer wants both
 * at once and a viewer that asked twice could render a zone whose membership
 * it has not fetched yet.
 *
 * `icon: null` means nobody chose one, which is NOT the fallback pin: only one
 * of those two is a choice, and a picker has to draw them differently.
 */
export const SiteZoneSchema = z.object({
  zoneKey: z.string(),
  label: z.string(),
  icon: IconKeySchema.nullable(),
  /** Folded location keys, sorted. A location listed here need not be
   *  REGISTERED — devices carry labels nobody registered, and those rooms are
   *  the ones that most want grouping. */
  locationKeys: z.array(z.string()),
})

/** @see SiteZoneSchema */
export type SiteZone = z.infer<typeof SiteZoneSchema>

/**
 * The join key for a zone label: trimmed, lower-cased.
 *
 * Deliberately a separate export from `locationIconKey` even though the
 * derivation is identical — they key different maps, and a future change to one
 * must not silently re-key the other. Their agreement is a fact about today,
 * not a dependency.
 */
export function siteZoneKey(label: string): string {
  return label.trim().toLowerCase()
}
