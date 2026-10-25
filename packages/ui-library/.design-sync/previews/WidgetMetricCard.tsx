import type { ReactNode } from 'react'
import { WidgetMetricCard } from '@camstack/ui-library'
import { Clock, Film, HardDrive, Video } from 'lucide-react'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Hero = () => (
  <Frame>
    <div style={{ width: 220 }}>
      <WidgetMetricCard
        label="Frame total"
        icon={<Film className="h-3 w-3" />}
        footer="3 segment ranges"
      >
        128,540
      </WidgetMetricCard>
    </div>
  </Frame>
)

export const WithoutIcon = () => (
  <Frame>
    <div style={{ width: 220 }}>
      <WidgetMetricCard label="Detections today" footer="person · car · package">
        42
      </WidgetMetricCard>
    </div>
  </Frame>
)

export const Storage = () => (
  <Frame>
    <div style={{ width: 220 }}>
      <WidgetMetricCard
        label="Recording size"
        icon={<HardDrive className="h-3 w-3" />}
        footer="of 2 TB quota"
      >
        318 GB
      </WidgetMetricCard>
    </div>
  </Frame>
)

export const Grid = () => (
  <Frame>
    <div className="grid grid-cols-2 gap-2" style={{ width: 460 }}>
      <WidgetMetricCard
        label="Uptime"
        icon={<Clock className="h-3 w-3" />}
        footer="since last reboot"
      >
        14d 6h
      </WidgetMetricCard>
      <WidgetMetricCard
        label="Active streams"
        icon={<Video className="h-3 w-3" />}
        footer="2 WebRTC · 1 MJPEG"
      >
        3
      </WidgetMetricCard>
    </div>
  </Frame>
)
