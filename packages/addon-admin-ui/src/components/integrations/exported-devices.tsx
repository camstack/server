/**
 * The pieces a device-export row adds to the shared instances table: the "Devices" column
 * (what the target exposes, opening the devices list) and the setup block (pairing QR, links)
 * at the top of an instance's edit dialog. Both read the `device-export` cap only — no vendor.
 */
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DeviceExportInstancePanel,
  DeviceExportPanel,
  DeviceExportSetup,
  useDeviceExportGetStatus,
  type DataColumn,
} from '@camstack/ui-library'
import { DeviceExportStatusSchema } from '@camstack/types'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { PanelRow } from '../instances/instances-model'

const POLL_INTERVAL_MS = 10_000

function ExportedDevicesCell({ row }: { readonly row: PanelRow }): ReactElement | null {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const instanceId = row.kind === 'instance' ? row.id : undefined
  const { data } = useDeviceExportGetStatus(
    {
      addonId: row.addonId,
      ...(instanceId !== undefined ? { instanceId } : {}),
    },
    { refetchInterval: POLL_INTERVAL_MS, retry: false },
  )
  // Unanswered or malformed stays blank: not-yet-known must not read as "0 exported" (D315).
  const parsed = DeviceExportStatusSchema.safeParse(data)
  if (!parsed.success) return null
  if (row.kind === 'instance' && !row.enabled) return null
  const count = parsed.data.exposedDeviceCount
  return (
    <>
      <Button variant="ghost" size="sm" type="button" onClick={() => setOpen(true)}>
        {t('system.connectivity.devicesExported', '{{count}} devices exported', { count })}
      </Button>
      {open && (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent width="full" scroll="body">
            <DialogHeader>
              <DialogTitle>
                {t('system.connectivity.devicesDialogTitle', 'Devices of {{name}}', {
                  name: row.name,
                })}
              </DialogTitle>
            </DialogHeader>
            <DialogBody>
              {instanceId !== undefined ? (
                <DeviceExportInstancePanel
                  addonId={row.addonId}
                  instance={{ instanceId, name: row.name, enabled: true }}
                  showSetup={false}
                />
              ) : (
                <DeviceExportPanel addonId={row.addonId} showSetup={false} />
              )}
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

/** The "Devices" column of an exporters table. */
export function exportedDevicesColumn(t: TFunction): DataColumn<PanelRow> {
  return {
    key: 'devices',
    header: t('system.connectivity.devicesColumn', 'Devices'),
    notSortableReason: t(
      'system.connectivity.devicesNotSortable',
      'A button that opens the list is not a value to order by.',
    ),
    render: (row) => <ExportedDevicesCell row={row} />,
  }
}

/** The pairing and account block of one export target, for the top of its edit dialog. */
export function ExportSetupLead({
  addonId,
  instanceId,
}: {
  readonly addonId: string
  readonly instanceId: string
}): ReactElement {
  return <DeviceExportSetup addonId={addonId} instanceId={instanceId} />
}
