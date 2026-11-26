/**
 * Edit and active switch of a Lists row: the pencil opens the items editor, the
 * switch is the stored list's `enabled` (a draft the tab's one Save writes).
 * The switch exists once the list is stored: a row that only shows the native
 * items has nothing to switch off.
 */
import { IconButton } from '@camstack/ui-library'
import { Pencil } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { currentComposition } from '../customization-read'
import { featureOf, withFeature } from '../customization-save'
import type { CustomizationHandle } from '../use-customization'
import { RowActiveSwitch } from './RowActiveSwitch'
import type { CustomizeRowSpec } from './customize-rows'

export interface KeyedActionsCellProps {
  readonly spec: CustomizeRowSpec
  readonly title: string
  readonly handle: CustomizationHandle
  readonly onEdit: () => void
  readonly onError: (reason: string | null) => void
}

export function KeyedActionsCell({
  spec,
  title,
  handle,
  onEdit,
  onError,
}: KeyedActionsCellProps): ReactNode {
  const { t } = useTranslation()
  const current = currentComposition(handle.state)
  const stored = featureOf(current, spec.cap)
  const answered = handle.state.kind === 'none' || handle.state.kind === 'present'
  return (
    <span className="flex items-center justify-end gap-1">
      <IconButton
        variant="ghost"
        size="sm"
        icon={Pencil}
        aria-label={t('customize.table.editWhat', { title })}
        data-testid={`customize-manage-${spec.key}`}
        onClick={onEdit}
      />
      {stored !== null && current !== null && (
        <RowActiveSwitch
          title={title}
          checked={stored.enabled !== false}
          disabled={!answered || handle.saving}
          testId={`keyed-active-${spec.key}`}
          onChange={(enabled) =>
            void handle
              .save(withFeature(current, handle.target, { ...stored, enabled }))
              .then((outcome) => onError(outcome.kind === 'refused' ? outcome.reason : null))
          }
        />
      )}
    </span>
  )
}
