const LISTBOX_GAP_PX = 4
const LISTBOX_MAX_HEIGHT_PX = 224 // max-h-56
const VIEWPORT_MARGIN_PX = 8
const MIN_LISTBOX_HEIGHT_PX = 96

export type ListboxCoords = {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly maxHeight: number
  readonly placement: 'below' | 'above'
}

export interface ListboxPositionOptions {
  /** A trigger narrower than this still gets a list this wide (clamped to the viewport). */
  readonly minWidth?: number
}

/**
 * Where a dropdown list sits relative to its trigger, in viewport (`fixed`)
 * coordinates: below when there is room, else above, never past the viewport
 * edge — the one rule shared by `Select` and `OptionSelect`, so a list on a
 * 390 px phone is as tall as the space it has and no wider than the screen.
 */
export function computeListboxCoords(
  trigger: Element,
  options: ListboxPositionOptions = {},
): ListboxCoords {
  const rect = trigger.getBoundingClientRect()
  const maxWidth = window.innerWidth - 2 * VIEWPORT_MARGIN_PX
  const width = Math.min(Math.max(rect.width, options.minWidth ?? 0), maxWidth)
  const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN_PX
  const spaceAbove = rect.top - VIEWPORT_MARGIN_PX
  const preferBelow = spaceBelow >= Math.min(LISTBOX_MAX_HEIGHT_PX, spaceAbove) || spaceBelow >= 120
  const maxHeight = Math.max(
    MIN_LISTBOX_HEIGHT_PX,
    Math.min(LISTBOX_MAX_HEIGHT_PX, preferBelow ? spaceBelow : spaceAbove),
  )
  const left = Math.max(
    VIEWPORT_MARGIN_PX,
    Math.min(rect.left, window.innerWidth - width - VIEWPORT_MARGIN_PX),
  )
  if (preferBelow) {
    return { top: rect.bottom + LISTBOX_GAP_PX, left, width, maxHeight, placement: 'below' }
  }
  return {
    top: Math.max(VIEWPORT_MARGIN_PX, rect.top - LISTBOX_GAP_PX - maxHeight),
    left,
    width,
    maxHeight,
    placement: 'above',
  }
}
