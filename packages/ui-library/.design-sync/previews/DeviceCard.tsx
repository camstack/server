import type { ReactNode } from 'react'
import { DeviceCard } from '@camstack/ui-library'
import { Move, Bell, Camera, Plug } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

export const Hero = () => (
  <Frame>
    <div style={{ width: 240 }}>
      <DeviceCard
        title="Front Door"
        subtitle="Reolink · 192.168.10.42"
        status="online"
        badges={[{ label: '2560×1920' }, { label: 'main' }, { label: 'sub' }]}
        actions={[
          { icon: <Move className="h-3.5 w-3.5" />, label: 'PTZ', onClick: noop },
          { icon: <Bell className="h-3.5 w-3.5" />, label: 'Events', onClick: noop },
          { icon: <Camera className="h-3.5 w-3.5" />, label: 'Snapshot', onClick: noop },
        ]}
      />
    </div>
  </Frame>
)

export const Selected = () => (
  <Frame>
    <div style={{ width: 240 }}>
      <DeviceCard
        title="Backyard"
        subtitle="ONVIF · restreamer"
        status="online"
        selected
        badges={[{ label: '1920×1080' }, { label: 'Recording' }]}
        actions={[{ icon: <Bell className="h-3.5 w-3.5" />, label: 'Events', onClick: noop }]}
      />
    </div>
  </Frame>
)

export const Offline = () => (
  <Frame>
    <div style={{ width: 240 }}>
      <DeviceCard
        title="Garage"
        subtitle="Hikvision · RTSP"
        status="offline"
        offlineAction={
          <button className="w-full rounded-md border border-border bg-surface-hover px-2 py-1 text-[11px] text-foreground inline-flex items-center justify-center gap-1">
            <Plug className="h-3 w-3" /> Connect
          </button>
        }
      />
    </div>
  </Frame>
)

export const Warning = () => (
  <Frame>
    <div style={{ width: 240 }}>
      <DeviceCard
        title="Driveway"
        subtitle="Home Assistant · degraded"
        status="warning"
        badges={[{ label: 'Reconnecting' }]}
      />
    </div>
  </Frame>
)

export const Statuses = () => (
  <Frame>
    <div className="grid grid-cols-2 gap-2" style={{ width: 500 }}>
      <DeviceCard title="Front Door" subtitle="Online" status="online" />
      <DeviceCard title="Garage" subtitle="Offline" status="offline" />
      <DeviceCard title="Driveway" subtitle="Warning" status="warning" />
      <DeviceCard title="Side Gate" subtitle="Unknown" status="unknown" />
    </div>
  </Frame>
)
