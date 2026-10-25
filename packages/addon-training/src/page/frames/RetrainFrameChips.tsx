/**
 * The review chips on a corpus tile: one filled badge per (state, class) — the
 * class glyph and a count — painted with the review badge's own look
 * (`retrainReviewBadgeLook`), dashed / "~" when approximate. Filled, so they
 * read over the thumbnail.
 */
import type { RetrainCorpusPageFrame, RetrainMacroClass } from '@camstack/types'
import { Badge, retrainReviewBadgeLook, useUiText } from '@camstack/ui-library'
import {
  Car,
  CircleHelp,
  PawPrint,
  Package,
  PersonStanding,
  RectangleHorizontal,
  ScanFace,
  type LucideIcon,
} from 'lucide-react'
import type { JSX } from 'react'
import { useT } from '../../i18n/index.js'
import { summarizeFrameReview } from './lib/retrain-frame-review-chips.js'

const GLYPH: Readonly<Record<RetrainMacroClass, LucideIcon>> = {
  person: PersonStanding,
  vehicle: Car,
  animal: PawPrint,
  package: Package,
  face: ScanFace,
  plate: RectangleHorizontal,
}

export function RetrainFrameChips({
  review,
}: {
  readonly review: RetrainCorpusPageFrame['review']
}): JSX.Element | null {
  const { t } = useT()
  const uiText = useUiText()
  const { shown, more } = summarizeFrameReview(review)
  if (shown.length === 0) return null
  return (
    <div
      className="pointer-events-none absolute inset-x-1 bottom-1 flex flex-wrap gap-1"
      data-testid="corpus-frame-chips"
    >
      {shown.map((chip) => {
        const look = retrainReviewBadgeLook(chip.kind, uiText)
        const Icon = chip.macroClass === null ? CircleHelp : GLYPH[chip.macroClass]
        const outlined = look.style === 'outline'
        return (
          <Badge
            key={`${chip.kind}|${chip.macroClass ?? ''}|${String(chip.approximate)}`}
            size="sm"
            variant={look.variant}
            style={look.style} // ui-check-ok: Badge.style is the look enum, not a CSS style
            dashed={chip.approximate && outlined}
            className={look.className}
            title={`${look.label} · ${chip.macroClass ?? t('chips.classUnknown')}${chip.approximate ? ` (${t('chips.approximate')})` : ''}`}
          >
            <Icon aria-hidden="true" />
            {String(chip.count)}
            {chip.approximate && !outlined ? '~' : ''}
          </Badge>
        )
      })}
      {more > 0 ? (
        <Badge size="sm" variant="neutral" style="fill">
          {`+${String(more)}`}
        </Badge>
      ) : null}
    </div>
  )
}
