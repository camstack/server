import type { ReactNode } from 'react'
import { Input } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

export const Default = () => (
  <Frame>
    <div className="flex flex-col gap-2 w-72">
      <Input placeholder="Camera name" defaultValue="Front Door" />
      <Input placeholder="rtsp://192.168.10.50:554/stream" />
    </div>
  </Frame>
)

export const Invalid = () => (
  <Frame>
    <div className="w-72">
      <Input state="error" defaultValue="not-a-valid-host" />
    </div>
  </Frame>
)

export const Disabled = () => (
  <Frame>
    <div className="w-72">
      <Input placeholder="Read-only" disabled defaultValue="locked-value" />
    </div>
  </Frame>
)
