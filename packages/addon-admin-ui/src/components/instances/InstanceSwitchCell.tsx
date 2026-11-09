/**
 * The on/off switch of one instance record, shared by the instances table and any page that lists
 * the same records (the Calendars list). It shows the record's answered `enabled`, writes only
 * `integrationInstances.setInstanceEnabled`, refreshes the instance queries on success, and says
 * why when the write fails (the switch then still shows the record, never the attempted value).
 */
import { Switch } from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactElement, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InstanceRow } from './instances-model'
import { HOLDER_QUERY_KEY } from './use-instances-data'
import { useSetInstanceEnabled } from './use-set-instance-enabled'

export interface InstanceSwitchCellProps {
  readonly row: Pick<InstanceRow, 'addonId' | 'id' | 'name' | 'enabled'>
  /** How many notification targets pin this instance; 0 shows no hint. */
  readonly pinning: number
  /** A page whose own queries depend on the switch refreshes them here. */
  readonly onChanged?: () => void
}

export function InstanceSwitchCell({
  row,
  pinning,
  onChanged,
}: InstanceSwitchCellProps): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  const setEnabled = useSetInstanceEnabled({
    onSuccess: () => {
      setFailure(null)
      void queryClient.invalidateQueries({ queryKey: [HOLDER_QUERY_KEY] })
      onChanged?.()
    },
    onError: setFailure,
  })
  return (
    <span className="flex flex-col items-end gap-1">
      <Switch
        checked={row.enabled}
        disabled={setEnabled.isPending}
        aria-label={t('providerInstances.enable', 'Enable {{name}}', { name: row.name })}
        data-testid={`instance-switch-${row.id}`}
        onCheckedChange={(enabled) => {
          setFailure(null)
          setEnabled.mutate({ addonId: row.addonId, id: row.id, enabled })
        }}
      />
      {pinning > 0 && (
        <span className="text-[11px] text-foreground-subtle">
          {t('providerInstances.pinnedBy', { count: pinning })}
        </span>
      )}
      {failure !== null && (
        <span className="text-[11px] text-danger" role="alert">
          {t('providerInstances.switchFailed', 'Could not change {{name}}: {{message}}', {
            name: row.name,
            message: failure,
          })}
        </span>
      )}
    </span>
  )
}
