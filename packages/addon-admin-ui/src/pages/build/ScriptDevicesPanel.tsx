/**
 * Devices this script owns — name, type, stableId, link to the device detail.
 *
 * Export toggles (Alexa / Google Home / HA / HomeKit) lived here once; each
 * device already has the same section on its own details page, so the list
 * only duplicated four chips per row. Operator 2026-10-04: remove them.
 *
 * Ownership is still `(core-block-<id>, stableId)` — this panel only lists
 * what `reconcileBlockDevices` declared under the Blocks integration.
 */

import { coreBlockAddonId } from '@camstack/types'
import { Badge, DeviceName, useDeviceManagerListAll } from '@camstack/ui-library'
import { Loader2 } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Trans, useTranslation } from 'react-i18next'

const POLL_MS = 5_000

export interface ScriptDevicesPanelProps {
  readonly blockId: string
}

interface FleetRow {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly stableId?: string
}

function parseFleet(data: unknown): readonly FleetRow[] {
  if (!Array.isArray(data)) return []
  const out: FleetRow[] = []
  for (const raw of data) {
    if (raw === null || typeof raw !== 'object') continue
    const id = Reflect.get(raw, 'id')
    const name = Reflect.get(raw, 'name')
    const type = Reflect.get(raw, 'type')
    const stableId = Reflect.get(raw, 'stableId')
    if (typeof id !== 'number' || typeof name !== 'string' || typeof type !== 'string') {
      continue
    }
    out.push({
      id,
      name,
      type,
      ...(typeof stableId === 'string' ? { stableId } : {}),
    })
  }
  return out
}

export function ScriptDevicesPanel({ blockId }: ScriptDevicesPanelProps): ReactNode {
  const { t } = useTranslation()
  const addonId = coreBlockAddonId(blockId)
  const devicesQuery = useDeviceManagerListAll(
    { addonId, projection: 'slim' },
    { refetchInterval: POLL_MS },
  )

  const devices = useMemo(() => parseFleet(devicesQuery.data), [devicesQuery.data])

  if (devicesQuery.isLoading) {
    return (
      <p className="flex items-center gap-2 text-xs text-foreground-subtle">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t('build.scriptDevicesPanel.loading')}
      </p>
    )
  }

  if (devicesQuery.isError) {
    return (
      <p className="text-xs text-danger">
        {t('build.scriptDevicesPanel.couldNotListDevices', 'Could not list devices:')}{' '}
        {devicesQuery.error instanceof Error
          ? devicesQuery.error.message
          : String(devicesQuery.error)}
      </p>
    )
  }

  return (
    <section
      className="space-y-3 rounded border border-border p-3"
      data-testid="script-devices-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">
            {t('build.scriptDevicesPanel.devices', 'Devices')}
          </h4>
          <p className="text-xs text-foreground-subtle">
            <Trans
              i18nKey="build.scriptDevicesPanel.declaredBy"
              values={{ addonId }}
              components={{ code: <code className="text-[11px]" /> }}
            />
          </p>
        </div>
        <Badge variant="default">{devices.length}</Badge>
      </div>

      {devices.length === 0 ? (
        <p className="text-xs text-foreground-subtle">
          <Trans i18nKey="build.scriptDevicesPanel.noDevices" components={{ code: <code /> }} />
        </p>
      ) : (
        <ul className="space-y-3">
          {devices.map((device) => (
            <li
              key={device.id}
              className="rounded border border-border/80 px-3 py-2"
              data-testid={`script-device-${device.id}`}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <Link
                  to={`/devices/${String(device.id)}`}
                  className="text-sm font-medium hover:underline"
                  title={t('build.scriptDevicesPanel.openDeviceDetail', 'Open device detail')}
                >
                  <DeviceName
                    device={{
                      id: device.id,
                      name: device.name,
                      type: device.type,
                      stableId: device.stableId ?? '',
                      parentDeviceId: null,
                    }}
                    form="compact"
                  />
                </Link>
                <Badge variant="info" style="outline">
                  {device.type}
                </Badge>
                {device.stableId !== undefined && (
                  <span className="text-[11px] text-foreground-subtle">
                    stableId <code>{device.stableId}</code>
                  </span>
                )}
                <span className="text-[11px] text-foreground-subtle">#{device.id}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
