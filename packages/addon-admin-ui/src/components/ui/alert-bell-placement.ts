import type { CSSProperties } from 'react'

/** Gap kept between the dropdown and every viewport edge, in px. */
export const PANEL_MARGIN_PX = 8
/** Gap between the bell button and the dropdown, in px. */
const ANCHOR_GAP_PX = 4
const MIN_PANEL_HEIGHT_PX = 160
const MAX_PANEL_WIDTH_PX = 320

const INSET_TOP = 'env(safe-area-inset-top)'
const INSET_BOTTOM = 'env(safe-area-inset-bottom)'

export interface PanelAnchor {
  /** Bounding rect of the bell button, viewport coordinates. */
  readonly rect: { readonly left: number; readonly top: number; readonly bottom: number }
  readonly viewportWidth: number
  readonly viewportHeight: number
}

/**
 * Where the alerts dropdown sits. The panel is portalled to `body` with
 * `position: fixed`, so it is NOT inside the app shell that pads itself by
 * the safe-area insets: the insets must be part of its own clamp, otherwise an
 * installed iOS app (viewport-fit=cover, translucent status bar) can place or
 * grow it under the status bar / notch or the home indicator. The pixel
 * numbers come from the button's rect; the insets stay CSS `env()` because
 * only the browser knows them.
 */
export function computeAlertPanelStyle(anchor: PanelAnchor): CSSProperties {
  const { rect, viewportWidth, viewportHeight } = anchor
  const width = Math.min(MAX_PANEL_WIDTH_PX, viewportWidth - PANEL_MARGIN_PX * 2)
  const left = Math.max(
    PANEL_MARGIN_PX,
    Math.min(rect.left, viewportWidth - PANEL_MARGIN_PX - width),
  )
  const edge = `${PANEL_MARGIN_PX}px`
  const base: CSSProperties = { position: 'fixed', left, width, zIndex: 9999 }

  if (viewportHeight - rect.bottom >= rect.top) {
    const top = `max(${rect.bottom + ANCHOR_GAP_PX}px, calc(${INSET_TOP} + ${edge}))`
    return {
      ...base,
      top,
      maxHeight: `max(${MIN_PANEL_HEIGHT_PX}px, calc(100dvh - ${top} - ${INSET_BOTTOM} - ${edge}))`,
    }
  }
  const bottom = `max(${viewportHeight - rect.top + ANCHOR_GAP_PX}px, calc(${INSET_BOTTOM} + ${edge}))`
  return {
    ...base,
    bottom,
    maxHeight: `max(${MIN_PANEL_HEIGHT_PX}px, calc(100dvh - ${bottom} - ${INSET_TOP} - ${edge}))`,
  }
}
