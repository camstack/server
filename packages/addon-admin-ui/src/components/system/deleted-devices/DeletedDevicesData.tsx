/**
 * Data → Deleted devices (D865).
 *
 * Devices deleted before the system recorded deletions left their data behind
 * (footage, events, history, per-addon settings). This lists, per store, the
 * data held for device ids that device-manager no longer knows, and deletes it
 * only after an explicit confirm that shows the counts.
 *
 * The scan is a DRY RUN. device-manager decides absence from two answered reads
 * of the device list and refuses (status `skipped`, with the reason) when a read
 * failed or looks wrong — the page then says so and offers nothing to delete.
 */
import {
  Button,
  DataTable,
  type DataColumn,
  useConfirm,
  useDeviceManagerCleanupDeletedDevicesData,
} from '@camstack/ui-library'
import { Loader2, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface OrphanRow {
  readonly deviceId: number
  readonly stores: Readonly<Record<string, number>>
}

interface ScanResult {
  readonly status: 'skipped' | 'dry-run' | 'cleaned'
  readonly reason: string | null
  readonly devices: readonly OrphanRow[]
  readonly unreachable: readonly string[]
}

function storesLabel(stores: Readonly<Record<string, number>>): string {
  return Object.entries(stores)
    .map(([store, count]) => `${store} ${count}`)
    .join(' · ')
}

function total(devices: readonly OrphanRow[]): number {
  return devices.reduce((sum, d) => sum + Object.values(d.stores).reduce((s, n) => s + n, 0), 0)
}

export function DeletedDevicesData() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const cleanup = useDeviceManagerCleanupDeletedDevicesData()
  const [result, setResult] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (confirmed: boolean): Promise<void> => {
    setError(null)
    try {
      setResult(await cleanup.mutateAsync({ confirm: confirmed }))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const onDelete = async (): Promise<void> => {
    if (result === null || result.status !== 'dry-run') return
    const ok = await confirm({
      title: t('systemPage.deletedDevices.confirmTitle', 'Delete the data of deleted devices?'),
      message: result.devices.map((d) => `#${d.deviceId}: ${storesLabel(d.stores)}`).join('\n'),
      confirmLabel: t('systemPage.deletedDevices.confirmLabel', 'Delete'),
      variant: 'danger',
    })
    if (ok) await run(true)
  }

  const columns: readonly DataColumn<OrphanRow>[] = [
    {
      key: 'device',
      header: t('systemPage.deletedDevices.device', 'Device'),
      render: (row) => `#${row.deviceId}`,
    },
    {
      key: 'stores',
      header: t('systemPage.deletedDevices.stores', 'Data held'),
      nowrap: false,
      render: (row) => storesLabel(row.stores),
    },
  ]

  return (
    <div className="space-y-4" data-testid="deleted-devices-data">
      <p className="text-sm text-foreground-muted">
        {t(
          'systemPage.deletedDevices.intro',
          'Data that still belongs to devices that were deleted before deletions were recorded: footage, events, history and per-addon settings. Scanning deletes nothing; deleting asks first and shows what goes.',
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => void run(false)}
          disabled={cleanup.isPending}
          data-testid="deleted-devices-scan"
        >
          {cleanup.isPending ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Search className="mr-2 h-4 w-4" />
          )}
          {t('systemPage.deletedDevices.scan', 'Scan')}
        </Button>
        {result?.status === 'dry-run' && result.devices.length > 0 ? (
          <Button
            variant="danger"
            onClick={() => void onDelete()}
            disabled={cleanup.isPending}
            data-testid="deleted-devices-delete"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('systemPage.deletedDevices.delete', 'Delete the data of {{count}} devices…', {
              count: result.devices.length,
            })}
          </Button>
        ) : null}
      </div>

      {error !== null ? <p className="text-sm text-danger">{error}</p> : null}

      {result?.status === 'skipped' ? (
        <p className="text-sm text-warning" data-testid="deleted-devices-skipped">
          {t(
            'systemPage.deletedDevices.skipped',
            'Nothing was listed or deleted: the device list could not be trusted ({{reason}}). Try again.',
            { reason: result.reason ?? '' },
          )}
        </p>
      ) : null}

      {result !== null && result.status !== 'skipped' ? (
        <>
          <p className="text-sm" data-testid="deleted-devices-summary">
            {result.status === 'cleaned'
              ? t(
                  'systemPage.deletedDevices.cleaned',
                  'Deleted {{rows}} items of {{count}} devices.',
                  {
                    rows: total(result.devices),
                    count: result.devices.length,
                  },
                )
              : t(
                  'systemPage.deletedDevices.found',
                  '{{count}} deleted devices still hold {{rows}} items.',
                  {
                    rows: total(result.devices),
                    count: result.devices.length,
                  },
                )}
          </p>
          <DataTable
            columns={columns}
            rows={result.devices}
            rowKey={(row) => row.deviceId}
            emptyMessage={t(
              'systemPage.deletedDevices.none',
              'No data belongs to a deleted device.',
            )}
          />
          {result.unreachable.length > 0 ? (
            <p className="text-xs text-foreground-muted">
              {t('systemPage.deletedDevices.unreachable', 'Not asked (unreachable): {{names}}', {
                names: result.unreachable.join(', '),
              })}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
