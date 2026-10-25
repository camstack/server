import type { ReactNode } from 'react'
import { Card, Badge } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Hero = () => (
  <Frame>
    <Card variant="bordered" className="w-64">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Backyard</span>
        <Badge variant="danger">Recording</Badge>
      </div>
      <div className="mt-2 aspect-video rounded-md bg-surface-hover" />
      <div className="mt-2 flex items-center justify-between text-xs text-foreground-muted">
        <span>ONVIF</span>
        <span>1920×1080</span>
      </div>
    </Card>
  </Frame>
)

export const Variants = () => (
  <Frame>
    <div className="flex gap-3">
      <Card variant="flat" className="w-40">
        <div className="text-sm font-medium">Garage</div>
        <div className="mt-1 text-xs text-foreground-muted">flat</div>
      </Card>
      <Card variant="bordered" className="w-40">
        <div className="text-sm font-medium">Driveway</div>
        <div className="mt-1 text-xs text-foreground-muted">bordered</div>
      </Card>
    </div>
  </Frame>
)

export const StatGrid = () => (
  <Frame>
    <div className="grid grid-cols-3 gap-3">
      <Card variant="bordered">
        <div className="text-xs text-foreground-muted">Cameras</div>
        <div className="mt-1 text-lg font-semibold">12</div>
      </Card>
      <Card variant="bordered">
        <div className="text-xs text-foreground-muted">Online</div>
        <div className="mt-1 text-lg font-semibold text-success">11</div>
      </Card>
      <Card variant="bordered">
        <div className="text-xs text-foreground-muted">Offline</div>
        <div className="mt-1 text-lg font-semibold text-danger">1</div>
      </Card>
    </div>
  </Frame>
)
