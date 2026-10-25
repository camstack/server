import type { ReactNode } from 'react'
import { DeviceGrid, DeviceCard } from '@camstack/ui-library'
import { Move, Bell } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground rounded-lg" style={{ width: 720 }}>
    {children}
  </div>
)

const noop = () => {}

const CAMS = [
  { title: 'Front Door', subtitle: 'Reolink · 2560×1920', status: 'online' as const },
  { title: 'Backyard', subtitle: 'ONVIF · Recording', status: 'online' as const },
  { title: 'Driveway', subtitle: 'Hikvision · 1920×1080', status: 'online' as const },
  { title: 'Garage', subtitle: 'RTSP · offline', status: 'offline' as const },
  { title: 'Side Gate', subtitle: 'Home Assistant', status: 'warning' as const },
  { title: 'Porch', subtitle: 'Reolink · main', status: 'online' as const },
]

export const Hero = () => (
  <Frame>
    <DeviceGrid minCardWidth={200}>
      {CAMS.map((c) => (
        <DeviceCard
          key={c.title}
          {...c}
          badges={[{ label: 'main' }, { label: 'sub' }]}
          actions={[
            { icon: <Move className="h-3.5 w-3.5" />, label: 'PTZ', onClick: noop },
            { icon: <Bell className="h-3.5 w-3.5" />, label: 'Events', onClick: noop },
          ]}
        />
      ))}
    </DeviceGrid>
  </Frame>
)

export const TwoColumn = () => (
  <Frame>
    <DeviceGrid minCardWidth={320} gap={4}>
      {CAMS.slice(0, 4).map((c) => (
        <DeviceCard key={c.title} {...c} badges={[{ label: '1080p' }]} />
      ))}
    </DeviceGrid>
  </Frame>
)
