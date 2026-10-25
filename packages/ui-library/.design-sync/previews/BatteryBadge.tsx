import type { ReactNode } from 'react'
import { BatteryBadge } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Levels = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-4">
      <BatteryBadge status={{ percentage: 92, charging: 'none', sleeping: false }} />
      <BatteryBadge status={{ percentage: 58, charging: 'none', sleeping: false }} />
      <BatteryBadge status={{ percentage: 24, charging: 'none', sleeping: false }} />
      <BatteryBadge status={{ percentage: 7, charging: 'none', sleeping: false }} />
    </div>
  </Frame>
)

export const ChargingAndSleeping = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-4">
      <BatteryBadge status={{ percentage: 64, charging: 'dc', sleeping: false }} />
      <BatteryBadge status={{ percentage: 81, charging: 'solar', sleeping: false }} />
      <BatteryBadge status={{ percentage: 40, charging: 'none', sleeping: true }} />
    </div>
  </Frame>
)

export const FullVariant = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-4">
      <BatteryBadge
        variant="full"
        status={{ percentage: 73, charging: 'solar', sleeping: false }}
      />
      <BatteryBadge variant="full" status={{ percentage: 55, charging: 'dc', sleeping: true }} />
    </div>
  </Frame>
)

export const BinarySource = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-4">
      <BatteryBadge status={{ percentage: 100, charging: 'none', sleeping: false, binary: true }} />
      <BatteryBadge status={{ percentage: 20, charging: 'none', sleeping: false, binary: true }} />
    </div>
  </Frame>
)

export const InTile = () => (
  <Frame>
    <div className="flex items-center justify-between gap-3 rounded-lg bg-surface border border-border px-3 py-2 w-72">
      <span className="text-sm text-foreground">Driveway (Reolink Argus)</span>
      <BatteryBadge status={{ percentage: 38, charging: 'solar', sleeping: true }} />
    </div>
  </Frame>
)
