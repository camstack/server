import type { ReactNode } from 'react'
import { Separator } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Horizontal = () => (
  <Frame>
    <div className="w-64">
      <div className="text-sm font-medium">Stream settings</div>
      <Separator className="my-3" />
      <div className="text-sm text-foreground-muted">Recording</div>
      <Separator className="my-3" />
      <div className="text-sm text-foreground-muted">Detection</div>
    </div>
  </Frame>
)

export const Vertical = () => (
  <Frame>
    <div className="flex h-8 items-center gap-3 text-sm text-foreground-muted">
      <span>Live</span>
      <Separator orientation="vertical" />
      <span>Recordings</span>
      <Separator orientation="vertical" />
      <span>Events</span>
    </div>
  </Frame>
)
