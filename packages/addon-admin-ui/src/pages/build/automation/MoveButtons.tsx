/**
 * Up / down for one row or block of a WHEN or IF tree — the same ghost arrows
 * the THEN step list draws (`ActionList`). A null handler is the end of the
 * list: the arrow stays, disabled, so the controls never jump around.
 */
import { Button } from '@camstack/ui-library'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface MoveControls {
  readonly up: (() => void) | null
  readonly down: (() => void) | null
}

export function MoveButtons({ move }: { readonly move: MoveControls }) {
  const { t } = useTranslation()
  const upLabel = t('automation.whenTree.moveUp', 'Move up')
  const downLabel = t('automation.whenTree.moveDown', 'Move down')
  return (
    <>
      <Button
        variant="ghost"
        disabled={move.up === null}
        onClick={move.up ?? undefined}
        aria-label={upLabel}
        title={upLabel}
      >
        <ArrowUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        disabled={move.down === null}
        onClick={move.down ?? undefined}
        aria-label={downLabel}
        title={downLabel}
      >
        <ArrowDown className="h-3.5 w-3.5" />
      </Button>
    </>
  )
}
