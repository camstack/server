/**
 * How a box on the canvas (and its chip in the list) is painted — ONE mapping
 * from the review diff to theme tokens, shared with the badges
 * (`retrainReviewBadgeLook` in the ui-library) so the stroke, the label and the
 * badge of one box never disagree.
 *
 * - The STROKE colour is the diff: added = success, removed = danger,
 *   reclassified = warning, adjusted = info, unchanged = neutral, draft =
 *   primary.
 * - `model-error` is NOT `removed`: it keeps the danger colour but is drawn as
 *   an outline (dashed 2px stroke, an outlined label) where a removed ghost is
 *   a filled, dotted one — the badge's own fill-vs-outline distinction.
 * - The label text sits on a `*-fill` background with its `*-on` colour (the
 *   AA pairs of the theme); an outline label sits on the page background.
 *
 * Values are CSS custom properties of `camstack-theme.css`, never colours.
 */

import type { BoxDiffKind } from './retrain-live-review.js'

export type StrokeStyle = 'solid' | 'dashed' | 'dotted'

export interface BoxLook {
  readonly stroke: string
  readonly strokeStyle: StrokeStyle
  /** Stroke width in px when the box is neither hovered nor selected. */
  readonly strokeWidth: number
  /** Label background (a fill pair) or the page background for an outline label. */
  readonly labelBackground: string
  readonly labelColor: string
  /** The label's own border: an outline label draws one in the stroke colour. */
  readonly labelBorder: string
}

/** The token a colour family is read from. */
type Family = 'success' | 'danger' | 'warning' | 'info' | 'primary' | 'neutral'

const strokeToken = (family: Family): string =>
  family === 'neutral' ? 'var(--color-foreground-muted)' : `var(--color-${family})`

function filled(family: Family, strokeStyle: StrokeStyle, strokeWidth: number): BoxLook {
  return {
    stroke: strokeToken(family),
    strokeStyle,
    strokeWidth,
    labelBackground: `var(--color-${family}-fill)`,
    labelColor: `var(--color-${family}-on)`,
    labelBorder: `var(--color-${family}-fill)`,
  }
}

function outlined(family: Family, strokeStyle: StrokeStyle, strokeWidth: number): BoxLook {
  return {
    stroke: strokeToken(family),
    strokeStyle,
    strokeWidth,
    labelBackground: 'var(--color-background)',
    labelColor: strokeToken(family),
    labelBorder: strokeToken(family),
  }
}

const LOOKS: Readonly<Record<BoxDiffKind, BoxLook>> = {
  added: filled('success', 'solid', 1.5),
  removed: filled('danger', 'dotted', 1.5),
  reclassified: filled('warning', 'solid', 1.5),
  adjusted: filled('info', 'solid', 1.5),
  unchanged: filled('neutral', 'solid', 1.5),
  'model-error': outlined('danger', 'dashed', 2),
  draft: outlined('primary', 'dashed', 1.5),
}

export function boxLook(kind: BoxDiffKind): BoxLook {
  return LOOKS[kind]
}

/** How much a hovered or selected box thickens, in px. */
export const EMPHASIS_EXTRA_PX = 1.5

/** Opacity of every box a hover dims. */
export const DIMMED_OPACITY = 0.35

/** Opacity of the faint "where the proposal was" ghost. */
export const ORIGIN_GHOST_OPACITY = 0.55
