import type { ReactNode } from 'react'
import { StatCard } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Hero = () => (
  <Frame>
    <div className="w-56">
      <StatCard value={12} label="Cameras online" trend={{ value: 8, direction: 'up' }} />
    </div>
  </Frame>
)

export const Grid = () => (
  <Frame>
    <div className="grid grid-cols-2 gap-3 w-[28rem]">
      <StatCard value={12} label="Cameras online" trend={{ value: 8, direction: 'up' }} />
      <StatCard value={347} label="Events today" trend={{ value: 12, direction: 'down' }} />
      <StatCard value="4.2 TB" label="Storage used" />
      <StatCard value="99.8%" label="Uptime" trend={{ value: 2, direction: 'up' }} />
    </div>
  </Frame>
)

export const TrendDown = () => (
  <Frame>
    <div className="w-56">
      <StatCard
        value="18 Mbps"
        label="Aggregate bitrate"
        trend={{ value: 23, direction: 'down' }}
      />
    </div>
  </Frame>
)

export const NoTrend = () => (
  <Frame>
    <div className="w-56">
      <StatCard value={3} label="Detections / min" />
    </div>
  </Frame>
)
