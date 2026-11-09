/**
 * The on/off switch of every imported calendar, on the Calendars page. Each (account, calendar)
 * is a `calendar` integration instance whose `enabled` flag the sources honour, so a switched-off
 * calendar leaves the legend and the events; it stays listed HERE so it can be switched back on.
 * The switch shows the record's answered state and writes only `setInstanceEnabled`.
 */
import { ErrorBox, Skeleton, Switch } from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { type ReactElement, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InstanceRow } from '../instances/instances-model'
import { HOLDER_QUERY_KEY, useInstancesData } from '../instances/use-instances-data'
import { useSetInstanceEnabled } from '../instances/use-set-instance-enabled'

const CALENDAR_SOURCE_CAP = 'calendar-source'

export function CalendarSourceSwitches(): ReactElement | null {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const data = useInstancesData(CALENDAR_SOURCE_CAP)
  const [failure, setFailure] = useState<{ readonly id: string; readonly message: string } | null>(
    null,
  )
  const writing = useRef<string>('')
  const setEnabled = useSetInstanceEnabled({
    onError: (message) => setFailure({ id: writing.current, message }),
    onSuccess: () => {
      setFailure(null)
      // Sources answer only enabled calendars: the list and the events follow the switch.
      void queryClient.invalidateQueries()
    },
  })
  const rows = data.rows.filter((r): r is InstanceRow => r.kind === 'instance')

  const toggle = (row: InstanceRow, enabled: boolean): void => {
    setFailure(null)
    writing.current = row.id
    setEnabled.mutate({ addonId: row.addonId, id: row.id, enabled })
  }

  if (data.state === 'pending') {
    return <Skeleton className="h-16 w-full" data-testid="calendar-switches-pending" />
  }
  if (data.state === 'error') {
    return (
      <ErrorBox
        title={t('systemPage.calendars.switchesError', 'Could not load the calendar switches')}
        message={data.error ?? ''}
        onRetry={data.refetch}
      />
    )
  }
  if (rows.length === 0) return null

  return (
    <section className="w-full space-y-2 lg:w-56 xl:w-64" data-testid="calendar-switches">
      <h2 className="text-xs font-medium text-foreground-subtle">
        {t('systemPage.calendars.importedCalendars', 'Imported calendars')}
      </h2>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.key} className="space-y-1 rounded-md px-1.5 py-1.5 hover:bg-surface">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div
                  className={`truncate text-sm font-medium ${row.enabled ? 'text-foreground' : 'text-foreground-subtle'}`}
                >
                  {row.name}
                </div>
                <div className="truncate text-[11px] text-foreground-subtle">
                  {row.providerName}
                </div>
              </div>
              <Switch
                checked={row.enabled}
                disabled={setEnabled.isPending}
                aria-label={t('systemPage.calendars.importCalendar', 'Import {{name}}', {
                  name: row.name,
                })}
                data-testid={`calendar-switch-${row.id}`}
                onCheckedChange={(enabled) => toggle(row, enabled)}
              />
            </div>
            {failure?.id === row.id && (
              <p className="text-[11px] text-danger" role="alert">
                {t('systemPage.calendars.switchFailed', 'Could not change {{name}}: {{message}}', {
                  name: row.name,
                  message: failure.message,
                })}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
