import type { ReactNode } from 'react'
import { SemanticBadge } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Hero = () => (
  <Frame>
    <div className="flex items-center gap-2">
      <span className="text-sm text-foreground">Front Door</span>
      <SemanticBadge variant="success">Online</SemanticBadge>
      <SemanticBadge variant="info">Recording</SemanticBadge>
    </div>
  </Frame>
)

export const Variants = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-2">
      <SemanticBadge variant="success">Online</SemanticBadge>
      <SemanticBadge variant="warning">Degraded</SemanticBadge>
      <SemanticBadge variant="danger">Offline</SemanticBadge>
      <SemanticBadge variant="info">Recording</SemanticBadge>
      <SemanticBadge variant="neutral">Idle</SemanticBadge>
    </div>
  </Frame>
)

export const Mono = () => (
  <Frame>
    <div className="flex items-center gap-2">
      <SemanticBadge variant="success" mono>
        v0.2.1
      </SemanticBadge>
      <SemanticBadge variant="warning" mono>
        v0.3.0-beta.4
      </SemanticBadge>
      <SemanticBadge variant="neutral" mono>
        H.265
      </SemanticBadge>
    </div>
  </Frame>
)

export const ProviderTags = () => (
  <Frame>
    <div className="flex flex-wrap items-center gap-2">
      <SemanticBadge variant="info">ONVIF</SemanticBadge>
      <SemanticBadge variant="info">Hikvision</SemanticBadge>
      <SemanticBadge variant="neutral">RTSP</SemanticBadge>
      <SemanticBadge variant="success">Reolink</SemanticBadge>
    </div>
  </Frame>
)
