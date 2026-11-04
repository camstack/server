/**
 * A list in a Customize value cell: the count, then the first names.
 * The full list is the tooltip (and the row's editor).
 */
import { Tooltip, TooltipContent, TooltipTrigger } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { listPreview } from './list-value'

export interface ListValueTextProps {
  readonly labels: readonly string[]
}

export function ListValueText({ labels }: ListValueTextProps): ReactNode {
  const { t } = useTranslation()
  const preview = listPreview(labels)
  const full = preview.labels.join(', ')
  const shown = `${preview.shown.join(', ')}${preview.truncated ? '…' : ''}`
  const text = `${t('customize.table.listCount', { count: preview.labels.length })}: ${shown}`
  return (
    <Tooltip className="block w-full min-w-0">
      <TooltipTrigger>
        <span className="block truncate text-xs text-foreground" data-testid="list-value-shown">
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent className="whitespace-normal max-w-xs text-left">{full}</TooltipContent>
    </Tooltip>
  )
}
