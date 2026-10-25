import type { ReactNode } from 'react'
import { TimezoneSelector } from '@camstack/ui-library'

const Frame = ({ children }: { children: ReactNode }) => (
  <div className="dark bg-background text-foreground p-5 rounded-lg">{children}</div>
)

const noop = () => {}

export const Hero = () => (
  <Frame>
    <div className="w-72 space-y-1.5">
      <label className="text-xs font-medium text-foreground-subtle">Hub timezone</label>
      <TimezoneSelector value="Europe/Rome" onChange={noop} />
    </div>
  </Frame>
)

export const Disabled = () => (
  <Frame>
    <div className="w-72 space-y-1.5">
      <label className="text-xs font-medium text-foreground-subtle">
        Hub timezone (managed by NTP)
      </label>
      <TimezoneSelector value="America/New_York" onChange={noop} disabled />
    </div>
  </Frame>
)
