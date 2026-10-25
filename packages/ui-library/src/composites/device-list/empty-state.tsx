/**
 * <DeviceListEmptyState> — shown when the filtered device list is empty.
 *
 * Two variants:
 *   - `nofilter` — list is empty AND no filters applied. Operator
 *     hasn't added any devices yet (or the addon hasn't discovered any).
 *   - `filtered` — filters are applied but match nothing. Offer a
 *     reset link to clear filters.
 *   - `pending` — an integration filter could not judge the rows yet (the
 *     integrations query has not answered). Not an absence (D315).
 */
import { type ReactNode } from 'react'
import { Inbox } from 'lucide-react'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'

export interface EmptyStateProps {
  readonly variant: 'nofilter' | 'filtered' | 'pending'
  readonly onClearFilters?: () => void
}

function emptyStateText(variant: EmptyStateProps['variant'], t: UiTextFn): string {
  switch (variant) {
    case 'nofilter':
      return t('uiLibrary.deviceListEmptyState.noDevices', 'No devices yet')
    case 'filtered':
      return t('uiLibrary.deviceListEmptyState.noMatch', 'No devices match the current filters')
    case 'pending':
      return t('uiLibrary.deviceListEmptyState.loadingIntegrations', 'Loading integrations…')
  }
}

export function DeviceListEmptyState({ variant, onClearFilters }: EmptyStateProps): ReactNode {
  const t = useUiText()
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Inbox className="h-8 w-8 text-foreground-subtle/40 mb-3" />
      <p className="text-sm font-medium text-foreground-subtle">{emptyStateText(variant, t)}</p>
      {variant === 'filtered' && onClearFilters && (
        <button
          type="button"
          onClick={onClearFilters}
          className="mt-2 text-[11px] text-primary hover:underline"
        >
          {t('uiLibrary.deviceListEmptyState.clearFilters', 'Clear filters')}
        </button>
      )}
    </div>
  )
}
