/**
 * Action half of `SourceSelector` for the Linked actions row: the shared
 * {@link DevicePicker} over the actions that exist and are not linked yet. A
 * pick is a draft the host confirms; nothing is linked on its own (D356).
 */
import type { ActionEntry } from '@camstack/types'
import { DevicePicker, type PickerItem } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface SourceSelectorActionsProps {
  readonly kind: 'actions'
  /** The actions on offer: every one that is not linked yet. */
  readonly entries: readonly ActionEntry[]
  readonly picked: readonly string[]
  readonly onPickedChange: (ids: readonly string[]) => void
}

export function SourceSelectorActions({
  entries,
  picked,
  onPickedChange,
}: SourceSelectorActionsProps): ReactNode {
  const { t } = useTranslation()
  const items: readonly PickerItem<string>[] = entries.map((entry) => ({
    id: entry.id,
    name: entry.name,
    type: entry.readOnly ? entry.addonId : t('actions.source.internal', 'Internal'),
  }))
  return (
    <div data-testid="source-selector" className="flex flex-col gap-2">
      <DevicePicker<string>
        devices={items}
        listState="answered"
        value={picked}
        onChange={onPickedChange}
        noun="action"
        emptyLabel={t('customize.linkedActions.nothingToLink')}
        showAll
        testId="customize-action-picker"
      />
    </div>
  )
}
