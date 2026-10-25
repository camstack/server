/**
 * The retrain-review vocabulary as badges — ONE mapping from a review verdict
 * to a `Badge`, so the admin frames list, the canvas legend and the viewer
 * read the same colours.
 *
 * - added=success, removed=danger, reclassified=warning, adjusted=info,
 *   unchanged=neutral — all `fill` (opaque, AA text).
 * - model-error is NOT `removed` (a removed proposal teaches nothing, a model
 *   error teaches a false positive), so it must not share its look: it is a
 *   danger OUTLINE (border + danger text, no fill) against removed's solid
 *   danger fill.
 * - draft (a machine proposal nobody confirmed) = primary outline.
 * - `approximate` (a verdict re-derived rather than snapshotted) adds a dashed
 *   border to an outline and a trailing "~" to a fill, so it is never mistaken
 *   for an exact verdict.
 */

import type { ReactElement } from 'react'
import type { RetrainReviewStatusName } from '@camstack/types'
import {
  Badge,
  type BadgeProps,
  type BadgeSize,
  type BadgeStyle,
  type BadgeVariant,
} from '../../primitives/badge'
import { cn } from '../../lib/cn'
import { defaultUiText, useUiText, type UiTextFn } from '../../contexts/ui-text'

/** A review verdict, plus the pre-confirmation `draft` state. */
export type RetrainReviewBadgeKind = RetrainReviewStatusName | 'draft'

export interface RetrainReviewBadgeLook {
  readonly variant: BadgeVariant
  readonly style: BadgeStyle
  readonly label: string
  /** Extra classes an outline needs for its text/border colour. */
  readonly className: string
}

interface RetrainReviewBadgeLookDef extends Omit<RetrainReviewBadgeLook, 'label'> {
  readonly labelKey: string
  readonly labelFallback: string
}

const LOOKS: Readonly<Record<RetrainReviewBadgeKind, RetrainReviewBadgeLookDef>> = {
  added: {
    variant: 'success',
    style: 'fill',
    labelKey: 'uiLibrary.retrainReviewBadge.added',
    labelFallback: 'Added',
    className: '',
  },
  removed: {
    variant: 'danger',
    style: 'fill',
    labelKey: 'uiLibrary.retrainReviewBadge.removed',
    labelFallback: 'Removed',
    className: '',
  },
  reclassified: {
    variant: 'warning',
    style: 'fill',
    labelKey: 'uiLibrary.retrainReviewBadge.reclassified',
    labelFallback: 'Reclassified',
    className: '',
  },
  adjusted: {
    variant: 'info',
    style: 'fill',
    labelKey: 'uiLibrary.retrainReviewBadge.adjusted',
    labelFallback: 'Adjusted',
    className: '',
  },
  unchanged: {
    variant: 'neutral',
    style: 'fill',
    labelKey: 'uiLibrary.retrainReviewBadge.unchanged',
    labelFallback: 'Unchanged',
    className: '',
  },
  'model-error': {
    variant: 'danger',
    style: 'outline',
    labelKey: 'uiLibrary.retrainReviewBadge.modelError',
    labelFallback: 'Model error',
    className: 'border-danger text-danger',
  },
  draft: {
    variant: 'primary',
    style: 'outline',
    labelKey: 'uiLibrary.retrainReviewBadge.draft',
    labelFallback: 'Draft',
    className: 'border-primary text-primary',
  },
}

/** The badge look for a verdict. Pure. */
export function retrainReviewBadgeLook(
  kind: RetrainReviewBadgeKind,
  t: UiTextFn = defaultUiText,
): RetrainReviewBadgeLook {
  const { labelKey, labelFallback, ...look } = LOOKS[kind]
  return { ...look, label: t(labelKey, labelFallback) }
}

export interface RetrainReviewBadgeProps
  extends Omit<BadgeProps, 'variant' | 'style' | 'children' | 'dashed'> {
  readonly kind: RetrainReviewBadgeKind
  readonly approximate?: boolean
  readonly size?: BadgeSize
}

export function RetrainReviewBadge({
  kind,
  approximate = false,
  className,
  ...props
}: RetrainReviewBadgeProps): ReactElement {
  const t = useUiText()
  const look = retrainReviewBadgeLook(kind, t)
  const outlined = look.style === 'outline'
  return (
    <Badge
      {...props}
      variant={look.variant}
      style={look.style} // ui-check-ok: Badge.style is the look enum, not a CSS style
      dashed={approximate && outlined}
      className={cn(look.className, className)}
      title={
        approximate
          ? t('uiLibrary.retrainReviewBadge.approximate', '{{label}} (approximate)', {
              label: look.label,
            })
          : look.label
      }
    >
      {look.label}
      {approximate && !outlined ? ' ~' : ''}
    </Badge>
  )
}
