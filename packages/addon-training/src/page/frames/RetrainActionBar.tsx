/**
 * The strip under the canvas — what finishes a frame: the "every subject is
 * boxed" tick, accept-all for the proposals still waiting, Save, and (below `lg`,
 * where the subject list is a drawer) the button that opens it.
 *
 * It is outside the scrolling list on purpose: Save must be one tap away
 * whatever the list is doing, on a phone included.
 */
import { Button, Checkbox, Tooltip, TooltipContent, TooltipTrigger } from '@camstack/ui-library'
import { CheckCheck, ListTree } from 'lucide-react'
import type { JSX } from 'react'
import { useT } from '../../i18n/index.js'

export interface RetrainActionBarProps {
  readonly subjectCount: number
  readonly drawerOpen: boolean
  readonly onToggleDrawer: () => void
  readonly drafts: number
  readonly onAcceptAll: () => void
  readonly complete: boolean
  readonly completeDisabled: boolean
  readonly onCompleteChange: (complete: boolean) => void
  readonly canSave: boolean
  readonly saving: boolean
  readonly dirty: boolean
  readonly onSave: () => void
}

export function RetrainActionBar({
  subjectCount,
  drawerOpen,
  onToggleDrawer,
  drafts,
  onAcceptAll,
  complete,
  completeDisabled,
  onCompleteChange,
  canSave,
  saving,
  dirty,
  onSave,
}: RetrainActionBarProps): JSX.Element {
  const { t } = useT()
  return (
    <div
      data-testid="retrain-action-bar"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-surface px-2 py-1.5"
    >
      <Button
        variant={drawerOpen ? 'secondary' : 'ghost'}
        size="sm"
        className="lg:hidden"
        aria-expanded={drawerOpen}
        aria-controls="retrain-subjects-panel"
        onClick={onToggleDrawer}
      >
        <ListTree className="h-3.5 w-3.5" />
        <span className="ml-1">{t('actionBar.subjects', { count: subjectCount })}</span>
      </Button>
      <Tooltip>
        <TooltipTrigger>
          <label className="flex items-center gap-1.5 text-[11px] text-foreground">
            <Checkbox
              aria-label={t('actionBar.allBoxedLabel')}
              checked={complete}
              disabled={completeDisabled}
              onChange={(event) => {
                onCompleteChange(event.target.checked)
              }}
            />
            {t('actionBar.allBoxed')}
          </label>
        </TooltipTrigger>
        <TooltipContent className="w-64 whitespace-normal text-left">
          {t('actionBar.allBoxedHint')}
        </TooltipContent>
      </Tooltip>
      <span className="flex-1" />
      {drafts > 0 && (
        <Button variant="secondary" size="sm" onClick={onAcceptAll}>
          <CheckCheck className="h-3 w-3" />
          <span className="ml-1">{t('actionBar.acceptDrafts', { count: drafts })}</span>
        </Button>
      )}
      <Button size="sm" disabled={!canSave || saving || !dirty} onClick={onSave}>
        {t('actionBar.saveFrame')}
      </Button>
    </div>
  )
}
