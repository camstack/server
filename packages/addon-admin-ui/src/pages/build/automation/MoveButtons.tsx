/**
 * Up / down for one row or block of a WHEN or IF tree, and for a THEN step.
 * Both arrows are always drawn: a null handler is the end of the list, and
 * that arrow stays, disabled, with the reason as its tooltip — the controls
 * never jump around and an edge never looks like a missing feature.
 *
 * A disabled `Button` takes no pointer events, so the tooltip sits on the
 * wrapper around it.
 */
import { Button } from '@camstack/ui-library'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface MoveControls {
  readonly up: (() => void) | null
  readonly down: (() => void) | null
}

/** What each arrow says when it moves, and why it cannot at an edge. */
export interface MoveTexts {
  readonly up: string
  readonly down: string
  readonly atFirst: string
  readonly atLast: string
}

export interface MoveButtonsProps {
  readonly move: MoveControls
  /** Defaults to the WHEN / IF tree's wording. */
  readonly texts?: MoveTexts
}

interface MoveArrowProps {
  readonly onMove: (() => void) | null
  readonly label: string
  readonly reason: string
  readonly testId: string
  readonly children: ReactNode
}

function MoveArrow({ onMove, label, reason, testId, children }: MoveArrowProps) {
  const title = onMove === null ? reason : label
  return (
    <span className="inline-flex" title={title} data-testid={`${testId}-wrap`}>
      <Button
        variant="ghost"
        disabled={onMove === null}
        onClick={onMove ?? undefined}
        aria-label={label}
        title={title}
        data-testid={testId}
      >
        {children}
      </Button>
    </span>
  )
}

export function MoveButtons({ move, texts }: MoveButtonsProps) {
  const { t } = useTranslation()
  const words: MoveTexts = texts ?? {
    up: t('automation.whenTree.moveUp', 'Move up'),
    down: t('automation.whenTree.moveDown', 'Move down'),
    atFirst: t('automation.whenTree.alreadyFirst', 'Already first in this block'),
    atLast: t('automation.whenTree.alreadyLast', 'Already last in this block'),
  }
  return (
    <>
      <MoveArrow onMove={move.up} label={words.up} reason={words.atFirst} testId="move-up">
        <ArrowUp className="h-3.5 w-3.5" />
      </MoveArrow>
      <MoveArrow onMove={move.down} label={words.down} reason={words.atLast} testId="move-down">
        <ArrowDown className="h-3.5 w-3.5" />
      </MoveArrow>
    </>
  )
}
