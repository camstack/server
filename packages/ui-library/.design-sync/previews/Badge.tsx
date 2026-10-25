import type { ReactNode } from 'react'
import { Badge } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Hero = () => (
  <Frame>
    <div className="flex items-center gap-2">
      <span className="text-sm text-foreground-muted">Front Door</span>
      <Badge variant="success">Online</Badge>
      <Badge variant="danger">Recording</Badge>
      <Badge variant="info">ONVIF</Badge>
    </div>
  </Frame>
)

export const Variants = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="default">Idle</Badge>
      <Badge variant="success">Online</Badge>
      <Badge variant="warning">Reconnecting</Badge>
      <Badge variant="danger">Offline</Badge>
      <Badge variant="info">Hikvision</Badge>
    </div>
  </Frame>
)

export const Outline = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="default" style="outline">
        RTSP
      </Badge>
      <Badge variant="success" style="outline">
        2560×1920
      </Badge>
      <Badge variant="warning" style="outline">
        Low battery
      </Badge>
      <Badge variant="info" style="outline">
        Home Assistant
      </Badge>
    </div>
  </Frame>
)

export const DetectionLabels = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="info">person</Badge>
      <Badge variant="info">car</Badge>
      <Badge variant="warning">package</Badge>
      <Badge variant="success">dog</Badge>
    </div>
  </Frame>
)
