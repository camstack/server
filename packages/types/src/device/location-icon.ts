/**
 * What a location's icon is, and the ONE key its label joins on.
 *
 * A location is not an entity — it is a free-form label (`PersistedDeviceMeta.
 * location`) plus an operator-curated registry of labels in the device-manager
 * addon store. The icon is a second map beside that registry, keyed the same
 * way the registry matches everywhere else: {@link locationIconKey}, i.e.
 * trimmed + lower-cased.
 *
 * The icon itself is a key of the ONE icon catalog (`icon-catalog.ts`, D854):
 * a location may wear any icon both surfaces can draw. There used to be a
 * closed 20-icon subset here (D511); it was a second vocabulary on the same two
 * surfaces and is gone. The names below keep their meaning:
 *
 * DEGRADATION IS A FALLBACK, NEVER A HOLE. A surface that cannot draw a stored
 * value — a persisted value from a newer hub, a hand-edited settings row —
 * draws {@link LOCATION_ICON_FALLBACK} (`map-pin`, the one every surface has
 * always had). Read a stored/wire value through
 * `resolveIconKey(value, LOCATION_ICON_FALLBACK)` and that is what you get;
 * nothing anywhere renders an empty box.
 */

import { z } from 'zod'
import { IconKeySchema, type IconKey } from './icon-catalog.js'

/**
 * The id every surface is guaranteed to draw, and what an unrecognised value
 * degrades to. It has been in both icon sets since before the catalog existed
 * (the Locations page's own page icon), so "the fallback is missing" is not a
 * state a build can reach.
 */
export const LOCATION_ICON_FALLBACK: IconKey = 'map-pin'

/**
 * One (location, icon) assignment as it travels.
 *
 * `locationKey` is ALWAYS {@link locationIconKey} of the label — never the
 * operator's casing. The registry matches labels trimmed + case-insensitively
 * everywhere (`addLocation`, `removeLocation`, `renameLocation`), and a
 * case-only rename (`kitchen` → `Kitchen`) is a real edit this repo supports; a
 * map keyed on the displayed casing would orphan its entry on exactly that
 * edit. Consumers join by keying their own label through `locationIconKey`.
 */
export const LocationIconAssignmentSchema = z.object({
  locationKey: z.string(),
  icon: IconKeySchema,
})

/** @see LocationIconAssignmentSchema */
export type LocationIconAssignment = z.infer<typeof LocationIconAssignmentSchema>

/**
 * The join key for a location label: trimmed, lower-cased. The ONE place this
 * derivation lives — a caller that re-spells it is a rename away from an
 * orphaned icon.
 */
export function locationIconKey(label: string): string {
  return label.trim().toLowerCase()
}

/**
 * How long a location description may be.
 *
 * It is given to a vision model alongside the pictures, so it competes for the
 * same attention the pictures need. A cap of one short paragraph is what keeps
 * it a PLACE description rather than a second prompt — an operator who needs
 * more than this is describing events, which change, instead of the ground,
 * which does not.
 */
export const LOCATION_DESCRIPTION_MAX = 400

/**
 * One (location, description) assignment as it travels.
 *
 * Same key discipline as {@link LocationIconAssignmentSchema}, and for the same
 * reason: this lived for a while in the post-analysis addon's own settings,
 * keyed by a HAND-TYPED label matched exactly and case-sensitively. A rename in
 * the Locations page carried the icon and silently orphaned the description —
 * two authorities for one thing, joined by two different rules. Now both hang
 * off the location itself, on `locationIconKey`.
 */
export const LocationDescriptionAssignmentSchema = z.object({
  locationKey: z.string(),
  description: z.string(),
})

/** @see LocationDescriptionAssignmentSchema */
export type LocationDescriptionAssignment = z.infer<typeof LocationDescriptionAssignmentSchema>
