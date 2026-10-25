/**
 * The icon of ONE room.
 *
 * The control itself is `IconPicker` from ui-library — the same one the device
 * override uses, over the same catalog and the same search (D854). What is left
 * here is the room's half: the labels this UI gives it, the English room words
 * that make "kitchen" reach `utensils` (they live in the catalog's synonym
 * overlay, so they are searchable everywhere), and what clearing means.
 *
 * The button is the icon itself rather than a menu entry: the icon is what the
 * operator is choosing and what they will see in the viewer's location filter,
 * so the control shows the current answer at all times. A room with no icon
 * shows the fallback pin — the same glyph every surface draws for it — so the
 * header never has a hole where an unchosen icon would be.
 *
 * Clearing is NOT "inherit" here: a room with no icon has no other answer to
 * fall back to, so the clear tile wears `Ban` rather than the pin, which would
 * be indistinguishable from picking the pin.
 */
import { IconPicker, type IconPickerLabels } from '@camstack/ui-library'
import { type IconKey, LOCATION_ICON_FALLBACK, canonicalIconKey } from '@camstack/types'
import { Ban, MapPin } from 'lucide-react'

export interface LocationIconPickerProps {
  /** The room this picker belongs to — used for the accessible names. */
  readonly name: string
  /** The stored assignment, or `null` when the operator has chosen none. */
  readonly icon: IconKey | null
  readonly busy: boolean
  /** `null` clears the assignment. */
  readonly onPick: (icon: IconKey | null) => void | Promise<void>
}

export function LocationIconPicker({ name, icon, busy, onPick }: LocationIconPickerProps) {
  const labels: IconPickerLabels = {
    trigger: `Change the icon of ${name}`,
    panel: `Icon for ${name}`,
    searchPlaceholder: 'Search icons',
    clear: 'No icon',
    noMatches: 'No icon matches that',
  }

  return (
    <IconPicker
      value={icon}
      onPick={onPick}
      fallbackGlyph={MapPin}
      clearGlyph={Ban}
      labels={labels}
      disabled={busy}
    />
  )
}

/**
 * Read one room's assignment out of the `listLocationIcons` payload.
 *
 * `null` means "no icon chosen", which is NOT the same as the fallback pin
 * ({@link LOCATION_ICON_FALLBACK}) and must stay distinguishable: the picker
 * draws the pin either way, but only one of the two is a choice the operator
 * made. A stored value that is not a catalog key reads as the fallback pin. The
 * join is on `locationIconKey` — never on the displayed casing.
 */
export function pickLocationIcon(
  assignments: ReadonlyArray<{ locationKey: string; icon: string }> | undefined,
  locationKey: string,
): IconKey | null {
  const found = assignments?.find((a) => a.locationKey === locationKey)
  return found === undefined ? null : (canonicalIconKey(found.icon) ?? LOCATION_ICON_FALLBACK)
}
