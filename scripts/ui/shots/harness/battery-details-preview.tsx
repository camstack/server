/**
 * Fixture page for the battery badge and its details panel, as the device
 * detail header shows them. Not an admin route: `ui:shots` mounts it when the
 * path is `/battery-details-preview`. The panel is rendered open and static
 * (the popover only opens on click), framed like the popover content.
 */
import * as library from '@camstack/ui-library'
import { BatteryBadge, ThemeProvider } from '@camstack/ui-library'
import type { ReactElement } from 'react'

const NOW = Date.now()

const SOLAR_CHARGING = {
  level: 76,
  charging: 'solar',
  sleeping: true,
  voltage: 4.02,
  chargeState: 'charging',
  currentMa: 310,
  temperatureC: 23.5,
  lastContactAt: NOW - 12 * 60_000,
} as const

const SPARSE = { level: 54, charging: 'none', sleeping: false } as const

function Header({
  status,
}: {
  readonly status: typeof SOLAR_CHARGING | typeof SPARSE
}): ReactElement {
  const { BatteryDetails, batteryDetailRows } = library
  const panel =
    BatteryDetails !== undefined && batteryDetailRows !== undefined ? (
      <div className="w-fit min-w-[220px] rounded-lg border border-border bg-surface p-2 shadow-lg">
        <BatteryDetails rows={batteryDetailRows(status)} />
      </div>
    ) : null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h1 className="text-sm font-semibold text-foreground sm:text-base">Garden</h1>
        <BatteryBadge status={status} variant="full" />
      </div>
      {panel}
    </div>
  )
}

export function BatteryDetailsPreview(): ReactElement {
  return (
    <ThemeProvider>
      <div className="flex min-h-screen flex-col gap-6 bg-background p-4">
        <Header status={SOLAR_CHARGING} />
        <Header status={SPARSE} />
      </div>
    </ThemeProvider>
  )
}
