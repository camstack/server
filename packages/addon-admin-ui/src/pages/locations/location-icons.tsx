/**
 * The admin UI's half of a location's icon: stored value → `lucide-react`
 * component.
 *
 * The icon is a key of the one icon catalog (`@camstack/types`, D854) and the
 * glyph comes from ui-library's catalog-wide table — there is no per-room table
 * here any more. The only thing this file still owns is the DEGRADATION RULE:
 * `useLocationIconComponent` never returns `undefined`. A value this build does
 * not know (a hub ahead of this UI, a hand-edited settings row) — or whose
 * glyph chunk has not arrived yet — draws the fallback pin. An unknown icon
 * must degrade to a picture, never to a hole: an empty slot in a room tab strip
 * reads as a rendering bug, not as a missing choice.
 */
import { resolveDisplayIcon, useIconGlyphsVersion } from '@camstack/ui-library'
import { LOCATION_ICON_FALLBACK, resolveIconKey } from '@camstack/types'
import { type LucideIcon, MapPin } from 'lucide-react'

/**
 * The component for a stored/wire icon value. Call the hook once per component
 * and the returned function per value: the component re-renders when the lazy
 * glyph table arrives.
 */
export function useLocationIconComponent(): (value: unknown) => LucideIcon {
  useIconGlyphsVersion()
  return (value) => resolveDisplayIcon(resolveIconKey(value, LOCATION_ICON_FALLBACK)) ?? MapPin
}
